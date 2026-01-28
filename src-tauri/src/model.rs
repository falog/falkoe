use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

static MODEL_STATUS: OnceLock<Mutex<String>> = OnceLock::new();

const MODEL_VARIANT_FILE: &str = "model-variant.txt";

pub const DEFAULT_MODEL_VARIANT: &str = "small";
pub const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
pub const DEFAULT_MODEL_FILENAME: &str = "ggml-small.bin";

// Legacy identifier-based storage dir name used by older builds.
// (Tauri's app_data_dir historically used the bundle identifier.)
pub const LEGACY_APP_IDENTIFIER: &str = "net.falog.falkoe";

// Preferred on-disk storage dir name.
// This intentionally avoids the reverse-DNS identifier so Linux paths are simpler.
pub const APP_DATA_DIR_NAME: &str = "falkoe";

fn preferred_app_data_dir(app: &AppHandle) -> PathBuf {
    // `dirs::data_local_dir()` maps to:
    // - Windows: %LOCALAPPDATA%
    // - Linux:   ~/.local/share
    // - macOS:   ~/Library/Application Support
    // We keep our app-owned state under a stable, human-friendly folder.
    if let Some(d) = dirs::data_local_dir() {
        return d.join(APP_DATA_DIR_NAME);
    }

    // Fallback: platform-specific Tauri directory.
    app.path().app_data_dir().unwrap()
}

fn legacy_app_data_dir(app: &AppHandle) -> PathBuf {
    // Best effort: if the old identifier-based directory exists, migrate from it.
    // If Tauri fails to resolve, fall back to dirs::data_dir() + identifier.
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join(LEGACY_APP_IDENTIFIER))
}

fn maybe_migrate_legacy_model(app: &AppHandle, preferred_dir: &PathBuf, spec: &ModelSpec) {
    let legacy_dir = legacy_app_data_dir(app);
    if legacy_dir == *preferred_dir {
        return;
    }
    if !legacy_dir.exists() {
        return;
    }

    let _ = fs::create_dir_all(preferred_dir);

    // 1) model-variant.txt
    let legacy_variant = legacy_dir.join(MODEL_VARIANT_FILE);
    let preferred_variant = preferred_dir.join(MODEL_VARIANT_FILE);
    if legacy_variant.is_file() && !preferred_variant.exists() {
        if fs::rename(&legacy_variant, &preferred_variant).is_err() {
            let _ = fs::copy(&legacy_variant, &preferred_variant);
        }
    }

    // 2) model binary + .ok marker (only for the active spec)
    let legacy_model = legacy_dir.join(&spec.filename);
    let preferred_model = preferred_dir.join(&spec.filename);
    let legacy_ok = legacy_model.with_extension("bin.ok");
    let preferred_ok = preferred_model.with_extension("bin.ok");

    if legacy_model.is_file() && !preferred_model.exists() {
        if fs::rename(&legacy_model, &preferred_model).is_err() {
            let _ = fs::copy(&legacy_model, &preferred_model);
        }
    }
    if legacy_ok.is_file() && !preferred_ok.exists() {
        if fs::rename(&legacy_ok, &preferred_ok).is_err() {
            let _ = fs::copy(&legacy_ok, &preferred_ok);
        }
    }
}

#[derive(Clone, Debug)]
struct ModelSpec {
    variant: String,
    url: String,
    filename: String,
}

fn read_saved_model_variant_from_dir(dir: &PathBuf) -> Option<String> {
    let path = dir.join(MODEL_VARIANT_FILE);
    let text = fs::read_to_string(path).ok()?;
    let v = text.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn model_spec_from_env_with_saved_variant(saved_variant: Option<String>) -> ModelSpec {
    let variant = env::var("FALKOE_MODEL_VARIANT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(saved_variant)
        .unwrap_or_else(|| DEFAULT_MODEL_VARIANT.to_string());

    let (default_url, default_filename) = match variant.as_str() {
        "small" => (DEFAULT_MODEL_URL, DEFAULT_MODEL_FILENAME),
        "small-q8_0" | "ggml-small-q8_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin",
            "ggml-small-q8_0.bin",
        ),
        "small-q5_1" | "ggml-small-q5_1.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
            "ggml-small-q5_1.bin",
        ),
        "base" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
            "ggml-base.bin",
        ),
        "base-q8_0" | "ggml-base-q8_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q8_0.bin",
            "ggml-base-q8_0.bin",
        ),
        "base-q5_1" | "ggml-base-q5_1.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
            "ggml-base-q5_1.bin",
        ),
        "tiny" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
            "ggml-tiny.bin",
        ),
        // requested: https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-tiny-q8_0.bin
        // download URL:
        "tiny-q8_0" | "tiny-q8_0.bin" | "ggml-tiny-q8_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q8_0.bin",
            "ggml-tiny-q8_0.bin",
        ),
        "tiny-q5_1" | "ggml-tiny-q5_1.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
            "ggml-tiny-q5_1.bin",
        ),
        "medium" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
            "ggml-medium.bin",
        ),
        "medium-q8_0" | "ggml-medium-q8_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q8_0.bin",
            "ggml-medium-q8_0.bin",
        ),
        "medium-q5_0" | "ggml-medium-q5_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
            "ggml-medium-q5_0.bin",
        ),
        // Prefer v3 for large
        "large" | "large-v3" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
            "ggml-large-v3.bin",
        ),
        "large-v3-q5_0" | "ggml-large-v3-q5_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
            "ggml-large-v3-q5_0.bin",
        ),
        "large-v3-turbo" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
            "ggml-large-v3-turbo.bin",
        ),
        "large-v3-turbo-q5_0" | "ggml-large-v3-turbo-q5_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
            "ggml-large-v3-turbo-q5_0.bin",
        ),
        "large-v3-turbo-q8_0" | "ggml-large-v3-turbo-q8_0.bin" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
            "ggml-large-v3-turbo-q8_0.bin",
        ),
        other => {
            eprintln!(
                "unknown FALKOE_MODEL_VARIANT={:?}; falling back to {}",
                other, DEFAULT_MODEL_VARIANT
            );
            (DEFAULT_MODEL_URL, DEFAULT_MODEL_FILENAME)
        }
    };

    // Optional override: allow custom model URL/filename.
    let url = env::var("FALKOE_MODEL_URL").unwrap_or_else(|_| default_url.to_string());
    let filename = env::var("FALKOE_MODEL_FILENAME").unwrap_or_else(|_| default_filename.to_string());

    ModelSpec { variant, url, filename }
}

pub fn get_model_variant(app: &AppHandle) -> String {
    let preferred_dir = preferred_app_data_dir(app);
    let legacy_dir = legacy_app_data_dir(app);
    env::var("FALKOE_MODEL_VARIANT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| read_saved_model_variant_from_dir(&preferred_dir))
        .or_else(|| read_saved_model_variant_from_dir(&legacy_dir))
        .unwrap_or_else(|| DEFAULT_MODEL_VARIANT.to_string())
}

fn is_supported_variant(v: &str) -> bool {
    matches!(
        v,
        "tiny"
            | "tiny-q8_0"
            | "tiny-q5_1"
            | "base"
            | "base-q8_0"
            | "base-q5_1"
            | "small"
            | "small-q8_0"
            | "small-q5_1"
            | "medium"
            | "medium-q8_0"
            | "medium-q5_0"
            | "large"
            | "large-v3"
            | "large-v3-q5_0"
            | "large-v3-turbo"
            | "large-v3-turbo-q5_0"
            | "large-v3-turbo-q8_0"
    )
}

pub fn set_model_variant(app: &AppHandle, variant: &str) -> anyhow::Result<()> {
    let v = variant.trim();
    if !is_supported_variant(v) {
        anyhow::bail!(
            "unsupported model variant: {v} (use tiny|tiny-q8_0|tiny-q5_1|base|base-q8_0|base-q5_1|small|small-q8_0|small-q5_1|medium|medium-q8_0|medium-q5_0|large-v3|large-v3-q5_0|large-v3-turbo|large-v3-turbo-q5_0|large-v3-turbo-q8_0)"
        );
    }

    let dir = preferred_app_data_dir(app);
    fs::create_dir_all(&dir)?;
    let path = dir.join(MODEL_VARIANT_FILE);
    fs::write(path, format!("{}\n", v))?;
    Ok(())
}

fn ok_marker_matches(spec: &ModelSpec, ok_text: &str) -> bool {
    let mut variant_in_ok: Option<&str> = None;

    for line in ok_text.lines() {
        if let Some(v) = line.strip_prefix("variant=") {
            variant_in_ok = Some(v.trim());
            break;
        }
    }

    match variant_in_ok {
        Some(v) => v == spec.variant,
        None => spec.variant == DEFAULT_MODEL_VARIANT,
    }
}

/// Resolve the on-disk model path without requiring a Tauri `AppHandle`.
///
/// Used by internal tooling binaries (e.g. `src/bin/transcribe_wav.rs`).
pub fn find_existing_model_path_noapp() -> Option<PathBuf> {
    if let Ok(p) = env::var("FALKOE_MODEL_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    let preferred_dir = dirs::data_local_dir()?.join(APP_DATA_DIR_NAME);
    let legacy_dir = dirs::data_dir()?.join(LEGACY_APP_IDENTIFIER);

    // Prefer new location but fall back to the legacy identifier-based dir.
    let saved_variant = read_saved_model_variant_from_dir(&preferred_dir)
        .or_else(|| read_saved_model_variant_from_dir(&legacy_dir));
    let spec = model_spec_from_env_with_saved_variant(saved_variant);

    let preferred_model = preferred_dir.join(&spec.filename);
    if preferred_model.is_file() {
        return Some(preferred_model);
    }

    let legacy_model = legacy_dir.join(&spec.filename);
    legacy_model.is_file().then_some(legacy_model)
}

/// setup() で必ず呼ぶ
pub fn init_model_state() {
    let _ = MODEL_STATUS.set(Mutex::new("idle".to_string()));
}

pub fn set_status(app: &AppHandle, status: &str) {
    if let Some(mutex) = MODEL_STATUS.get() {
        *mutex.lock().unwrap() = status.to_string();
    }
    let _ = app.emit("model-status", status);
}

pub fn get_model_status() -> String {
    MODEL_STATUS
        .get()
        .map(|m| m.lock().unwrap().clone())
        .unwrap_or_else(|| "idle".to_string())
}

pub fn ensure_model(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let dir = preferred_app_data_dir(app);
    let legacy_dir = legacy_app_data_dir(app);
    let saved_variant = read_saved_model_variant_from_dir(&dir)
        .or_else(|| read_saved_model_variant_from_dir(&legacy_dir));
    let spec = model_spec_from_env_with_saved_variant(saved_variant);

    // If coming from an older build, migrate the active spec/model into the new dir.
    maybe_migrate_legacy_model(app, &dir, &spec);

    let model_path = dir.join(&spec.filename);
    let ok_path = model_path.with_extension("bin.ok");

    // A previous download can leave a truncated file. We track successful
    // downloads via a small marker file next to the model.
    if model_path.exists() {
        if !ok_path.exists() {
            let _ = fs::remove_file(&model_path);
        } else {
            let local_len = fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
            if local_len < 10_000_000 {
                let _ = fs::remove_file(&model_path);
                let _ = fs::remove_file(&ok_path);
            } else {
                // If we can get remote size, verify it too.
                let ok_text = fs::read_to_string(&ok_path).unwrap_or_default();
                if !ok_marker_matches(&spec, &ok_text) {
                    let _ = fs::remove_file(&model_path);
                    let _ = fs::remove_file(&ok_path);
                    // continue to download
                } else {
                    let client = reqwest::blocking::Client::new();
                    let remote_len = client
                    .head(&spec.url)
                    .send()
                    .ok()
                    .and_then(|r| r.content_length())
                    .unwrap_or(0);

                    if remote_len == 0 || local_len == remote_len {
                        set_status(app, "ready");
                        return Ok(model_path);
                    }

                    // Remote length known and mismatch => redownload.
                    let _ = fs::remove_file(&model_path);
                    let _ = fs::remove_file(&ok_path);
                }
            }
        }
    }

    let _ = app.emit("model-missing", ());
    set_status(app, "downloading");

    fs::create_dir_all(&dir)?;

    // We're about to (re)download, so invalidate any previous marker.
    let _ = fs::remove_file(&ok_path);

    let mut resp = reqwest::blocking::get(&spec.url)?;
    let total = resp.content_length().unwrap_or(0);

    let tmp_path = model_path.with_extension("bin.part");
    let mut file = File::create(&tmp_path)?;
    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 8192];

    loop {
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }

        file.write_all(&buf[..n])?;
        downloaded += n as u64;

        if total > 0 {
            let percent = (downloaded * 100 / total) as u8;
            let _ = app.emit("model-progress", percent);
        }
    }

    file.flush()?;

    // Replace atomically when possible.
    let _ = fs::remove_file(&model_path);
    fs::rename(&tmp_path, &model_path)?;

    // Mark download as complete.
    let mut ok = File::create(&ok_path)?;
    let local_len = fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
    let _ = writeln!(ok, "variant={}", spec.variant);
    let _ = writeln!(ok, "url={}", spec.url);
    let _ = writeln!(ok, "bytes={}", local_len);
    ok.flush()?;

    let _ = app.emit("model-progress", 100u8);
    set_status(app, "ready");

    println!("ensure_model: return");
    Ok(model_path)
}

/// SHA256ハッシュを生成（text + lang の組み合わせから）
/// アップロード音声の保存時などに使用予定
#[allow(dead_code)]
pub fn hash_sentence(text: &str, lang: &str) -> String {
    let combined = format!("{}:{}", text, lang);
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)
}
