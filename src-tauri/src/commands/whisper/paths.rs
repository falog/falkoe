use anyhow::Result;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub(crate) fn sentence_base_dir(app: &AppHandle, sentence_hash: &str) -> Result<PathBuf> {
    Ok(crate::storage::sentence_base_dir(app, sentence_hash)?)
}

pub(crate) fn sentence_audio_dir(app: &AppHandle, sentence_hash: &str, subdir: &str) -> Result<PathBuf> {
    let base_dir = sentence_base_dir(app, sentence_hash)?;
    Ok(base_dir.join(subdir))
}
