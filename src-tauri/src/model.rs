use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

static MODEL_STATUS: OnceLock<Mutex<String>> = OnceLock::new();

const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

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
    let dir = app.path().app_data_dir().unwrap();
    let model_path = dir.join("ggml-small.bin");
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
                let client = reqwest::blocking::Client::new();
                let remote_len = client
                    .head(MODEL_URL)
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

    let _ = app.emit("model-missing", ());
    set_status(app, "downloading");

    fs::create_dir_all(&dir)?;

    // We're about to (re)download, so invalidate any previous marker.
    let _ = fs::remove_file(&ok_path);

    let mut resp = reqwest::blocking::get(MODEL_URL)?;
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
