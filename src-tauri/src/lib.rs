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

/// True when the server answers `GET /api/v1/healthz` over HTTP. A listening
/// TCP socket is not enough — a cold server accepts connections while its
/// routes are still warming up, and clients must not be handed over yet.
fn http_ready(port: u16) -> bool {
  let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
  let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
    return false;
  };
  let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
  let _ = s.set_write_timeout(Some(Duration::from_millis(400)));
  if std::io::Write::write_all(&mut s, b"GET /api/v1/healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
    .is_err()
  {
    return false;
  }
  let mut buf = [0u8; 64];
  let n = match std::io::Read::read(&mut s, &mut buf) {
    Ok(n) => n,
    Err(_) => return false,
  };
  let head = String::from_utf8_lossy(&buf[..n]);
  head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

fn read_lock_port(home: &PathBuf) -> Option<u16> {
  let raw = fs::read_to_string(home.join("server").join("lock")).ok()?;
  let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
  v.get("port")?.as_u64().map(|p| p as u16)
}

/// One `server/instances/*.json` record (kimi 0.28+; stale files survive hard
/// kills, so advertised ports must be probed before use).
struct InstanceInfo {
  pid: Option<u64>,
  port: Option<u16>,
  started_at_ms: Option<u64>,
}

fn read_instances(home: &PathBuf) -> Vec<InstanceInfo> {
  let mut out = Vec::new();
  if let Ok(dir) = fs::read_dir(home.join("server").join("instances")) {
    for e in dir.flatten() {
      let raw = fs::read_to_string(e.path()).ok();
      let v = raw.and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok());
      if let Some(v) = v {
        out.push(InstanceInfo {
          pid: v.get("pid").and_then(|p| p.as_u64()),
          port: v.get("port").and_then(|p| p.as_u64()).map(|p| p as u16),
          started_at_ms: v.get("started_at").and_then(|s| s.as_u64()),
        });
      }
    }
  }
  out.sort_by_key(|i| std::cmp::Reverse(i.started_at_ms.unwrap_or(0)));
  out
}

/// Port of a live server, if one answers: 0.28 instance files (newest first,
/// ports probed), then the 0.27 lock, then the default.
fn discover_alive_port(home: &PathBuf) -> Option<u16> {
  for i in read_instances(home) {
    if let Some(port) = i.port {
      if http_ready(port) {
        return Some(port);
      }
    }
  }
  if let Some(port) = read_lock_port(home) {
    if http_ready(port) {
      return Some(port);
    }
  }
  if http_ready(DEFAULT_PORT) {
    return Some(DEFAULT_PORT);
  }
  None
}

/// Spawn `kimi web` hidden and return immediately. On 0.27 it daemonizes and
/// exits; on 0.28+ the child IS the foreground server — either way the server
/// outlives both this spawn and the app itself.
fn spawn_web(port: u16) -> Result<(), String> {
  let mut cmd = Command::new("cmd");
  cmd
    .args(["/c", "kimi", "web", "--no-open", "--port", &port.to_string()])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd
    .spawn()
    .map_err(|e| format!("failed to launch `kimi web`: {e}"))?;
  Ok(())
}

fn wait_alive(home: &PathBuf, timeout: Duration) -> Option<u16> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    if let Some(port) = discover_alive_port(home) {
      return Some(port);
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  None
}

#[tauri::command]
fn get_connection_info() -> Result<ConnectionInfo, String> {
  let home = kimi_home();
  let (port, spawned) = match discover_alive_port(&home) {
    Some(p) => (p, false),
    None => {
      spawn_web(read_lock_port(&home).unwrap_or(DEFAULT_PORT))?;
      let p = wait_alive(&home, Duration::from_secs(15))
        .ok_or_else(|| "kimi web did not become healthy within 15s".to_string())?;
      (p, true)
    }
  };
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

/// mcp.json mtime vs daemon start — the daemon only reads mcp.json at startup,
/// so a newer mtime means a restart is required. Start time comes from the
/// newest 0.28 instance file (ms) or the 0.27 lock (ISO string).
#[tauri::command]
fn get_mcp_meta() -> Result<McpMeta, String> {
  let home = kimi_home();
  let mcp_json_mtime_ms = fs::metadata(home.join("mcp.json"))
    .ok()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64);
  let instance_started = read_instances(&home).into_iter().filter_map(|i| i.started_at_ms).max();
  let daemon_started_ms = instance_started.or_else(|| {
    fs::read_to_string(home.join("server").join("lock"))
      .ok()
      .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
      .and_then(|v| v.get("started_at").and_then(|s| s.as_str()).and_then(iso_ms))
  });
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
/// the frontend must confirm with the user first. 0.28+ has no kill
/// subcommand, so instance pids are killed directly; `kimi server kill` is the
/// fallback for pre-0.28 servers.
#[tauri::command]
fn restart_daemon() -> Result<(), String> {
  let home = kimi_home();
  let pids: Vec<u64> = read_instances(&home).into_iter().filter_map(|i| i.pid).collect();
  if !pids.is_empty() {
    for pid in pids {
      kill_pid(pid);
    }
  } else {
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
  }
  std::thread::sleep(Duration::from_millis(800));
  spawn_web(read_lock_port(&home).unwrap_or(DEFAULT_PORT))?;
  wait_alive(&home, Duration::from_secs(15))
    .ok_or_else(|| "kimi web did not become healthy within 15s".to_string())?;
  Ok(())
}

fn kill_pid(pid: u64) {
  #[cfg(windows)]
  {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/F"]);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.status();
  }
  #[cfg(not(windows))]
  {
    let _ = Command::new("kill").arg(pid.to_string()).status();
  }
}

/// Open a local file with the OS default handler (used by image filename
/// links). The path goes as an argv element — never through a shell — so
/// metacharacters in it can't be interpreted.
#[tauri::command]
fn open_path(path: &str) -> Result<(), String> {
  #[cfg(windows)]
  let mut cmd = Command::new("explorer");
  #[cfg(target_os = "macos")]
  let mut cmd = Command::new("open");
  #[cfg(all(unix, not(target_os = "macos")))]
  let mut cmd = Command::new("xdg-open");
  cmd.arg(path);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  // explorer.exe reports odd exit codes even on success; spawning is enough.
  cmd.spawn().map_err(|e| format!("failed to open {path}: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_lock_started_at() {
    // 1970-01-01T00:00:00.000Z is epoch 0; one lock-shaped timestamp otherwise.
    assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
    assert_eq!(iso_ms("2026-07-19T03:52:48.066Z"), Some(1784433168066));
    assert_eq!(iso_ms("garbage"), None);
    assert_eq!(iso_ms("2026-07"), None);
  }

  fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kimiscope-test-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("server").join("instances")).unwrap();
    dir
  }

  #[test]
  fn instances_sorted_newest_first() {
    let home = temp_home("inst");
    fs::write(home.join("server/instances/a.json"), r#"{"pid":1,"port":1111,"started_at":100}"#)
      .unwrap();
    fs::write(home.join("server/instances/b.json"), r#"{"pid":2,"port":2222,"started_at":200}"#)
      .unwrap();
    let inst = read_instances(&home);
    assert_eq!(inst.len(), 2);
    assert_eq!(inst[0].port, Some(2222));
    assert_eq!(inst[1].port, Some(1111));
    let _ = fs::remove_dir_all(&home);
  }

  #[test]
  fn lock_port_parsed() {
    let home = temp_home("lock");
    fs::write(
      home.join("server/lock"),
      r#"{"port":58627,"started_at":"2026-07-19T03:52:48.066Z"}"#,
    )
    .unwrap();
    assert_eq!(read_lock_port(&home), Some(58627));
    let _ = fs::remove_dir_all(&home);
  }

  #[test]
  fn missing_files_yield_no_instances() {
    let home = temp_home("empty");
    assert!(read_instances(&home).is_empty());
    assert_eq!(read_lock_port(&home), None);
    let _ = fs::remove_dir_all(&home);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
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
      open_path,
      term::term_spawn,
      term::term_write,
      term::term_resize,
      term::term_kill
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
