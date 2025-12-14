use std::{fs, path::PathBuf};
use anyhow::Result;
use tauri::{AppHandle,Emitter,Manager};
use std::sync::{Mutex, OnceLock};

static MODEL_STATUS: OnceLock<Mutex<&'static str>> = OnceLock::new();

fn set_status(app: &AppHandle, status: &'static str) -> anyhow::Result<()> {
    let m = MODEL_STATUS.get_or_init(|| Mutex::new("idle"));
    *m.lock().unwrap() = status;
    app.emit("model-status", status)?;
    Ok(())
}


const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

    
pub fn ensure_model(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().unwrap();
    let model_path = dir.join("ggml-base.en.bin");

    if model_path.exists() {
        set_status(app, "ready")?;
        return Ok(model_path);
    }

    set_status(app, "downloading")?;

    fs::create_dir_all(&dir)?;
    let bytes = reqwest::blocking::get(MODEL_URL)?.bytes()?;
    fs::write(&model_path, &bytes)?;

    set_status(app, "ready")?;
    Ok(model_path)
}

#[tauri::command]
pub fn get_model_status() -> String {
    MODEL_STATUS
        .get()
        .map(|m| m.lock().unwrap().to_string())
        .unwrap_or_else(|| "idle".to_string())
}

