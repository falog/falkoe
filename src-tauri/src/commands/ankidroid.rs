/// AnkiDroid integration via JNI (Android only).
///
/// On desktop, the frontend talks to AnkiConnect (localhost:8765) directly.
/// On Android, we go through AnkiDroid's ContentProvider by calling the
/// Kotlin `AnkiDroidHelper` class from Rust.

#[cfg(target_os = "android")]
mod inner {
    use jni::objects::{JClass, JValue};
    use serde::{Deserialize, Serialize};

    /// Payload sent from the TypeScript frontend.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AddNotePayload {
        pub deck_name: String,
        pub model_name: String,
        /// Ordered field values, e.g. `["Front HTML", "Back HTML"]`.
        pub fields: Vec<String>,
        /// Space-separated tags, e.g. `"falkoe pronunciation eng"`.
        pub tags: String,
        /// Filenames for media attachments.
        pub media_names: Vec<String>,
        /// Base64-encoded media data (same order as `media_names`).
        pub media_datas_base64: Vec<String>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AddNoteResult {
        pub note_id: String,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AnkiDroidStatus {
        pub installed: bool,
        pub permission_granted: bool,
    }

    // -- helpers ----------------------------------------------------------

    /// Try to extract a pending Java exception's message string.
    /// Clears the exception so JNI calls can continue.
    fn extract_java_exception(env: &mut jni::JNIEnv) -> String {
        if !env.exception_check().unwrap_or(false) {
            return "(no pending exception)".into();
        }
        let exc = match env.exception_occurred() {
            Ok(e) => e,
            Err(_) => return "(exception_occurred failed)".into(),
        };
        let _ = env.exception_clear();
        // Throwable.getMessage() → String
        match env.call_method(&exc, "getMessage", "()Ljava/lang/String;", &[]) {
            Ok(val) => match val.l() {
                Ok(obj) => {
                    if obj.is_null() {
                        // Fall back to toString()
                        match env.call_method(&exc, "toString", "()Ljava/lang/String;", &[]) {
                            Ok(v2) => match v2.l() {
                                Ok(o2) if !o2.is_null() => {
                                    env.get_string((&o2).into())
                                        .map(|s| String::from(s))
                                        .unwrap_or_else(|_| "(toString decode failed)".into())
                                }
                                _ => "(null toString)".into(),
                            },
                            Err(e) => format!("(toString call failed: {e})"),
                        }
                    } else {
                        env.get_string((&obj).into())
                            .map(|s| String::from(s))
                            .unwrap_or_else(|_| "(getMessage decode failed)".into())
                    }
                }
                Err(e) => format!("(getMessage .l() failed: {e})"),
            },
            Err(e) => format!("(getMessage call failed: {e})"),
        }
    }

    /// Get Application context via `ActivityThread.currentApplication()`.
    fn get_app_context<'a>(
        env: &mut jni::JNIEnv<'a>,
    ) -> Result<jni::objects::JObject<'a>, String> {
        let at = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("find ActivityThread: {e}"))?;
        let app = env
            .call_static_method(at, "currentApplication", "()Landroid/app/Application;", &[])
            .map_err(|e| format!("currentApplication: {e}"))?
            .l()
            .map_err(|e| format!("currentApplication .l(): {e}"))?;
        if app.is_null() {
            return Err("currentApplication() returned null".into());
        }
        Ok(app)
    }

    /// Load `com.fal.falkoe.AnkiDroidHelper` via the app's ClassLoader.
    fn load_helper_class<'a>(
        env: &mut jni::JNIEnv<'a>,
        app: &jni::objects::JObject<'a>,
    ) -> Result<JClass<'a>, String> {
        let cl = env
            .call_method(app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?
            .l()
            .map_err(|e| format!("getClassLoader .l(): {e}"))?;
        let name = env
            .new_string("com.fal.falkoe.AnkiDroidHelper")
            .map_err(|e| format!("new_string: {e}"))?;
        let cls = env
            .call_method(
                &cl,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )
            .map_err(|e| format!("loadClass AnkiDroidHelper: {e}"))?
            .l()
            .map_err(|e| format!("loadClass .l(): {e}"))?;
        Ok(JClass::from(cls))
    }

    /// Get the current Activity (the topmost resumed Activity).
    fn get_activity<'a>(env: &mut jni::JNIEnv<'a>) -> Result<jni::objects::JObject<'a>, String> {
        // ActivityThread.currentActivityThread().getActivity()
        // is an internal API – instead we use the Tauri/ndk_context approach:
        // ndk_context stores the ANativeActivity pointer, but we actually just
        // need the topmost resumed Activity.  On a single-Activity Tauri app
        // the simplest way is ActivityThread → mActivities → first value.
        //
        // However, the cleanest path is:  the Application context obtained from
        // ActivityThread.currentApplication() is actually the Application class
        // that also can be cast to Activity in some cases.
        //
        // The most reliable approach for Tauri: use the compat startActivity
        // trick, or just get the current Activity from ActivityThread.
        //
        // Since we need a real Activity for requestPermissions, we'll get it
        // from the running Activities map.
        let at_class = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("find ActivityThread: {e}"))?;
        let at = env
            .call_static_method(
                at_class,
                "currentActivityThread",
                "()Landroid/app/ActivityThread;",
                &[],
            )
            .map_err(|e| format!("currentActivityThread: {e}"))?
            .l()
            .map_err(|e| format!("currentActivityThread .l(): {e}"))?;

        // mActivities is an ArrayMap<IBinder, ActivityClientRecord>
        let activities_field = env
            .get_field(&at, "mActivities", "Landroid/util/ArrayMap;")
            .map_err(|e| format!("mActivities field: {e}"))?
            .l()
            .map_err(|e| format!("mActivities .l(): {e}"))?;

        // ArrayMap.size()
        let size = env
            .call_method(&activities_field, "size", "()I", &[])
            .map_err(|e| format!("size: {e}"))?
            .i()
            .map_err(|e| format!("size .i(): {e}"))?;

        if size == 0 {
            return Err("No running activities found".into());
        }

        // Get the first ActivityClientRecord
        let record = env
            .call_method(
                &activities_field,
                "valueAt",
                "(I)Ljava/lang/Object;",
                &[JValue::Int(0)],
            )
            .map_err(|e| format!("valueAt: {e}"))?
            .l()
            .map_err(|e| format!("valueAt .l(): {e}"))?;

        // ActivityClientRecord.activity is the Activity
        let activity = env
            .get_field(&record, "activity", "Landroid/app/Activity;")
            .map_err(|e| format!("activity field: {e}"))?
            .l()
            .map_err(|e| format!("activity .l(): {e}"))?;

        if activity.is_null() {
            return Err("Activity is null".into());
        }

        Ok(activity)
    }

    // -- Tauri commands ---------------------------------------------------

    /// Check whether AnkiDroid is installed and permissions are granted.
    #[tauri::command]
    pub fn ankidroid_status() -> Result<AnkiDroidStatus, String> {
        let vm = crate::android_jni::java_vm()?;
        let mut env = vm
            .attach_current_thread_permanently()
            .map_err(|e| format!("attach: {e}"))?;

        let app = get_app_context(&mut env)?;
        let helper = load_helper_class(&mut env, &app)?;

        let installed = env
            .call_static_method(
                &helper,
                "isInstalled",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(&app)],
            )
            .map_err(|e| format!("isInstalled: {e}"))?
            .z()
            .map_err(|e| format!("isInstalled .z(): {e}"))?;

        let permission_granted = env
            .call_static_method(
                &helper,
                "hasPermission",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(&app)],
            )
            .map_err(|e| format!("hasPermission: {e}"))?
            .z()
            .map_err(|e| format!("hasPermission .z(): {e}"))?;

        Ok(AnkiDroidStatus {
            installed,
            permission_granted,
        })
    }

    /// Request the AnkiDroid database permission at runtime.
    /// Returns `true` if already granted, `false` if the dialog was shown.
    #[tauri::command]
    pub fn ankidroid_request_permission() -> Result<bool, String> {
        let vm = crate::android_jni::java_vm()?;
        let mut env = vm
            .attach_current_thread_permanently()
            .map_err(|e| format!("attach: {e}"))?;

        let app = get_app_context(&mut env)?;
        let helper = load_helper_class(&mut env, &app)?;
        let activity = get_activity(&mut env)?;

        let already_granted = env
            .call_static_method(
                &helper,
                "requestPermission",
                "(Landroid/app/Activity;)Z",
                &[JValue::Object(&activity)],
            )
            .map_err(|e| format!("requestPermission: {e}"))?
            .z()
            .map_err(|e| format!("requestPermission .z(): {e}"))?;

        Ok(already_granted)
    }

    /// Add a note to AnkiDroid via its ContentProvider.
    #[tauri::command]
    pub fn ankidroid_add_note(payload: AddNotePayload) -> Result<AddNoteResult, String> {
        let vm = crate::android_jni::java_vm()?;
        let mut env = vm
            .attach_current_thread_permanently()
            .map_err(|e| format!("attach: {e}"))?;

        let app = get_app_context(&mut env)?;
        let helper = load_helper_class(&mut env, &app)?;

        // Serialise arrays as JSON strings — simpler than building JNI
        // Object arrays, and `AnkiDroidHelper.addNoteFromJni` parses them.
        let fields_json = serde_json::to_string(&payload.fields)
            .map_err(|e| format!("json fields: {e}"))?;
        let media_names_json = serde_json::to_string(&payload.media_names)
            .map_err(|e| format!("json media_names: {e}"))?;
        let media_datas_json = serde_json::to_string(&payload.media_datas_base64)
            .map_err(|e| format!("json media_datas: {e}"))?;

        let j_deck = env.new_string(&payload.deck_name).map_err(|e| format!("j_deck: {e}"))?;
        let j_model = env.new_string(&payload.model_name).map_err(|e| format!("j_model: {e}"))?;
        let j_fields = env.new_string(&fields_json).map_err(|e| format!("j_fields: {e}"))?;
        let j_tags = env.new_string(&payload.tags).map_err(|e| format!("j_tags: {e}"))?;
        let j_mnames = env.new_string(&media_names_json).map_err(|e| format!("j_mnames: {e}"))?;
        let j_mdatas = env.new_string(&media_datas_json).map_err(|e| format!("j_mdatas: {e}"))?;

        let result = env
            .call_static_method(
                &helper,
                "addNoteFromJni",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(&app),
                    JValue::Object(&j_deck),
                    JValue::Object(&j_model),
                    JValue::Object(&j_fields),
                    JValue::Object(&j_tags),
                    JValue::Object(&j_mnames),
                    JValue::Object(&j_mdatas),
                ],
            );

        // If the call failed, try to extract the Java exception message.
        let result = match result {
            Ok(v) => v,
            Err(_e) => {
                let msg = extract_java_exception(&mut env);
                return Err(format!("addNoteFromJni: {msg}"));
            }
        };

        let result_obj = result
            .l()
            .map_err(|e| format!("addNoteFromJni .l(): {e}"))?;

        let note_id: String = env
            .get_string((&result_obj).into())
            .map_err(|e| format!("get_string: {e}"))?
            .into();

        Ok(AddNoteResult { note_id })
    }
}

// Re-export commands so they can be registered in lib.rs.
#[cfg(target_os = "android")]
pub use inner::{ankidroid_add_note, ankidroid_request_permission, ankidroid_status};

// On non-Android targets, provide stub commands that return errors.
#[cfg(not(target_os = "android"))]
mod stubs {
    use serde::Serialize;

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AnkiDroidStatus {
        pub installed: bool,
        pub permission_granted: bool,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AddNoteResult {
        pub note_id: String,
    }

    #[tauri::command]
    pub fn ankidroid_status() -> Result<AnkiDroidStatus, String> {
        Err("ankidroid_status is only available on Android".into())
    }

    #[tauri::command]
    pub fn ankidroid_request_permission() -> Result<bool, String> {
        Err("ankidroid_request_permission is only available on Android".into())
    }

    #[tauri::command]
    pub fn ankidroid_add_note() -> Result<AddNoteResult, String> {
        Err("ankidroid_add_note is only available on Android".into())
    }
}

#[cfg(not(target_os = "android"))]
pub use stubs::{ankidroid_add_note, ankidroid_request_permission, ankidroid_status};
