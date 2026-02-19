use base64::Engine;
use reqwest;
use std::{fs, path::PathBuf};
use tauri::path::BaseDirectory;
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

#[tauri::command]
pub async fn read_bundled_resource_base64(
    app: AppHandle,
    resource_path: String,
) -> Result<String, String> {
    let mut rel = resource_path.trim().trim_start_matches('/').to_string();
    if rel.is_empty() {
        return Err("resource_path is empty".into());
    }
    if let Some(stripped) = rel.strip_prefix("resources/") {
        rel = stripped.to_string();
    }
    if rel.contains("..") {
        return Err("invalid resource_path".into());
    }

    let rel_candidates = [rel.clone(), format!("resources/{rel}")];
    let mut read_errors: Vec<String> = Vec::new();

    for candidate in rel_candidates {
        if let Ok(resolved) = app.path().resolve(&candidate, BaseDirectory::Resource) {
            match fs::read(&resolved) {
                Ok(bytes) => {
                    return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                Err(e) => {
                    read_errors.push(format!(
                        "resolve(Resource) {candidate} -> {} ({})",
                        resolved.display(),
                        e
                    ));
                }
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join(&rel),
            resource_dir.join("resources").join(&rel),
        ];

        for path in candidates {
            match fs::read(&path) {
                Ok(bytes) => {
                    return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                Err(e) => {
                    read_errors.push(format!("resource_dir {} ({})", path.display(), e));
                }
            }
        }
    }

    let detail = if read_errors.is_empty() {
        "no readable candidates".to_string()
    } else {
        read_errors.join(" | ")
    };
    Err(format!("resource not found: {rel} ({detail})"))
}
