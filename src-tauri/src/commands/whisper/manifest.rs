use crate::model::hash_sentence;

use anyhow::Result;
use std::fs;
use tauri::AppHandle;

use super::paths::sentence_base_dir;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SentenceManifest {
    pub audio_id: String,
    pub sentence_id: Option<String>,
    pub lang: String,
    pub text: Option<String>,
    pub last_wav_path: Option<String>,
}

pub(crate) fn save_sentence_manifest_json(
    app: &AppHandle,
    sentence_hash: &str,
    lang: &str,
    full_text: &str,
    wav_path: &str,
) -> Result<()> {
    let base_dir = sentence_base_dir(app, sentence_hash)?;
    fs::create_dir_all(&base_dir)?;
    let manifest_path = base_dir.join("manifest.json");

    // Important: do not overwrite manifest.text with recognition results.
    // The UI sets/locks the sentence text via upsert_sentence_manifest_text.
    // Here we only update last_wav_path, and we fill text/sentence_id only if missing.
    let mut manifest: SentenceManifest = if manifest_path.exists() {
        match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SentenceManifest>(&s).ok())
        {
            Some(v) => v,
            None => SentenceManifest {
                audio_id: sentence_hash.to_string(),
                sentence_id: None,
                lang: lang.to_string(),
                text: None,
                last_wav_path: None,
            },
        }
    } else {
        SentenceManifest {
            audio_id: sentence_hash.to_string(),
            sentence_id: None,
            lang: lang.to_string(),
            text: None,
            last_wav_path: None,
        }
    };

    manifest.audio_id = sentence_hash.to_string();
    manifest.lang = lang.to_string();
    manifest.last_wav_path = Some(wav_path.to_string());

    let existing_text_nonempty = manifest
        .text
        .as_deref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    if !existing_text_nonempty {
        let recognized_text = full_text.trim();
        if !recognized_text.is_empty() {
            manifest.text = Some(recognized_text.to_string());
            manifest.sentence_id = Some(hash_sentence(recognized_text, lang));
        }
    }

    if manifest.sentence_id.is_none() {
        if let Some(t) = manifest.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            manifest.sentence_id = Some(hash_sentence(t, lang));
        }
    }

    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&manifest_path, json)?;
    println!("saved manifest: {:?}", manifest_path);
    Ok(())
}
