//! Android MediaCodec H.264 encoder via JNI (Kotlin HwH264Encoder).

use jni::objects::{JByteArray, JObject, JValue};
use jni::sys::jlong;
use jni::{AttachGuard, JavaVM};
use std::sync::OnceLock;

const CLASS: &str = "org/untitled_story/storyteller/encode/HwH264Encoder";

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

/// Call once from MainActivity (JNI) so worker threads can attach.
pub fn install_java_vm(vm: JavaVM) {
    match JAVA_VM.set(vm) {
        Ok(()) => log::info!(target: "backend::render", "JavaVM stored for MediaCodec"),
        Err(_) => log::debug!(target: "backend::render", "JavaVM already stored"),
    }
}

pub fn java_vm_ready() -> bool {
    JAVA_VM.get().is_some()
}

fn java_vm() -> Result<&'static JavaVM, String> {
    JAVA_VM.get().ok_or_else(|| {
        "Android JavaVM not installed (MainActivity.mssInstallJavaVm not called / failed)".into()
    })
}

fn attach() -> Result<AttachGuard<'static>, String> {
    let vm = java_vm()?;
    vm.attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))
}

/// Create a hardware encode session writing H.264/AVC into `path` via MediaMuxer.
pub fn hw_encoder_create(
    path: &str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<i64, String> {
    if !java_vm_ready() {
        return Err("JavaVM not ready".into());
    }
    let mut env = attach()?;
    let path_j = env
        .new_string(path)
        .map_err(|e| format!("new_string path: {e}"))?;
    let class = env
        .find_class(CLASS)
        .map_err(|e| format!("find_class {CLASS}: {e}"))?;
    let result = env
        .call_static_method(
            class,
            "create",
            "(Ljava/lang/String;IIII)J",
            &[
                JValue::Object(&JObject::from(path_j)),
                JValue::Int(width as i32),
                JValue::Int(height as i32),
                JValue::Int(fps as i32),
                JValue::Int(bitrate as i32),
            ],
        )
        .map_err(|e| {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            format!("HwH264Encoder.create: {e}")
        })?;
    let id = result
        .j()
        .map_err(|e| format!("create result not jlong: {e}"))?;
    if id <= 0 {
        return Err("HwH264Encoder.create returned invalid session id".into());
    }
    Ok(id)
}

/// Encode one packed RGBA frame (`width*height*4` bytes).
pub fn hw_encoder_encode(session_id: i64, rgba: &[u8], pts_us: i64) -> Result<(), String> {
    let mut env = attach()?;
    let arr: JByteArray = env
        .byte_array_from_slice(rgba)
        .map_err(|e| format!("byte_array_from_slice: {e}"))?;
    let class = env
        .find_class(CLASS)
        .map_err(|e| format!("find_class {CLASS}: {e}"))?;
    env.call_static_method(
        class,
        "encodeRgba",
        "(J[BJ)V",
        &[
            JValue::Long(session_id as jlong),
            JValue::Object(&JObject::from(arr)),
            JValue::Long(pts_us),
        ],
    )
    .map_err(|e| {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        format!("HwH264Encoder.encodeRgba: {e}")
    })?;
    Ok(())
}

pub fn hw_encoder_finish(session_id: i64) -> Result<(), String> {
    let mut env = attach()?;
    let class = env
        .find_class(CLASS)
        .map_err(|e| format!("find_class {CLASS}: {e}"))?;
    env.call_static_method(class, "finish", "(J)V", &[JValue::Long(session_id as jlong)])
        .map_err(|e| {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            format!("HwH264Encoder.finish: {e}")
        })?;
    Ok(())
}

pub fn hw_encoder_destroy(session_id: i64) {
    if let Ok(mut env) = attach() {
        if let Ok(class) = env.find_class(CLASS) {
            let _ = env.call_static_method(
                class,
                "destroy",
                "(J)V",
                &[JValue::Long(session_id as jlong)],
            );
            let _ = env.exception_clear();
        }
    }
}

/// Called from MainActivity so worker threads can attach to the process JavaVM.
#[no_mangle]
pub extern "system" fn Java_org_untitled_story_storyteller_MainActivity_mssInstallJavaVm(
    mut env: jni::JNIEnv,
    _this: jni::objects::JClass,
) {
    match env.get_java_vm() {
        Ok(vm) => {
            install_java_vm(vm);
            log::info!(
                target: "backend::render",
                "Android JavaVM installed via MainActivity JNI"
            );
        }
        Err(e) => {
            log::error!(target: "backend::render", "MainActivity mssInstallJavaVm failed: {e}");
        }
    }
}
