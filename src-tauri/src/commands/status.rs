use crate::model;

#[tauri::command]
pub fn get_model_status() -> String {
    model::get_model_status()
}
