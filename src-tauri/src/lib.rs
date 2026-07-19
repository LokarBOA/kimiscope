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
