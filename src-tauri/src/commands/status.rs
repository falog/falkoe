use crate::model;

#[tauri::command]
pub fn get_model_status() -> String {
    model::get_model_status()
}

#[tauri::command]
pub fn get_model_variant(app: tauri::AppHandle) -> String {
    model::get_model_variant(&app)
}

#[tauri::command]
pub fn set_model_variant(app: tauri::AppHandle, variant: String) -> Result<(), String> {
    model::set_model_variant(&app, &variant).map_err(|e| e.to_string())?;

    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = model::ensure_model(&handle);
    });

    Ok(())
}
