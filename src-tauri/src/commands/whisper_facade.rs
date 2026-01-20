#![allow(dead_code)]
#![allow(unused_imports)]

#[path = "whisper/audio.rs"]
mod audio;
#[path = "whisper/ffmpeg.rs"]
mod ffmpeg;
#[path = "whisper/lang.rs"]
mod lang;
#[path = "whisper/manifest.rs"]
mod manifest;
#[path = "whisper/mecab.rs"]
mod mecab;
#[path = "whisper/paths.rs"]
mod paths;
#[path = "whisper/run.rs"]
mod run_impl;
#[path = "whisper/transcribe.rs"]
mod transcribe_impl;
#[path = "whisper/transcript.rs"]
mod transcript;
#[path = "whisper/types.rs"]
mod types;

pub use audio::load_wav_as_f32;
pub use manifest::SentenceAttribution;
pub use manifest::SentenceManifest;
pub use transcribe_impl::{transcribe, transcribe_preview};
pub use types::{
    FinalResult, PartialSegment, PreviewResult, Segment, TokenTimestamp, Transcript, WordTimestamp,
};

#[tauri::command]
pub fn run_whisper_model(
    app: tauri::AppHandle,
    url: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    run_impl::run_whisper_model_impl(app, url, sentence_hash, lang)
}

#[tauri::command]
pub fn run_whisper_uploaded(
    app: tauri::AppHandle,
    uploaded_path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    run_impl::run_whisper_uploaded_impl(app, uploaded_path, sentence_hash, lang)
}

#[tauri::command]
pub fn run_whisper(
    app: tauri::AppHandle,
    path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    run_impl::run_whisper_impl(app, path, sentence_hash, lang)
}
