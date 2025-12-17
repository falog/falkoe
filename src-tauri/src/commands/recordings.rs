use tauri::{AppHandle, Manager};
use std::fs;
use chrono::Local;


#[tauri::command]
pub fn list_recordings(
    app: AppHandle,
    sentence_id: u32,
) -> Result<Vec<String>, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe")
        .join("recordings")
        .join("tatoeba")
        .join(sentence_id.to_string());


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
    sentence_id: u64,
) -> Result<String, String> {

    let base_dir = app
        .path()
        .document_dir()
        .map_err(|_| "no document dir")?
        .join("falkoe")
        .join("recordings")
        .join("tatoeba")
        .join(sentence_id.to_string());

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{}.wav", timestamp);
    let dest = base_dir.join(filename);

    fs::rename(&src_path, &dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}
