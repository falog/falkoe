use std::sync::{Mutex, OnceLock};
use std::io::{Read, Write};
use std::fs::{self, File};
use tauri::{AppHandle,Emitter, Manager};
use sha2::{Sha256, Digest};

static MODEL_STATUS: OnceLock<Mutex<String>> = OnceLock::new();

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
    
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

    if model_path.exists() {
        set_status(app, "ready");
        return Ok(model_path);
    }

    let _ = app.emit("model-missing", ());
    set_status(app, "downloading");

    fs::create_dir_all(&dir)?;

    let mut resp = reqwest::blocking::get(MODEL_URL)?;
    let total = resp
        .content_length()
        .unwrap_or(0);

    let mut file = File::create(&model_path)?;
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