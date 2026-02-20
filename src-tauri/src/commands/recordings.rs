use chrono::Local;
use serde::Serialize;
use std::fs;
use tauri::AppHandle;

#[tauri::command]
pub fn ensure_wav_pcm16(path: String) -> Result<(), String> {
    use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
    use std::path::{Path, PathBuf};

    let src_path = PathBuf::from(&path);
    if !src_path.exists() {
        return Err(format!("file does not exist: {path}"));
    }

    let mut reader = WavReader::open(&src_path).map_err(|e| e.to_string())?;
    let spec = reader.spec();

    // Already compatible.
    if spec.sample_format == SampleFormat::Int && spec.bits_per_sample == 16 {
        return Ok(());
    }

    let parent: &Path = src_path
        .parent()
        .ok_or_else(|| "invalid wav path (no parent dir)".to_string())?;
    let file_stem = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording.wav");
    let tmp_path = parent.join(format!("{file_stem}.pcm16.tmp"));

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(&tmp_path, out_spec).map_err(|e| e.to_string())?;

    // Convert interleaved samples to i16.
    match spec.sample_format {
        SampleFormat::Float => {
            for s in reader.samples::<f32>() {
                let v = s.map_err(|e| e.to_string())?;
                let scaled = (v * i16::MAX as f32).round();
                let clamped = scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                writer.write_sample(clamped).map_err(|e| e.to_string())?;
            }
        }
        SampleFormat::Int => {
            if spec.bits_per_sample <= 16 {
                for s in reader.samples::<i16>() {
                    let v = s.map_err(|e| e.to_string())?;
                    writer.write_sample(v).map_err(|e| e.to_string())?;
                }
            } else {
                let bits = spec.bits_per_sample.min(32);
                let in_max: f64 = ((1u64 << (bits - 1)) - 1) as f64;
                for s in reader.samples::<i32>() {
                    let v = s.map_err(|e| e.to_string())? as f64;
                    let scaled = (v / in_max) * (i16::MAX as f64);
                    let clamped = scaled
                        .clamp(i16::MIN as f64, i16::MAX as f64)
                        .round() as i16;
                    writer.write_sample(clamped).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;

    // Replace in place.
    fs::rename(&tmp_path, &src_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}

fn sentence_base_dir(app: &AppHandle, sentence_hash: &str) -> Result<std::path::PathBuf, String> {
    crate::storage::sentence_base_dir(app, sentence_hash).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_recordings(app: AppHandle, sentence_hash: String) -> Result<Vec<String>, String> {
    let dir = sentence_base_dir(&app, &sentence_hash)?.join("recorded");

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wav") {
            files.push(path.to_string_lossy().to_string());
        }
    }

    Ok(files)
}

#[tauri::command]
pub fn move_recorded_audio(
    app: AppHandle,
    src_path: String,
    sentence_hash: String,
) -> Result<String, String> {
    let base_dir = sentence_base_dir(&app, &sentence_hash)?.join("recorded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{}.wav", timestamp);
    let dest = base_dir.join(filename);

    // Prefer atomic rename, but Android often fails when moving across storage
    // boundaries (e.g. internal temp -> Documents). Fall back to copy+delete.
    match fs::rename(&src_path, &dest) {
        Ok(()) => {}
        Err(rename_err) => {
            fs::copy(&src_path, &dest).map_err(|e| {
                format!(
                    "failed to move recording (rename: {rename_err}); copy failed: {e}"
                )
            })?;
            // Best-effort cleanup of temp file.
            let _ = fs::remove_file(&src_path);
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_uploaded_audio(
    app: AppHandle,
    file_data: Vec<u8>,
    sentence_hash: String,
    original_filename: String,
    overwrite: bool,
) -> Result<String, String> {
    let base_dir = sentence_base_dir(&app, &sentence_hash)?.join("uploaded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    // 元のファイル名を保存（UIの履歴で判別できるようにする）
    let original_filename_path = base_dir.join("original_filename.txt");
    if let Err(e) = fs::write(&original_filename_path, &original_filename) {
        crate::logging::log_line(
            &app,
            format!(
                "[recordings] failed to write uploaded original filename: {:?}: {}",
                original_filename_path, e
            ),
        );
    }

    // 拡張子を保持
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let filename = format!("uploaded.{}", ext);
    let dest = base_dir.join(&filename);

    if dest.exists() && !overwrite {
        return Err("uploaded audio already exists".into());
    }

    fs::write(&dest, file_data).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_uploaded_audio_from_path(
    app: AppHandle,
    source_path: String,
    sentence_hash: String,
    original_filename: String,
    overwrite: bool,
) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    if !source.exists() {
        return Err(format!("source_path does not exist: {source_path}"));
    }

    let base_dir = sentence_base_dir(&app, &sentence_hash)?.join("uploaded");

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    // 元のファイル名を保存（UIの履歴で判別できるようにする）
    let original_filename_path = base_dir.join("original_filename.txt");
    if let Err(e) = fs::write(&original_filename_path, &original_filename) {
        crate::logging::log_line(
            &app,
            format!(
                "[recordings] failed to write uploaded original filename: {:?}: {}",
                original_filename_path, e
            ),
        );
    }

    // Prefer the original filename extension; fall back to the source path.
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .or_else(|| source.extension().and_then(|e| e.to_str()))
        .unwrap_or("wav");

    let filename = format!("uploaded.{ext}");
    let dest = base_dir.join(&filename);

    if dest.exists() && !overwrite {
        return Err("uploaded audio already exists".into());
    }

    // If already in place, do nothing.
    if source == dest {
        return Ok(dest.to_string_lossy().to_string());
    }

    // Copy (instead of rename) so cutter artifacts remain intact.
    fs::copy(source, &dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct UploadedAudioInfo {
    pub exists: bool,
    pub path: String,
}

#[tauri::command]
pub fn get_uploaded_audio_info(
    app: AppHandle,
    sentence_hash: String,
    original_filename: String,
) -> Result<UploadedAudioInfo, String> {
    let base_dir = sentence_base_dir(&app, &sentence_hash)?.join("uploaded");

    // 拡張子を保持
    let ext = std::path::Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let filename = format!("uploaded.{}", ext);
    let dest = base_dir.join(&filename);

    // 既存アップロードがある場合、元ファイル名が未保存なら補完する
    if dest.exists() {
        let original_filename_path = base_dir.join("original_filename.txt");
        if !original_filename_path.exists() {
            if let Err(e) = fs::write(&original_filename_path, &original_filename) {
                crate::logging::log_line(
                    &app,
                    format!(
                        "[recordings] failed to backfill uploaded original filename: {:?}: {}",
                        original_filename_path, e
                    ),
                );
            }
        }
    }

    Ok(UploadedAudioInfo {
        exists: dest.exists(),
        path: dest.to_string_lossy().to_string(),
    })
}
