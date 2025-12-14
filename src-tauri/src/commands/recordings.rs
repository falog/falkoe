use tauri::{AppHandle, Manager};
use std::fs;
use std::path::PathBuf;


#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe/recordings");

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
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
) -> Result<String, String> {
    let src = PathBuf::from(&src_path);

    if !src.exists() {
        return Err("source file does not exist".into());
    }

    let dest_dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe/recordings");

    fs::create_dir_all(&dest_dir)
        .map_err(|e| e.to_string())?;

    let file_name = src
        .file_name()
        .ok_or("invalid file name")?;

    let dest = dest_dir.join(file_name);

    if let Err(err) = fs::rename(&src, &dest) {
        println!("rename failed: {}", err);

        fs::copy(&src, &dest)
            .map_err(|e| e.to_string())?;
        fs::remove_file(&src)
            .map_err(|e| e.to_string())?;
    }

    Ok(dest.to_string_lossy().to_string())
}

