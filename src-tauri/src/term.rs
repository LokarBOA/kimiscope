use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

struct TermEntry {
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send + Sync>,
  #[allow(dead_code)]
  master: Box<dyn MasterPty + Send>,
}

static TERMS: OnceLock<Mutex<HashMap<u64, TermEntry>>> = OnceLock::new()
  ;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn terms() -> &'static Mutex<HashMap<u64, TermEntry>> {
  TERMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn find_shell() -> String {
  // Git Bash when present (matches the user's CLI environment), else cmd.
  for candidate in [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
  ] {
    if std::path::Path::new(candidate).exists() {
      return candidate.to_string();
    }
  }
  "cmd.exe".to_string()
}

#[tauri::command]
pub fn term_spawn(app: AppHandle, cwd: Option<String>, cols: u16, rows: u16) -> Result<u64, String> {
  let pair = native_pty_system()
    .openpty(PtySize {
      rows: rows.max(2),
      cols: cols.max(2),
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|e| format!("openpty failed: {e}"))?;

  let mut cmd = CommandBuilder::new(find_shell());
  if let Some(dir) = cwd {
    cmd.cwd(dir);
  }
  let child = pair
    .slave
    .spawn_command(cmd)
    .map_err(|e| format!("spawn failed: {e}"))?;

  let mut reader = pair
    .master
    .try_clone_reader()
    .map_err(|e| format!("reader clone failed: {e}"))?;
  let writer = pair
    .master
    .take_writer()
    .map_err(|e| format!("take_writer failed: {e}"))?;

  let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let event = format!("term://{id}");

  let app2 = app.clone();
  let event2 = event.clone();
  std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => {
          let _ = app2.emit(&event2, String::from_utf8_lossy(&buf[..n]).to_string());
        }
        Err(_) => break,
      }
    }
    let _ = app2.emit(&event2, "\r\n\x1b[90m[process exited]\x1b[0m\r\n".to_string());
  });

  terms().lock().unwrap().insert(
    id,
    TermEntry {
      writer,
      child,
      master: pair.master,
    },
  );
  Ok(id)
}

#[tauri::command]
pub fn term_write(id: u64, data: String) -> Result<(), String> {
  let mut map = terms().lock().unwrap();
  let entry = map.get_mut(&id).ok_or("unknown terminal")?;
  entry
    .writer
    .write_all(data.as_bytes())
    .and_then(|()| entry.writer.flush())
    .map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
pub fn term_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
  let map = terms().lock().unwrap();
  let entry = map.get(&id).ok_or("unknown terminal")?;
  entry
    .master
    .resize(PtySize {
      rows: rows.max(2),
      cols: cols.max(2),
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|e| format!("resize failed: {e}"))
}

#[tauri::command]
pub fn term_kill(id: u64) -> Result<(), String> {
  let mut map = terms().lock().unwrap();
  if let Some(mut entry) = map.remove(&id) {
    let _ = entry.child.kill();
  }
  Ok(())
}
