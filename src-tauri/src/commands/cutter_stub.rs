use crate::commands::whisper::Segment;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedCutterAudio {
    pub id: String,
    pub path: String,
    pub original_filename: String,
}

fn disabled_message() -> String {
    "cutter is disabled in this build (whisper disabled)".to_string()
}

#[tauri::command]
pub fn cutter_resegment_from_words(
    _app: AppHandle,
    _cutter_id: String,
    _lang: String,
    _lines: Vec<String>,
) -> Result<Vec<Segment>, String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn save_cutter_audio(
    _app: AppHandle,
    _file_data: Vec<u8>,
    _original_filename: String,
) -> Result<SavedCutterAudio, String> {
    Err(disabled_message())
}

#[tauri::command]
pub async fn cutter_suggest_segments(
    _app: AppHandle,
    _cutter_id: String,
    _input_path: String,
    _lang: String,
) -> Result<Vec<Segment>, String> {
    Err(disabled_message())
}

#[tauri::command]
pub async fn cutter_suggest_word_segments(
    _app: AppHandle,
    _cutter_id: String,
    _input_path: String,
    _lang: String,
) -> Result<Vec<Segment>, String> {
    Err(disabled_message())
}

#[tauri::command]
pub async fn cutter_suggest_segments_raw(
    _app: AppHandle,
    _cutter_id: String,
    _input_path: String,
    _lang: String,
) -> Result<Vec<Segment>, String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn cutter_get_word_timestamps(
    _app: AppHandle,
    _cutter_id: String,
) -> Result<Vec<crate::commands::whisper::WordTimestamp>, String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn cutter_cancel_detect(_cutter_id: String) -> Result<(), String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn cutter_preview_segment(
    _app: AppHandle,
    _cutter_id: String,
    _input_path: String,
    _segment_index: u32,
    _segment: Segment,
    _margin_before: f32,
    _margin_after: f32,
    _silence_sec: f32,
) -> Result<String, String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn cutter_export_segments(
    _app: AppHandle,
    _cutter_id: String,
    _input_path: String,
    _segments: Vec<Segment>,
    _margin_before: f32,
    _margin_after: f32,
    _silence_sec: f32,
) -> Result<Vec<String>, String> {
    Err(disabled_message())
}
