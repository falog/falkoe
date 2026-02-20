use crate::commands::audio::{
    ensure_sentence_audio_cached,
    fetch_audio_base64,
    read_bundled_resource_base64,
};
use crate::commands::linking::render_linking;
use crate::commands::recordings::{
    ensure_wav_pcm16, get_uploaded_audio_info, import_uploaded_audio_from_path, list_recordings,
    move_recorded_audio, save_uploaded_audio,
};
use crate::commands::cutter::{
    cutter_cancel_detect, cutter_export_segments, cutter_get_word_timestamps, cutter_preview_segment,
    cutter_resegment_from_words, cutter_suggest_segments, cutter_suggest_segments_raw,
    cutter_suggest_word_segments,
    save_cutter_audio,
};
use crate::commands::sentences::{
    find_audio_by_sentence,
    list_sentence_history,
    set_sentence_task,
    upsert_sentence_manifest_attribution,
    upsert_sentence_manifest_text,
};
use crate::commands::status::{get_model_status, get_model_variant, set_model_variant};
use crate::commands::logs::{get_backend_log_dir, get_backend_log_path};
use crate::commands::temp_recordings::{delete_temp_recording, list_temp_recordings};
use crate::commands::whisper::run_whisper;
use crate::commands::whisper::{run_whisper_model, run_whisper_uploaded};

#[cfg(feature = "mic-recorder")]
use tauri_plugin_mic_recorder::init as mic_recorder;

mod commands;
mod model;
mod logging;
mod storage;

#[cfg(target_os = "android")]
mod android_jni {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};

    use jni::sys::{jint, JavaVM, JNI_VERSION_1_6};

    static JAVA_VM: AtomicPtr<JavaVM> = AtomicPtr::new(std::ptr::null_mut());

    #[no_mangle]
    pub unsafe extern "system" fn JNI_OnLoad(vm: *mut JavaVM, _reserved: *mut c_void) -> jint {
        JAVA_VM.store(vm, Ordering::SeqCst);
        JNI_VERSION_1_6
    }

    pub fn java_vm() -> Result<jni::JavaVM, String> {
        let ptr = JAVA_VM.load(Ordering::SeqCst);
        if ptr.is_null() {
            return Err("JNI: JavaVM is not initialized (JNI_OnLoad not called yet)".into());
        }

        unsafe { jni::JavaVM::from_raw(ptr).map_err(|e| format!("JavaVM::from_raw: {e}")) }
    }
}

// Minimal public surface for internal tooling (e.g. src/bin/*).
pub use commands::whisper::transcribe as transcribe;
pub use commands::pitch::analyze_pitch_noapp as analyze_pitch_noapp;
pub use model::find_existing_model_path_noapp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            model::init_model_state();

            // Initialize file-backed logging early (also captures ggml/whisper GPU logs).
            crate::logging::init(&app.handle());

            // Log any uncaught panics to backend.log.
            // Note: this does not catch aborts/segfaults (native crashes), but helps when a panic
            // would otherwise terminate the process without a clear trace.
            let panic_handle = app.handle().clone();
            std::panic::set_hook(Box::new(move |info| {
                let location = info
                    .location()
                    .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                    .unwrap_or_else(|| "<unknown>".to_string());
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".to_string());

                crate::logging::log_line(&panic_handle, format!("[panic] at {location}: {payload}"));
            }));

            #[cfg(feature = "whisper")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let _ = model::ensure_model(&handle);
                });
            }

            // CMUdictも初回だけ重いので、バックグラウンドでウォームアップ
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = crate::commands::linking::warmup_cmudict(&handle);
            });

            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(feature = "mic-recorder")]
    let builder = builder.plugin(mic_recorder());

    builder.invoke_handler(tauri::generate_handler![
            get_backend_log_path,
            get_backend_log_dir,
            run_whisper,
            run_whisper_model,
            run_whisper_uploaded,
            save_cutter_audio,
            cutter_suggest_segments,
            cutter_suggest_segments_raw,
            cutter_suggest_word_segments,
            cutter_get_word_timestamps,
            cutter_resegment_from_words,
            cutter_cancel_detect,
            cutter_preview_segment,
            cutter_export_segments,
            crate::commands::pitch::analyze_pitch,
            crate::commands::video::export_practice_video,
            list_recordings,
            get_model_status,
            get_model_variant,
            set_model_variant,
            move_recorded_audio,
            ensure_wav_pcm16,
            list_temp_recordings,
            delete_temp_recording,
            save_uploaded_audio,
            import_uploaded_audio_from_path,
            get_uploaded_audio_info,
            fetch_audio_base64,
            ensure_sentence_audio_cached,
            read_bundled_resource_base64,
            find_audio_by_sentence,
            upsert_sentence_manifest_attribution,
            upsert_sentence_manifest_text,
            set_sentence_task,
            list_sentence_history,
            render_linking,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
