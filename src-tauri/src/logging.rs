use std::any::Any;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;

use std::sync::Once;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LOG_PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
static LOGGER_INIT: Once = Once::new();

const DEFAULT_ROTATE_MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_ROTATE_KEEP_FILES: usize = 10;

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u64>().ok())
}

fn rotate_max_bytes() -> u64 {
    env_u64("FALKOE_LOG_ROTATE_MAX_BYTES").unwrap_or(DEFAULT_ROTATE_MAX_BYTES)
}

fn rotate_keep_files() -> usize {
    env_u64("FALKOE_LOG_ROTATE_KEEP_FILES")
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(DEFAULT_ROTATE_KEEP_FILES)
}

fn rotated_log_path(base: &std::path::Path, ts_millis: u128) -> std::path::PathBuf {
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("backend");
    let ext = base.extension().and_then(|s| s.to_str());

    let name = match ext {
        Some(ext) if !ext.is_empty() => format!("{stem}.{ts_millis}.{ext}"),
        _ => format!("{stem}.{ts_millis}"),
    };
    parent.join(name)
}

fn cleanup_rotated_logs(base: &std::path::Path, keep: usize) {
    if keep == 0 {
        return;
    }
    let Some(parent) = base.parent() else {
        return;
    };
    let Some(stem) = base.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
        return;
    };
    let ext = base.extension().and_then(|s| s.to_str()).map(|s| s.to_string());

    let read_dir = match std::fs::read_dir(parent) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let mut candidates: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path == base {
            continue;
        }
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };

        // Matches: {stem}.{ts}.{ext} (same directory)
        // Example: backend.1730000000000.log
        if let Some(ext) = &ext {
            let prefix = format!("{stem}.");
            let suffix = format!(".{ext}");
            if !(file_name.starts_with(&prefix) && file_name.ends_with(&suffix)) {
                continue;
            }
        } else {
            let prefix = format!("{stem}.");
            if !file_name.starts_with(&prefix) {
                continue;
            }
        }

        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        candidates.push((modified, path));
    }

    // Newest first; delete older beyond keep.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_t, p) in candidates.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

fn maybe_rotate_log_file(path: &std::path::PathBuf, ts_millis: u128) {
    let max_bytes = rotate_max_bytes();
    if max_bytes == 0 {
        return;
    }
    let current_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if current_len < max_bytes {
        return;
    }

    let rotated = rotated_log_path(path, ts_millis);
    if std::fs::rename(path, &rotated).is_ok() {
        cleanup_rotated_logs(path, rotate_keep_files());
    }
}

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
    // 2) Local user data dir (user-writable; Windows: AppData\\Local, Linux: ~/.local/share)
    // 3) app_data_dir (user-writable; platform-specific)
    // 3) Documents (user-writable; but user-facing)
    // 4) Near bundled resources (best effort; may be read-only under Program Files)
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Some(dir) = env_log_dir() {
        candidates.push(dir.join("backend.log"));
        candidates.push(dir.join("logs").join("backend.log"));
    }

    // Prefer a stable, non-user-facing, always-writable location.
    // `dirs::data_local_dir()` maps to:
    // - Windows: %LOCALAPPDATA%
    // - Linux:   ~/.local/share
    // - macOS:   ~/Library/Application Support
    if let Some(local_dir) = dirs::data_local_dir() {
        candidates.push(local_dir.join("falkoe").join("logs").join("backend.log"));
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("logs").join("backend.log"));
    }

    if let Ok(doc_dir) = app.path().document_dir() {
        candidates.push(doc_dir.join("falkoe").join("logs").join("backend.log"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("logs").join("backend.log"));
    }

    for p in candidates {
        if try_use_log_path(&p) {
            return Some(p);
        }
    }

    None
}

pub(crate) fn log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    LOG_PATH
        .get_or_init(|| select_log_file_path(app))
        .clone()
}

pub(crate) fn log_path_string(app: &AppHandle) -> Option<String> {
    log_path(app).map(|p| p.to_string_lossy().to_string())
}

fn env_level_filter() -> log::LevelFilter {
    let s = std::env::var("FALKOE_LOG_LEVEL")
        .ok()
        .unwrap_or_else(|| "info".to_string());
    match s.trim().to_ascii_lowercase().as_str() {
        "off" => log::LevelFilter::Off,
        "error" => log::LevelFilter::Error,
        "warn" | "warning" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    }
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
        .and_then(|v| match v {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

fn log_to_stderr_enabled() -> bool {
    env_bool("FALKOE_LOG_STDERR").unwrap_or(false)
}

fn write_line_to_path(path: &std::path::PathBuf, line: &str) {
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

    maybe_rotate_log_file(path, ts);

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

pub(crate) fn log_raw(line: impl AsRef<str>) {
    let line = line.as_ref();
    if log_to_stderr_enabled() {
        eprintln!("{line}");
    }
    let Some(path) = LOG_PATH.get().and_then(|p| p.clone()) else {
        return;
    };
    write_line_to_path(&path, line);
}

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // Keep it single-line-ish; whisper/ggml often includes trailing newlines.
        let msg = format!("[{}] {}", record.level(), record.args());
        log_raw(msg.trim_end_matches(['\n', '\r']));
    }

    fn flush(&self) {}
}

pub(crate) fn init(app: &AppHandle) {
    // Resolve log path early so even GPU/whisper init logs have a destination.
    let _ = log_path(app);

    LOGGER_INIT.call_once(|| {
        let _ = log::set_boxed_logger(Box::new(FileLogger));
        log::set_max_level(env_level_filter());

        // Route whisper.cpp / ggml logs into the Rust `log` backend.
        // With `log_backend` enabled, this captures Vulkan backend lines like `ggml_vulkan: ...`.
        whisper_rs::install_logging_hooks();
    });

    // Write an explicit marker so we know logging initialized.
    if let Some(p) = log_path_string(app) {
        log_raw(format!("[log] initialized backend.log path={}", p));
    }
}

pub(crate) fn log_line(app: &AppHandle, line: impl AsRef<str>) {
    let Some(path) = log_path(app) else {
        // Best-effort: if we can't resolve app_data_dir, at least emit something.
        eprintln!("[log] {}", line.as_ref());
        return;
    };

    write_line_to_path(&path, line.as_ref());
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
