use crate::commands::whisper::run_whisper;
use crate::commands::recordings::{get_uploaded_audio_info, list_recordings, move_recorded_audio, save_uploaded_audio};
use crate::commands::status::get_model_status;
use crate::commands::audio::fetch_audio_base64;
use crate::commands::whisper::{run_whisper_model, run_whisper_uploaded};
use crate::commands::sentences::{find_audio_by_sentence, upsert_sentence_manifest_text};
use tauri_plugin_mic_recorder::init as mic_recorder;

mod model;
mod commands;


pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            model::init_model_state();

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = model::ensure_model(&handle);
            });

            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(mic_recorder())
        .invoke_handler(tauri::generate_handler![
            run_whisper,
            run_whisper_model,
            run_whisper_uploaded,
            list_recordings,
            get_model_status,
            move_recorded_audio,
            save_uploaded_audio,
            get_uploaded_audio_info,
            fetch_audio_base64,
            find_audio_by_sentence,
            upsert_sentence_manifest_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
