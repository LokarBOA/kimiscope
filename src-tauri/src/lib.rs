use serde::Serialize;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod term;

const DEFAULT_PORT: u16 = 58627;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
  base_url: String,
  ws_url: String,
  token: String,
  port: u16,
  spawned: bool,
}

fn kimi_home() -> PathBuf {
  if let Ok(h) = std::env::var("KIMI_CODE_HOME") {
    if !h.is_empty() {
      return PathBuf::from(h);
    }
  }
  let home = std::env::var("USERPROFILE")
    .or_else(|_| std::env::var("HOME"))
    .unwrap_or_default();
  PathBuf::from(home).join(".kimi-code")
}

fn tcp_alive(port: u16) -> bool {
  let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
  TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn read_lock_port(home: &PathBuf) -> Option<u16> {
  let raw = fs::read_to_string(home.join("server").join("lock")).ok()?;
  let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
  v.get("port")?.as_u64().map(|p| p as u16)
}

fn ensure_server(port: u16) -> Result<bool, String> {
  if tcp_alive(port) {
    return Ok(false);
  }
  // `kimi server run` spawns/reuses a background daemon and exits once healthy.
  // The npm shim is a .cmd, so it must go through cmd.exe; CREATE_NO_WINDOW
  // keeps a console from flashing when launched from the GUI.
  let mut cmd = Command::new("cmd");
  cmd
    .args(["/c", "kimi", "server", "run", "--port", &port.to_string()])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  let status = cmd
    .status()
    .map_err(|e| format!("failed to launch `kimi server run`: {e}"))?;
  if !status.success() {
    return Err(format!("`kimi server run` exited with {status}"));
  }
  let deadline = Instant::now() + Duration::from_secs(15);
  while Instant::now() < deadline {
    if tcp_alive(port) {
      return Ok(true);
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  Err("kimi server did not become healthy within 15s".to_string())
}

#[tauri::command]
fn get_connection_info() -> Result<ConnectionInfo, String> {
  let home = kimi_home();
  let port = read_lock_port(&home).unwrap_or(DEFAULT_PORT);
  let spawned = ensure_server(port)?;
  let token = fs::read_to_string(home.join("server.token"))
    .map(|t| t.trim().to_string())
    .map_err(|e| format!("could not read {}: {e}", home.join("server.token").display()))?;
  if token.is_empty() {
    return Err("server.token is empty; is the kimi server installed?".to_string());
  }
  Ok(ConnectionInfo {
    base_url: format!("http://127.0.0.1:{port}"),
    ws_url: format!("ws://127.0.0.1:{port}/api/v1/ws"),
    token,
    port,
    spawned,
  })
}

#[tauri::command]
fn get_mcp_servers() -> Result<serde_json::Value, String> {
  let path = kimi_home().join("mcp.json");
  let raw = fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
  serde_json::from_str(&raw).map_err(|e| format!("invalid mcp.json: {e}"))
}

/// Parse the daemon lock's `started_at` (fixed ISO-8601 UTC shape) to unix ms.
fn iso_ms(s: &str) -> Option<u64> {
  // "2026-07-19T03:52:48.066Z"
  let y: u64 = s.get(0..4)?.parse().ok()?;
  let mo: u64 = s.get(5..7)?.parse().ok()?;
  let d: u64 = s.get(8..10)?.parse().ok()?;
  let h: u64 = s.get(11..13)?.parse().ok()?;
  let mi: u64 = s.get(14..16)?.parse().ok()?;
  let sec: u64 = s.get(17..19)?.parse().ok()?;
  let ms: u64 = s.get(20..23).and_then(|f| f.parse().ok()).unwrap_or(0);
  // days-from-civil (Howard Hinnant's algorithm)
  let y_adj = if mo <= 2 { y.checked_sub(1)? } else { y };
  let era = y_adj / 400;
  let yoe = y_adj - era * 400;
  let mp = (mo + 9) % 12;
  let doy = (153 * mp + 2) / 5 + d.checked_sub(1)?;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  let days = era * 146097 + doe - 719468;
  Some(((days * 24 + h) * 3600 + mi * 60 + sec) * 1000 + ms)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpMeta {
  mcp_json_mtime_ms: Option<u64>,
  daemon_started_ms: Option<u64>,
  stale: bool,
}

/// mcp.json mtime vs daemon start (lock `started_at`) — the daemon only reads
/// mcp.json at startup, so a newer mtime means a restart is required.
#[tauri::command]
fn get_mcp_meta() -> Result<McpMeta, String> {
  let home = kimi_home();
  let mcp_json_mtime_ms = fs::metadata(home.join("mcp.json"))
    .ok()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64);
  let daemon_started_ms = fs::read_to_string(home.join("server").join("lock"))
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.get("started_at").and_then(|s| s.as_str()).and_then(iso_ms));
  Ok(McpMeta {
    mcp_json_mtime_ms,
    daemon_started_ms,
    stale: matches!((mcp_json_mtime_ms, daemon_started_ms), (Some(a), Some(b)) if a > b),
  })
}

/// Enable/disable one MCP server in mcp.json. The daemon picks it up on restart.
#[tauri::command]
fn set_mcp_enabled(name: &str, enabled: bool) -> Result<(), String> {
  let path = kimi_home().join("mcp.json");
  let raw = fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
  let mut j: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("invalid mcp.json: {e}"))?;
  let server = j
    .get_mut("mcpServers")
    .and_then(|s| s.get_mut(name))
    .ok_or_else(|| format!("no such server: {name}"))?;
  server["enabled"] = serde_json::Value::Bool(enabled);
  let pretty = serde_json::to_string_pretty(&j).map_err(|e| e.to_string())?;
  fs::write(&path, pretty + "\n").map_err(|e| format!("write failed: {e}"))
}

/// Restart the daemon so MCP config changes take effect. Active turns die —
/// the frontend must confirm with the user first.
#[tauri::command]
fn restart_daemon() -> Result<(), String> {
  let mut kill = Command::new("cmd");
  kill
    .args(["/c", "kimi", "server", "kill"])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    kill.creation_flags(CREATE_NO_WINDOW);
  }
  let _ = kill.status(); // fine if it was already down
  std::thread::sleep(Duration::from_millis(800));
  ensure_server(read_lock_port(&kimi_home()).unwrap_or(DEFAULT_PORT))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::iso_ms;

  #[test]
  fn parses_lock_started_at() {
    // 1970-01-01T00:00:00.000Z is epoch 0; one lock-shaped timestamp otherwise.
    assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
    assert_eq!(iso_ms("2026-07-19T03:52:48.066Z"), Some(1784433168066));
    assert_eq!(iso_ms("garbage"), None);
    assert_eq!(iso_ms("2026-07"), None);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_connection_info,
      get_mcp_servers,
      get_mcp_meta,
      set_mcp_enabled,
      restart_daemon,
      term::term_spawn,
      term::term_write,
      term::term_resize,
      term::term_kill
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
