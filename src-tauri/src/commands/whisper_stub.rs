#![allow(dead_code)]
#![allow(unused_imports)]

use anyhow::Result;
use std::path::Path;

#[path = "whisper/lang.rs"]
mod lang;
#[path = "whisper/manifest.rs"]
mod manifest;
#[path = "whisper/paths.rs"]
mod paths;
#[path = "whisper/types.rs"]
mod types;

pub use manifest::{SentenceAttribution, SentenceManifest};
pub use types::{
    FinalResult, PartialSegment, PreviewResult, Segment, TokenTimestamp, Transcript, WordTimestamp,
};

pub(crate) use lang::whisper_language;

fn disabled_message() -> String {
    "whisper is disabled in this build".to_string()
}

#[tauri::command]
pub fn run_whisper_model(
    _app: tauri::AppHandle,
    _url: String,
    _sentence_hash: String,
    _lang: String,
) -> Result<(), String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn run_whisper_uploaded(
    _app: tauri::AppHandle,
    _uploaded_path: String,
    _sentence_hash: String,
    _lang: String,
) -> Result<(), String> {
    Err(disabled_message())
}

#[tauri::command]
pub fn run_whisper(
    _app: tauri::AppHandle,
    _path: String,
    _sentence_hash: String,
    _lang: String,
) -> Result<(), String> {
    Err(disabled_message())
}

pub fn transcribe(_wav_path: &str, _model_path: &Path, _whisper_lang: Option<&str>) -> Result<Transcript> {
    anyhow::bail!(disabled_message())
}

pub fn transcribe_preview(
    _app: &tauri::AppHandle,
    _wav_path: &str,
    _sentence_id: u64,
) -> Result<PreviewResult> {
    anyhow::bail!(disabled_message())
}
