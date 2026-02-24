use base64::Engine;
use reqwest;
use std::{fs, path::PathBuf};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Android asset reader via JNI
// ---------------------------------------------------------------------------
//
// On Android, bundled resources live inside the APK's `assets/` directory and
// cannot be accessed through normal filesystem paths.  `app.path().resolve()`
// returns an `asset://localhost/…` URI which `std::fs::read()` cannot handle.
//
// Tauri's plugin-fs *can* read assets via Android's `AssetManager`, but it has
// a bug for **uncompressed** entries: `openFd(path).parcelFileDescriptor
// .detachFd()` discards the offset/length, causing `read_to_end()` to consume
// the entire remainder of the APK — easily exceeding the WebView heap limit.
//
// We bypass both issues by calling our own Kotlin helper (`AssetReader.kt`)
// through JNI, which uses `InputStream.readBytes()` and is always correct.

#[cfg(target_os = "android")]
fn read_android_asset(asset_path: &str) -> Result<Vec<u8>, String> {
    use jni::objects::{JByteArray, JClass, JValue};

    /// Helper: if a Java exception is pending on `env`, clear it and return an
    /// error string.  This guards against rare jni-rs edge-cases where
    /// `ExceptionClear` is not called automatically (e.g. inside `.l()` or
    /// `convert_byte_array`).  Leaving a pending exception would crash the
    /// process on the *next* JNI call from any thread.
    fn clear_any_pending_exception(env: &mut jni::JNIEnv) {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }

    // Get the JavaVM passed to JNI_OnLoad when this library was loaded.
    // This avoids referencing JNI_GetCreatedJavaVMs (not available on Android).
    let vm = crate::android_jni::java_vm()?;

    // Use attach_current_thread_permanently so we never accidentally detach a
    // thread that wry / Tauri is also managing.
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // Wrap the entire JNI interaction so we can guarantee exception-clear on error.
    let result = (|| -> Result<Vec<u8>, String> {
        // ActivityThread.currentApplication() → Application (Context)
        let activity_thread = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("find ActivityThread: {e}"))?;
        let app = env
            .call_static_method(
                activity_thread,
                "currentApplication",
                "()Landroid/app/Application;",
                &[],
            )
            .map_err(|e| format!("currentApplication: {e}"))?
            .l()
            .map_err(|e| format!("currentApplication .l(): {e}"))?;

        if app.is_null() {
            return Err("currentApplication() returned null".into());
        }

        let j_path = env
            .new_string(asset_path)
            .map_err(|e| format!("new_string: {e}"))?;

        // On natively-attached threads (e.g. tokio workers), JNI FindClass uses the
        // system classloader which cannot see app classes like AssetReader.
        // Use the app context's ClassLoader.loadClass() instead.
        let class_loader = env
            .call_method(&app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?
            .l()
            .map_err(|e| format!("getClassLoader .l(): {e}"))?;
        let reader_class_name = env
            .new_string("com.fal.falkoe.AssetReader")
            .map_err(|e| format!("new_string class name: {e}"))?;
        let reader_class_obj = env
            .call_method(
                &class_loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&reader_class_name)],
            )
            .map_err(|e| format!("loadClass AssetReader: {e}"))?
            .l()
            .map_err(|e| format!("loadClass .l(): {e}"))?;
        let reader_class = JClass::from(reader_class_obj);

        let result = env
            .call_static_method(
                reader_class,
                "readAsset",
                "(Landroid/content/Context;Ljava/lang/String;)[B",
                &[
                    JValue::Object(&app),
                    JValue::Object(&*j_path),
                ],
            )
            .map_err(|e| format!("AssetReader.readAsset: {e}"))?
            .l()
            .map_err(|e| format!("readAsset .l(): {e}"))?;

        if result.is_null() {
            return Err(format!("asset not found: {asset_path}"));
        }

        // Convert JObject → &JByteArray → Vec<u8>
        let byte_array_ref: &JByteArray = (&result).into();
        env.convert_byte_array(byte_array_ref)
            .map_err(|e| format!("convert_byte_array: {e}"))
    })();

    // Always clear any pending JNI exception before returning — a leftover
    // exception would abort the process on the next JNI call from Tauri / WRY.
    if result.is_err() {
        clear_any_pending_exception(&mut env);
    }

    result
}

#[tauri::command]
pub async fn fetch_audio_base64(url: String) -> Result<String, String> {
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn sentences_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage::sentences_root(app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ensure_sentence_audio_cached(
    app: AppHandle,
    audio_id: String,
    url: String,
) -> Result<String, String> {
    let audio_id = audio_id.trim();
    if audio_id.is_empty() {
        return Err("audio_id is empty".into());
    }
    if url.trim().is_empty() {
        return Err("url is empty".into());
    }

    let dir = sentences_root(&app)?.join(audio_id).join("tatoeba");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Tatoeba audio is typically mp3; keep a stable filename so subsequent calls are O(1).
    let final_path = dir.join("tatoeba.mp3");

    if let Ok(meta) = fs::metadata(&final_path) {
        if meta.len() > 1024 {
            return Ok(final_path.to_string_lossy().to_string());
        }
    }

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("download returned empty body".into());
    }

    let part_path = dir.join("tatoeba.mp3.part");
    fs::write(&part_path, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn read_bundled_resource_base64(
    app: AppHandle,
    resource_path: String,
) -> Result<String, String> {
    let mut rel = resource_path.trim().trim_start_matches('/').to_string();
    if rel.is_empty() {
        return Err("resource_path is empty".into());
    }
    if let Some(stripped) = rel.strip_prefix("resources/") {
        rel = stripped.to_string();
    }
    if rel.contains("..") {
        return Err("invalid resource_path".into());
    }

    // -----------------------------------------------------------------------
    // Android: read via JNI → AssetManager (bypasses the plugin-fs fd bug)
    // -----------------------------------------------------------------------
    #[cfg(target_os = "android")]
    {
        // Assets are stored under the APK's assets/ root.  Tauri places
        // resource files directly under assets/, so try both `rel` and
        // `resources/{rel}`.
        let asset_candidates = [rel.clone(), format!("resources/{rel}")];
        for asset_path in &asset_candidates {
            match read_android_asset(asset_path) {
                Ok(bytes) if !bytes.is_empty() => {
                    return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                _ => {}
            }
        }
        // If Android JNI path failed, fall through to the generic filesystem
        // path below (it won't work for asset:// URIs, but might work for
        // files previously extracted to the data directory).
    }

    let rel_candidates = [rel.clone(), format!("resources/{rel}")];
    let mut read_errors: Vec<String> = Vec::new();

    for candidate in rel_candidates {
        if let Ok(resolved) = app.path().resolve(&candidate, BaseDirectory::Resource) {
            match fs::read(&resolved) {
                Ok(bytes) => {
                    return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                Err(e) => {
                    read_errors.push(format!(
                        "resolve(Resource) {candidate} -> {} ({})",
                        resolved.display(),
                        e
                    ));
                }
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join(&rel),
            resource_dir.join("resources").join(&rel),
        ];

        for path in candidates {
            match fs::read(&path) {
                Ok(bytes) => {
                    return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
                }
                Err(e) => {
                    read_errors.push(format!("resource_dir {} ({})", path.display(), e));
                }
            }
        }
    }

    let detail = if read_errors.is_empty() {
        "no readable candidates".to_string()
    } else {
        read_errors.join(" | ")
    };
    Err(format!("resource not found: {rel} ({detail})"))
}
