//! Mobile encode entry: MediaCodec preferred, openh264 fallback (no host ffmpeg).

use crate::commands::encoder::{
    clamp_export_config, run_soft_encode_worker, target_bitrate_bps, QualityProfile,
};
use crate::commands::render::{RenderConfig, RenderMessage};
use crossbeam_channel::Receiver;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub fn clamp_mobile_config(config: &RenderConfig) -> RenderConfig {
    clamp_export_config(config)
}

/// Drain RGBA frame batches and write a playable MP4 to `config.export_path`.
pub fn run_mobile_encode_worker(
    rx: Receiver<RenderMessage>,
    config: RenderConfig,
    stop_flag: std::sync::Arc<AtomicBool>,
) {
    let config = clamp_mobile_config(&config);
    let width = config.width;
    let height = config.height;
    let fps = config.fps.max(1);
    let frame_bytes = (width as usize) * (height as usize) * 4;
    let export_path = config.export_path.clone();

    if let Some(parent) = Path::new(&export_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::error!(target: "backend::render", "mobile encoder mkdir failed: {e}");
                while let Ok(msg) = rx.recv() {
                    if matches!(msg, RenderMessage::Stop) {
                        break;
                    }
                }
                return;
            }
        }
    }

    // MediaCodec preferred on Android.
    #[cfg(target_os = "android")]
    {
        let allow_hw = std::env::var("MSS_ANDROID_MEDIACODEC")
            .map(|v| {
                !(v == "0"
                    || v.eq_ignore_ascii_case("false")
                    || v.eq_ignore_ascii_case("off")
                    || v.eq_ignore_ascii_case("no"))
            })
            .unwrap_or(true);
        let bitrate = target_bitrate_bps(width, height, fps, QualityProfile::Balanced);
        if !allow_hw {
            log::info!(
                target: "backend::render",
                "mobile MediaCodec disabled via MSS_ANDROID_MEDIACODEC; using openh264"
            );
        } else if !crate::commands::mobile_hw_encoder::java_vm_ready() {
            log::warn!(
                target: "backend::render",
                "mobile MediaCodec skipped: JavaVM not installed yet; using openh264"
            );
        }
        let hw_result = if allow_hw && crate::commands::mobile_hw_encoder::java_vm_ready() {
            log::info!(
                target: "backend::render",
                "mobile MediaCodec create begin {}x{}@{} bitrate={bitrate}",
                width,
                height,
                fps
            );
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::commands::mobile_hw_encoder::hw_encoder_create(
                    &export_path,
                    width,
                    height,
                    fps,
                    bitrate,
                )
            }))
        } else {
            Ok(Err("MediaCodec not enabled or JavaVM not ready".into()))
        };
        match hw_result {
            Ok(Ok(session)) => {
                log::info!(
                    target: "backend::render",
                    "mobile encoder: MediaCodec session={session} path={export_path} {}x{}@{} bitrate={bitrate}",
                    width,
                    height,
                    fps
                );
                let loop_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_hw_encode_loop(
                        rx.clone(),
                        std::sync::Arc::clone(&stop_flag),
                        session,
                        frame_bytes,
                        width as usize,
                        height as usize,
                        fps,
                    );
                }));
                match loop_result {
                    Ok(()) => return,
                    Err(_) => {
                        log::error!(
                            target: "backend::render",
                            "mobile MediaCodec encode loop panicked; falling back is impossible mid-stream"
                        );
                        crate::commands::mobile_hw_encoder::hw_encoder_destroy(session);
                        return;
                    }
                }
            }
            Ok(Err(e)) => {
                log::warn!(
                    target: "backend::render",
                    "mobile MediaCodec unavailable, falling back to openh264: {e}"
                );
            }
            Err(_) => {
                log::warn!(
                    target: "backend::render",
                    "mobile MediaCodec init panicked (JavaVM?), falling back to openh264"
                );
            }
        }
    }

    // Shared soft path (openh264 + mp4 crate).
    run_soft_encode_worker(rx, config, stop_flag);
}

pub use crate::commands::encoder::validate_mp4_basic;

#[cfg(target_os = "android")]
fn run_hw_encode_loop(
    rx: Receiver<RenderMessage>,
    stop_flag: std::sync::Arc<AtomicBool>,
    session: i64,
    frame_bytes: usize,
    width: usize,
    height: usize,
    fps: u32,
) {
    // Keep JNIEnv attached for the whole loop — per-frame attach/detach was very expensive.
    if let Err(e) = crate::commands::mobile_hw_encoder::attach_encode_thread_permanently() {
        log::warn!(
            target: "backend::render",
            "mobile MediaCodec permanent JNI attach failed (will attach per call): {e}"
        );
    }

    let mut frame_index: u64 = 0;
    let sample_duration_us: i64 = (1_000_000i64 / i64::from(fps.max(1))).max(1);
    let mut encode_error: Option<String> = None;
    let mut nv12 = vec![0u8; width.saturating_mul(height).saturating_mul(3) / 2];
    let encode_started = std::time::Instant::now();
    let mut encode_ns_acc: u128 = 0;
    let mut encode_ns_count: u64 = 0;
    let mut expand_ns_acc: u128 = 0;
    let mut convert_ns_acc: u128 = 0;
    let mut jni_ns_acc: u128 = 0;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(RenderMessage::FrameBatch(data)) => {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                let t_expand = std::time::Instant::now();
                let data = match crate::commands::render::expand_frame_payload(data, frame_bytes) {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!(target: "backend::render", "mobile hw frame expand failed: {e}");
                        encode_error = Some(e);
                        break;
                    }
                };
                expand_ns_acc = expand_ns_acc.saturating_add(t_expand.elapsed().as_nanos());
                if data.is_empty() || data.len() % frame_bytes != 0 {
                    log::error!(
                        target: "backend::render",
                        "mobile hw unexpected batch size {} (frame {})",
                        data.len(),
                        frame_bytes
                    );
                    encode_error = Some("bad batch size".into());
                    break;
                }
                let frame_count = data.len() / frame_bytes;
                for i in 0..frame_count {
                    let start = i * frame_bytes;
                    let frame = &data[start..start + frame_bytes];
                    let pts = (frame_index as i64).saturating_mul(sample_duration_us);
                    let t0 = std::time::Instant::now();
                    let t_convert = std::time::Instant::now();
                    rgba_to_nv12(frame, width, height, &mut nv12);
                    convert_ns_acc = convert_ns_acc.saturating_add(t_convert.elapsed().as_nanos());
                    let t_jni = std::time::Instant::now();
                    if let Err(e) = crate::commands::mobile_hw_encoder::hw_encoder_encode_nv12(
                        session, &nv12, pts,
                    ) {
                        log::error!(target: "backend::render", "mobile MediaCodec encode failed: {e}");
                        encode_error = Some(e);
                        stop_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                    jni_ns_acc = jni_ns_acc.saturating_add(t_jni.elapsed().as_nanos());
                    encode_ns_acc = encode_ns_acc.saturating_add(t0.elapsed().as_nanos());
                    encode_ns_count = encode_ns_count.saturating_add(1);
                    frame_index = frame_index.saturating_add(1);
                    if frame_index > 0 && frame_index % 30 == 0 {
                        let n = encode_ns_count.max(1);
                        let avg_ms = (encode_ns_acc / u128::from(n)) as f64 / 1_000_000.0;
                        let avg_expand_ms = (expand_ns_acc / u128::from(n)) as f64 / 1_000_000.0;
                        let avg_convert_ms = (convert_ns_acc / u128::from(n)) as f64 / 1_000_000.0;
                        let avg_jni_ms = (jni_ns_acc / u128::from(n)) as f64 / 1_000_000.0;
                        let wall_fps =
                            frame_index as f64 / encode_started.elapsed().as_secs_f64().max(0.001);
                        log::info!(
                            target: "backend::render",
                            "mobile MediaCodec progress frames={frame_index} avg_encode_ms={avg_ms:.2} expand_ms={avg_expand_ms:.2} convert_ms={avg_convert_ms:.2} jni_ms={avg_jni_ms:.2} wall_fps={wall_fps:.2}"
                        );
                        encode_ns_acc = 0;
                        encode_ns_count = 0;
                        expand_ns_acc = 0;
                        convert_ns_acc = 0;
                        jni_ns_acc = 0;
                    }
                }
                if encode_error.is_some() {
                    break;
                }
            }
            Ok(RenderMessage::Stop) => break,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Drain remaining frames if clean stop.
    if encode_error.is_none() {
        while let Ok(msg) = rx.try_recv() {
            if let RenderMessage::FrameBatch(data) = msg {
                if data.len() % frame_bytes == 0 {
                    let frame_count = data.len() / frame_bytes;
                    for i in 0..frame_count {
                        let start = i * frame_bytes;
                        let frame = &data[start..start + frame_bytes];
                        let pts = (frame_index as i64).saturating_mul(sample_duration_us);
                        rgba_to_nv12(frame, width, height, &mut nv12);
                        if crate::commands::mobile_hw_encoder::hw_encoder_encode_nv12(
                            session, &nv12, pts,
                        )
                        .is_ok()
                        {
                            frame_index = frame_index.saturating_add(1);
                        }
                    }
                }
            }
        }
    }

    match crate::commands::mobile_hw_encoder::hw_encoder_finish(session) {
        Ok(()) => log::info!(
            target: "backend::render",
            "mobile MediaCodec finished frames={frame_index}"
        ),
        Err(e) => {
            log::error!(target: "backend::render", "mobile MediaCodec finish failed: {e}");
            crate::commands::mobile_hw_encoder::hw_encoder_destroy(session);
        }
    }
    crate::commands::mobile_hw_encoder::release_nv12_jni_buffer();
}

/// BT.601 limited-range RGBA → NV12 for MediaCodec.
/// WebGL `readPixels` is bottom-up; desktop FFmpeg applies `vflip`, so mobile must flip here.
/// Parallel by row-pair halves on multi-core phones (13 Pro convert was 30–90ms @720p/1080p).
#[cfg(target_os = "android")]
fn rgba_to_nv12(rgba: &[u8], width: usize, height: usize, out: &mut [u8]) {
    let frame = width * height;
    debug_assert!(out.len() >= frame + frame / 2);
    debug_assert!(rgba.len() >= frame * 4);
    if width == 0 || height == 0 {
        return;
    }
    let (y_plane, uv_plane) = out.split_at_mut(frame);
    // Split work on even row-pair boundaries so UV plane writes do not race.
    let pair_rows = height / 2;
    if pair_rows >= 4 {
        let mid_pairs = pair_rows / 2;
        let mid_row = mid_pairs * 2;
        let y_mid = mid_row * width;
        let uv_mid = mid_pairs * width;
        let (y_lo, y_hi) = y_plane.split_at_mut(y_mid);
        let (uv_lo, uv_hi) = uv_plane.split_at_mut(uv_mid);
        std::thread::scope(|s| {
            s.spawn(|| {
                rgba_to_nv12_rows_flipped(rgba, width, height, 0, mid_row, y_lo, uv_lo);
            });
            rgba_to_nv12_rows_flipped(rgba, width, height, mid_row, height, y_hi, uv_hi);
        });
        return;
    }
    rgba_to_nv12_rows_flipped(rgba, width, height, 0, height, y_plane, uv_plane);
}

/// Convert destination rows [dst_row0, dst_row1) reading source rows bottom-up (vflip).
#[cfg(target_os = "android")]
fn rgba_to_nv12_rows_flipped(
    rgba: &[u8],
    width: usize,
    height: usize,
    dst_row0: usize,
    dst_row1: usize,
    y_plane: &mut [u8],
    uv_plane: &mut [u8],
) {
    let row_bytes = width * 4;
    let mut y_i = 0usize;
    let mut uv_i = 0usize;
    for dst_row in dst_row0..dst_row1 {
        let src_row = height - 1 - dst_row;
        let mut src = src_row * row_bytes;
        let even_row = (dst_row & 1) == 0;
        let mut col = 0usize;
        while col + 1 < width {
            let r0 = rgba[src] as i32;
            let g0 = rgba[src + 1] as i32;
            let b0 = rgba[src + 2] as i32;
            let r1 = rgba[src + 4] as i32;
            let g1 = rgba[src + 5] as i32;
            let b1 = rgba[src + 6] as i32;
            src += 8;
            y_plane[y_i] = (((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8) + 16) as u8;
            y_plane[y_i + 1] = (((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8) + 16) as u8;
            y_i += 2;
            if even_row {
                // NV12: interleaved U,V. Sample top-left of the 2x2 block in destination space.
                uv_plane[uv_i] = (((-38 * r0 - 74 * g0 + 112 * b0 + 128) >> 8) + 128) as u8;
                uv_plane[uv_i + 1] = (((112 * r0 - 94 * g0 - 18 * b0 + 128) >> 8) + 128) as u8;
                uv_i += 2;
            }
            col += 2;
        }
        if col < width {
            let r = rgba[src] as i32;
            let g = rgba[src + 1] as i32;
            let b = rgba[src + 2] as i32;
            y_plane[y_i] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
            y_i += 1;
            if even_row {
                uv_plane[uv_i] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128) as u8;
                uv_plane[uv_i + 1] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128) as u8;
                uv_i += 2;
            }
        }
    }
}

