use std::path::Path;

#[tauri::command]
pub fn delete_temp_recording(src_path: String) -> Result<(), String> {
  // Safety: only allow deleting within the app data directory.
  // The mic recorder plugin stores temp wav under app_data_dir/tauri-plugin-mic-recorder.
  // We still guard against path traversal / arbitrary deletes.
  let src = Path::new(&src_path);
  let canonical = src
    .canonicalize()
    .map_err(|e| format!("failed to canonicalize src_path: {e}"))?;

  // Only allow deleting files (not directories).
  let metadata = std::fs::metadata(&canonical)
    .map_err(|e| format!("failed to stat temp recording: {e}"))?;
  if !metadata.is_file() {
    return Err("temp recording path is not a file".to_string());
  }

  // NOTE: We can't easily get app_data_dir here without tauri::AppHandle.
  // Instead, we enforce a narrow allowlist path segment.
  // This matches the plugin default folder name.
  let canonical_str = canonical.to_string_lossy();
  if !canonical_str.contains("/tauri-plugin-mic-recorder/") {
    return Err("refusing to delete non-temp recording path".to_string());
  }

  std::fs::remove_file(&canonical)
    .map_err(|e| format!("failed to delete temp recording: {e}"))?;
  Ok(())
}
