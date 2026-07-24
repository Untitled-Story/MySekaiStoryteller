use tauri::{AppHandle, Runtime};

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileArgs {
    pub path: String,
    pub mime_type: Option<String>,
}

/// Android share fallback. Prefer WebView `window.MssShare.shareFile` from the frontend.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn share_file<R: Runtime>(_app: AppHandle<R>, args: ShareFileArgs) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    log::info!(target: "backend::share", "share_file args={args:?}");
    let path = args.path.trim().to_string();
    if path.is_empty() {
        return Err("empty share path".into());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("file does not exist: {path}"));
    }
    let mime_type = args
        .mime_type
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "video/mp4".to_string());

    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return Err("Android context unavailable for share_file".into());
    }
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|error| format!("JavaVM::from_raw: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("attach_current_thread: {error}"))?;

    // Class lookup may fail on plain worker threads; frontend should use MssShare bridge first.
    let class = env
        .find_class("org/untitled_story/storyteller/ShareHelper")
        .map_err(|error| {
            let _ = env.exception_clear();
            format!("find_class ShareHelper: {error}")
        })?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let path_j = env
        .new_string(&path)
        .map_err(|error| format!("new_string path: {error}"))?;
    let mime_j = env
        .new_string(&mime_type)
        .map_err(|error| format!("new_string mime: {error}"))?;

    env.call_static_method(
        class,
        "shareFile",
        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&context),
            JValue::Object(&path_j),
            JValue::Object(&mime_j),
        ],
    )
    .map_err(|error| {
        let _ = env.exception_clear();
        format!("ShareHelper.shareFile: {error}")
    })?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn share_file<R: Runtime>(_app: AppHandle<R>, _args: ShareFileArgs) -> Result<(), String> {
    Err("Share is only supported on Android".into())
}
