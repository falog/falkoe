use crate::commands::whisper::run_whisper;
use crate::commands::recordings::{list_recordings, move_recorded_audio};
use crate::commands::status::get_model_status;
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
            list_recordings,
            get_model_status,
            move_recorded_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
