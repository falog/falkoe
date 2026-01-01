use chrono::Local;
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn list_recordings(app: AppHandle, sentence_hash: String) -> Result<Vec<String>, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe")
        .join("sentences")
        .join(&sentence_hash)
        .join("recorded");

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wav") {
            files.push(path.to_string_lossy().to_string());
        }
    }

    Ok(files)
}

#[tauri::command]
pub fn move_recorded_audio(
    app: AppHandle,
    src_path: String,
    sentence_hash: String,
) -> Result<String, String> {
    let base_dir = app
        .path()
        .document_dir()
        .map_err(|_| "no document dir")?
        .join("falkoe")
        .join("sentences")
        .join(&sentence_hash)
        .join("recorded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{}.wav", timestamp);
    let dest = base_dir.join(filename);

    fs::rename(&src_path, &dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_uploaded_audio(
    app: AppHandle,
    file_data: Vec<u8>,
    sentence_hash: String,
    original_filename: String,
    overwrite: bool,
) -> Result<String, String> {
    let base_dir = app
        .path()
        .document_dir()
        .map_err(|_| "no document dir")?
        .join("falkoe")
        .join("sentences")
        .join(&sentence_hash)
        .join("uploaded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    // 拡張子を保持
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let filename = format!("uploaded.{}", ext);
    let dest = base_dir.join(&filename);

    if dest.exists() && !overwrite {
        return Err("uploaded audio already exists".into());
    }

    fs::write(&dest, file_data).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct UploadedAudioInfo {
    pub exists: bool,
    pub path: String,
}

#[tauri::command]
pub fn get_uploaded_audio_info(
    app: AppHandle,
    sentence_hash: String,
    original_filename: String,
) -> Result<UploadedAudioInfo, String> {
    let base_dir = app
        .path()
        .document_dir()
        .map_err(|_| "no document dir")?
        .join("falkoe")
        .join("sentences")
        .join(&sentence_hash)
        .join("uploaded");

    // 拡張子を保持
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let filename = format!("uploaded.{}", ext);
    let dest = base_dir.join(&filename);

    Ok(UploadedAudioInfo {
        exists: dest.exists(),
        path: dest.to_string_lossy().to_string(),
    })
}
