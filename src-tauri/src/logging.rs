use std::any::Any;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LOG_PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

fn env_log_dir() -> Option<std::path::PathBuf> {
    std::env::var("FALKOE_LOG_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
}

fn try_use_log_path(path: &std::path::PathBuf) -> bool {
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .is_ok()
}

fn select_log_file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    // Priority:
    // 1) Explicit override (portable/debug)
    // 2) Near bundled resources (best effort; may be read-only under Program Files)
    // 3) Documents (user-writable)
    // 4) app_data_dir (user-writable; default)
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Some(dir) = env_log_dir() {
        candidates.push(dir.join("backend.log"));
        candidates.push(dir.join("logs").join("backend.log"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("logs").join("backend.log"));
    }

    if let Ok(doc_dir) = app.path().document_dir() {
        candidates.push(doc_dir.join("falkoe").join("logs").join("backend.log"));
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("logs").join("backend.log"));
    }

    for p in candidates {
        if try_use_log_path(&p) {
            return Some(p);
        }
    }

    None
}

pub(crate) fn log_line(app: &AppHandle, line: impl AsRef<str>) {
    let Some(path) = LOG_PATH
        .get_or_init(|| select_log_file_path(app))
        .clone()
    else {
        // Best-effort: if we can't resolve app_data_dir, at least emit something.
        eprintln!("[log] {}", line.as_ref());
        return;
    };

    let _guard = LOG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .ok();

    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{ts}] {}", line.as_ref());
    }
}

pub(crate) fn panic_payload_to_string(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

pub(crate) fn truncate_for_log(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            break;
        }
        out.push(ch);
    }
    out.push_str("…");
    out
}
