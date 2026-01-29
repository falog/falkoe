use tauri::AppHandle;

#[tauri::command]
pub fn get_backend_log_path(app: AppHandle) -> Option<String> {
    crate::logging::log_path_string(&app)
}

#[tauri::command]
pub fn get_backend_log_dir(app: AppHandle) -> Option<String> {
    crate::logging::log_path(&app)
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
}
