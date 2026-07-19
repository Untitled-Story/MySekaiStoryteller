//! Android MediaCodec H.264 encoder via JNI (Kotlin HwH264Encoder).

use jni::objects::{GlobalRef, JByteArray, JObject, JValue};
use jni::sys::jlong;
use jni::{AttachGuard, JavaVM};
use std::sync::OnceLock;

const CLASS: &str = "org/untitled_story/storyteller/encode/HwH264Encoder";

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
/// Cached from MainActivity ClassLoader — worker-thread FindClass only sees system loader.
static HW_ENCODER_CLASS: OnceLock<GlobalRef> = OnceLock::new();

/// Call once from MainActivity (JNI) so worker threads can attach.
pub fn install_java_vm(vm: JavaVM) {
    match JAVA_VM.set(vm) {
        Ok(()) => log::info!(target: "backend::render", "JavaVM stored for MediaCodec"),
        Err(_) => log::debug!(target: "backend::render", "JavaVM already stored"),
    }
}

/// Cache HwH264Encoder class while we still have the app ClassLoader (MainActivity).
pub fn install_hw_encoder_class(env: &mut jni::JNIEnv) {
    if HW_ENCODER_CLASS.get().is_some() {
        return;
    }
    match env.find_class(CLASS) {
        Ok(class) => match env.new_global_ref(class) {
            Ok(gref) => {
                let _ = HW_ENCODER_CLASS.set(gref);
                log::info!(
                    target: "backend::render",
                    "HwH264Encoder class cached for worker-thread JNI"
                );
            }
            Err(e) => log::error!(
                target: "backend::render",
                "HwH264Encoder global ref failed: {e}"
            ),
        },
        Err(e) => {
            let _ = env.exception_clear();
            log::error!(
                target: "backend::render",
                "HwH264Encoder find_class on MainActivity failed: {e}"
            );
        }
    }
}

pub fn java_vm_ready() -> bool {
    JAVA_VM.get().is_some() && HW_ENCODER_CLASS.get().is_some()
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

fn encoder_class<'a>(env: &mut jni::JNIEnv<'a>) -> Result<&'static GlobalRef, String> {
    if let Some(gref) = HW_ENCODER_CLASS.get() {
        return Ok(gref);
    }
    // Last resort (usually fails on worker threads) — cache if it works.
    let class = env.find_class(CLASS).map_err(|e| {
        let _ = env.exception_clear();
        format!("find_class {CLASS}: {e}")
    })?;
    let gref = env
        .new_global_ref(class)
        .map_err(|e| format!("global_ref {CLASS}: {e}"))?;
    let _ = HW_ENCODER_CLASS.set(gref);
    HW_ENCODER_CLASS
        .get()
        .ok_or_else(|| "HwH264Encoder class cache race".into())
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
        return Err("JavaVM/HwH264Encoder class not ready".into());
    }
    let mut env = attach()?;
    let path_j = env
        .new_string(path)
        .map_err(|e| format!("new_string path: {e}"))?;
    let class = encoder_class(&mut env)?;
    let result = env.call_static_method(
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
    );
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return Err("HwH264Encoder.create threw Java exception".into());
    }
    let result = result.map_err(|e| {
        let _ = env.exception_clear();
        format!("HwH264Encoder.create: {e}")
    })?;
    let id = result
        .j()
        .map_err(|e| format!("create result not jlong: {e}"))?;
    if id <= 0 {
        return Err("HwH264Encoder.create failed (returned -1); see logcat HwH264Encoder".into());
    }
    Ok(id)
}

/// Encode one packed RGBA frame (`width*height*4` bytes).
pub fn hw_encoder_encode(session_id: i64, rgba: &[u8], pts_us: i64) -> Result<(), String> {
    let mut env = attach()?;
    let arr: JByteArray = env
        .byte_array_from_slice(rgba)
        .map_err(|e| format!("byte_array_from_slice: {e}"))?;
    let class = encoder_class(&mut env)?;
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

/// Encode pre-converted NV12 (size = width*height*3/2). Smaller than RGBA over JNI.
pub fn hw_encoder_encode_nv12(session_id: i64, nv12: &[u8], pts_us: i64) -> Result<(), String> {
    let mut env = attach()?;
    let arr: JByteArray = env
        .byte_array_from_slice(nv12)
        .map_err(|e| format!("byte_array_from_slice nv12: {e}"))?;
    let class = encoder_class(&mut env)?;
    env.call_static_method(
        class,
        "encodeNv12",
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
        format!("HwH264Encoder.encodeNv12: {e}")
    })?;
    Ok(())
}

pub fn hw_encoder_finish(session_id: i64) -> Result<(), String> {
    let mut env = attach()?;
    let class = encoder_class(&mut env)?;
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
        if let Ok(class) = encoder_class(&mut env) {
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
pub extern "system" fn Java_org_untitled_1story_storyteller_MainActivity_mssInstallJavaVm(
    mut env: jni::JNIEnv,
    _this: jni::objects::JClass,
) {
    match env.get_java_vm() {
        Ok(vm) => {
            install_java_vm(vm);
            install_hw_encoder_class(&mut env);
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
