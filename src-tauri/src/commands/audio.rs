use base64::Engine;
use reqwest;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn fetch_audio_base64(url: String) -> Result<String, String> {
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn sentences_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe")
        .join("sentences"))
}

#[tauri::command]
pub async fn ensure_sentence_audio_cached(
    app: AppHandle,
    audio_id: String,
    url: String,
) -> Result<String, String> {
    let audio_id = audio_id.trim();
    if audio_id.is_empty() {
        return Err("audio_id is empty".into());
    }
    if url.trim().is_empty() {
        return Err("url is empty".into());
    }

    let dir = sentences_root(&app)?.join(audio_id).join("tatoeba");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Tatoeba audio is typically mp3; keep a stable filename so subsequent calls are O(1).
    let final_path = dir.join("tatoeba.mp3");

    if let Ok(meta) = fs::metadata(&final_path) {
        if meta.len() > 1024 {
            return Ok(final_path.to_string_lossy().to_string());
        }
    }

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("download returned empty body".into());
    }

    let part_path = dir.join("tatoeba.mp3.part");
    fs::write(&part_path, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;

    Ok(final_path.to_string_lossy().to_string())
}
