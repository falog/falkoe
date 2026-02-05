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

    // 元のファイル名を保存（UIの履歴で判別できるようにする）
    let original_filename_path = base_dir.join("original_filename.txt");
    if let Err(e) = fs::write(&original_filename_path, &original_filename) {
        crate::logging::log_line(
            &app,
            format!(
                "[recordings] failed to write uploaded original filename: {:?}: {}",
                original_filename_path, e
            ),
        );
    }

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

#[tauri::command]
pub fn import_uploaded_audio_from_path(
    app: AppHandle,
    source_path: String,
    sentence_hash: String,
    original_filename: String,
    overwrite: bool,
) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    if !source.exists() {
        return Err(format!("source_path does not exist: {source_path}"));
    }

    let base_dir = app
        .path()
        .document_dir()
        .map_err(|_| "no document dir")?
        .join("falkoe")
        .join("sentences")
        .join(&sentence_hash)
        .join("uploaded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    // 元のファイル名を保存（UIの履歴で判別できるようにする）
    let original_filename_path = base_dir.join("original_filename.txt");
    if let Err(e) = fs::write(&original_filename_path, &original_filename) {
        crate::logging::log_line(
            &app,
            format!(
                "[recordings] failed to write uploaded original filename: {:?}: {}",
                original_filename_path, e
            ),
        );
    }

    // Prefer the original filename extension; fall back to the source path.
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .or_else(|| source.extension().and_then(|e| e.to_str()))
        .unwrap_or("wav");

    let filename = format!("uploaded.{ext}");
    let dest = base_dir.join(&filename);

    if dest.exists() && !overwrite {
        return Err("uploaded audio already exists".into());
    }

    // If already in place, do nothing.
    if source == dest {
        return Ok(dest.to_string_lossy().to_string());
    }

    // Copy (instead of rename) so cutter artifacts remain intact.
    fs::copy(source, &dest).map_err(|e| e.to_string())?;

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

    // 既存アップロードがある場合、元ファイル名が未保存なら補完する
    if dest.exists() {
        let original_filename_path = base_dir.join("original_filename.txt");
        if !original_filename_path.exists() {
            if let Err(e) = fs::write(&original_filename_path, &original_filename) {
                crate::logging::log_line(
                    &app,
                    format!(
                        "[recordings] failed to backfill uploaded original filename: {:?}: {}",
                        original_filename_path, e
                    ),
                );
            }
        }
    }

    Ok(UploadedAudioInfo {
        exists: dest.exists(),
        path: dest.to_string_lossy().to_string(),
    })
}
