use anyhow::Result;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub(crate) fn storage_root(app: &AppHandle) -> Result<PathBuf> {
    // On mobile, `document_dir` can be unavailable or require extra OS-level access.
    // Use app-internal storage which is always writable.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(app.path().app_data_dir()?)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(app.path().document_dir()?)
    }
}

pub(crate) fn falkoe_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(storage_root(app)?.join("falkoe"))
}

pub(crate) fn sentences_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(falkoe_root(app)?.join("sentences"))
}

pub(crate) fn sentence_base_dir(app: &AppHandle, sentence_hash: &str) -> Result<PathBuf> {
    Ok(sentences_root(app)?.join(sentence_hash))
}

pub(crate) fn cutter_base_dir(app: &AppHandle, cutter_id: &str) -> Result<PathBuf> {
    Ok(falkoe_root(app)?.join("cutter").join(cutter_id))
}
