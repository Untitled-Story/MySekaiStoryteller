//! Software H.264 + MP4 encode path for mobile (no host ffmpeg).

use crate::commands::render::{RenderConfig, RenderMessage};
use bytes::Bytes;
use crossbeam_channel::Receiver;
use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Absolute codec/sanity ceiling only (not a product “performance policy” cap).
/// User-facing export size is chosen in the dialog; we do not force 720p30.
const ABS_MAX_W: u32 = 4096;
const ABS_MAX_H: u32 = 2160;
const ABS_MAX_FPS: u32 = 120;

pub fn clamp_mobile_config(config: &RenderConfig) -> RenderConfig {
    let mut c = config.clone();
    c.width = c.width.clamp(160, ABS_MAX_W);
    c.height = c.height.clamp(90, ABS_MAX_H);
    // Even dimensions required for 4:2:0.
    c.width -= c.width % 2;
    c.height -= c.height % 2;
    if c.width < 160 {
        c.width = 160;
    }
    if c.height < 90 {
        c.height = 90;
    }
    c.fps = c.fps.clamp(1, ABS_MAX_FPS);
    c
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
                drain_until_stop(&rx);
                return;
            }
        }
    }

    // MediaCodec: prefer Android software AVC first (safer than OEM HW which can
    // native-crash on configure). Default ON when JavaVM is ready; set
    // MSS_ANDROID_MEDIACODEC=0 to force openh264-only.
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
        let bitrate = ((width as u64) * (height as u64) * (fps as u64) / 10)
            .clamp(400_000, 20_000_000) as u32;
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
                        // Channel may still be alive if panic was in JNI; try soft only if we never started.
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

    // Soft path: tighter bitrate for CPU encode.
    let bitrate =
        ((width as u64) * (height as u64) * (fps as u64) / 18).clamp(250_000, 6_000_000) as u32;
    let enc_config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(fps as f32))
        .skip_frames(false)
        .complexity(Complexity::Low)
        .intra_frame_period(IntraFramePeriod::from_num_frames(
            fps.saturating_mul(3).max(1),
        ));

    let mut encoder = match Encoder::with_api_config(OpenH264API::from_source(), enc_config) {
        Ok(enc) => enc,
        Err(e) => {
            log::error!(target: "backend::render", "mobile openh264 init failed: {e}");
            drain_until_stop(&rx);
            return;
        }
    };

    let file = match File::create(&export_path) {
        Ok(f) => f,
        Err(e) => {
            log::error!(target: "backend::render", "mobile create output failed path={export_path}: {e}");
            drain_until_stop(&rx);
            return;
        }
    };
    let mut writer = BufWriter::new(file);

    let mp4_config = Mp4Config {
        major_brand: str::parse("isom").expect("brand"),
        minor_version: 512,
        compatible_brands: vec![
            str::parse("isom").expect("brand"),
            str::parse("iso2").expect("brand"),
            str::parse("avc1").expect("brand"),
            str::parse("mp41").expect("brand"),
        ],
        timescale: 1000,
    };

    let mut mp4 = match Mp4Writer::write_start(&mut writer, &mp4_config) {
        Ok(w) => w,
        Err(e) => {
            log::error!(target: "backend::render", "mobile mp4 start failed: {e}");
            drain_until_stop(&rx);
            return;
        }
    };

    let mut track_ready = false;
    let mut sps: Vec<u8> = Vec::new();
    let mut pps: Vec<u8> = Vec::new();
    let mut frame_index: u64 = 0;
    let sample_duration_ms: u32 = (1000 / fps).max(1);
    let mut wrote_samples = 0u64;
    // Reuse conversion + annex-B buffers across frames (major soft-encode alloc cost).
    let mut yuv = YUVBuffer::new(width as usize, height as usize);
    let mut annex_b: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut encode_ns_acc: u128 = 0;
    let mut encode_ns_count: u64 = 0;
    let encode_started = std::time::Instant::now();

    log::info!(
        target: "backend::render",
        "mobile encoder: openh264 path={export_path} {}x{}@{} bitrate={bitrate}",
        width,
        height,
        fps
    );

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(RenderMessage::FrameBatch(data)) => {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                let data = match crate::commands::render::expand_frame_payload(data, frame_bytes) {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!(target: "backend::render", "mobile frame expand failed: {e}");
                        stop_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                };
                if data.is_empty() || data.len() % frame_bytes != 0 {
                    log::error!(
                        target: "backend::render",
                        "mobile unexpected batch size {} (frame {})",
                        data.len(),
                        frame_bytes
                    );
                    break;
                }
                let frame_count = data.len() / frame_bytes;
                for i in 0..frame_count {
                    let start = i * frame_bytes;
                    let frame = &data[start..start + frame_bytes];
                    if frame_index == 0 {
                        encoder.force_intra_frame();
                    }
                    let t0 = std::time::Instant::now();
                    if let Err(e) = encode_one_frame(
                        &mut encoder,
                        &mut mp4,
                        &mut track_ready,
                        &mut sps,
                        &mut pps,
                        &mut yuv,
                        &mut annex_b,
                        frame,
                        width as usize,
                        height as usize,
                        frame_index,
                        sample_duration_ms,
                        &mut wrote_samples,
                    ) {
                        log::error!(target: "backend::render", "mobile encode frame failed: {e}");
                        stop_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                    encode_ns_acc = encode_ns_acc.saturating_add(t0.elapsed().as_nanos());
                    encode_ns_count = encode_ns_count.saturating_add(1);
                    frame_index = frame_index.saturating_add(1);
                    if frame_index > 0 && frame_index % 30 == 0 {
                        let avg_ms = if encode_ns_count > 0 {
                            (encode_ns_acc / u128::from(encode_ns_count)) as f64 / 1_000_000.0
                        } else {
                            0.0
                        };
                        let wall_fps =
                            frame_index as f64 / encode_started.elapsed().as_secs_f64().max(0.001);
                        log::info!(
                            target: "backend::render",
                            "mobile encoder progress frames={} path={} avg_encode_ms={avg_ms:.2} wall_fps={wall_fps:.2}",
                            frame_index,
                            export_path
                        );
                        encode_ns_acc = 0;
                        encode_ns_count = 0;
                    }
                }
            }
            Ok(RenderMessage::Stop) => break,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Drain remaining
    while let Ok(msg) = rx.try_recv() {
        if let RenderMessage::FrameBatch(data) = msg {
            if data.len() % frame_bytes == 0 {
                let frame_count = data.len() / frame_bytes;
                for i in 0..frame_count {
                    let start = i * frame_bytes;
                    let frame = &data[start..start + frame_bytes];
                    let _ = encode_one_frame(
                        &mut encoder,
                        &mut mp4,
                        &mut track_ready,
                        &mut sps,
                        &mut pps,
                        &mut yuv,
                        &mut annex_b,
                        frame,
                        width as usize,
                        height as usize,
                        frame_index,
                        sample_duration_ms,
                        &mut wrote_samples,
                    );
                    frame_index = frame_index.saturating_add(1);
                }
            }
        }
    }

    if let Err(e) = mp4.write_end() {
        log::error!(target: "backend::render", "mobile mp4 write_end failed: {e}");
    }
    if let Err(e) = writer.flush() {
        log::error!(target: "backend::render", "mobile flush failed: {e}");
    }
    log::info!(
        target: "backend::render",
        "mobile encoder finished path={export_path} frames={wrote_samples} track_ready={track_ready}"
    );
}

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

fn drain_until_stop(rx: &Receiver<RenderMessage>) {
    while let Ok(msg) = rx.recv() {
        if matches!(msg, RenderMessage::Stop) {
            break;
        }
    }
}

fn encode_one_frame<W: Write + std::io::Seek>(
    encoder: &mut Encoder,
    mp4: &mut Mp4Writer<W>,
    track_ready: &mut bool,
    sps: &mut Vec<u8>,
    pps: &mut Vec<u8>,
    yuv: &mut YUVBuffer,
    annex_b: &mut Vec<u8>,
    rgba: &[u8],
    width: usize,
    height: usize,
    frame_index: u64,
    sample_duration_ms: u32,
    wrote_samples: &mut u64,
) -> Result<(), String> {
    // WebGL readback is bottom-up; match desktop ffmpeg `vflip` / MediaCodec path.
    let flipped;
    let rgba_for_enc: &[u8] = {
        let row = width * 4;
        let mut buf = vec![0u8; width * height * 4];
        for y in 0..height {
            let src = (height - 1 - y) * row;
            let dst = y * row;
            buf[dst..dst + row].copy_from_slice(&rgba[src..src + row]);
        }
        flipped = buf;
        &flipped
    };
    let rgb = RgbaSliceU8::new(rgba_for_enc, (width, height));
    yuv.read_rgb(rgb);
    let bitstream = encoder
        .encode(yuv)
        .map_err(|e| format!("openh264 encode: {e}"))?;

    annex_b.clear();
    bitstream.write_vec(annex_b);
    let nals = split_annex_b(annex_b);
    if nals.is_empty() {
        return Ok(());
    }

    let mut sample_nals: Vec<Vec<u8>> = Vec::new();
    let mut is_sync = matches!(bitstream.frame_type(), FrameType::IDR | FrameType::I);

    for nal in nals {
        if nal.is_empty() {
            continue;
        }
        let nal_type = nal[0] & 0x1f;
        match nal_type {
            7 => {
                *sps = nal.to_vec();
            }
            8 => {
                *pps = nal.to_vec();
            }
            5 => {
                is_sync = true;
                sample_nals.push(nal.to_vec());
            }
            1 | 2 | 3 | 4 => {
                sample_nals.push(nal.to_vec());
            }
            _ => {
                // skip SEI/AUD etc for sample payload; SPS/PPS handled above
            }
        }
    }

    if !*track_ready {
        if sps.is_empty() || pps.is_empty() {
            // Wait for parameter sets (usually with first IDR).
            return Ok(());
        }
        let track = TrackConfig {
            track_type: TrackType::Video,
            timescale: 1000,
            language: "und".to_string(),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: width as u16,
                height: height as u16,
                seq_param_set: sps.clone(),
                pic_param_set: pps.clone(),
            }),
        };
        mp4.add_track(&track)
            .map_err(|e| format!("mp4 add_track: {e}"))?;
        *track_ready = true;
    }

    if sample_nals.is_empty() {
        return Ok(());
    }

    let avcc = nals_to_avcc(&sample_nals);
    let sample = Mp4Sample {
        start_time: frame_index * u64::from(sample_duration_ms),
        duration: sample_duration_ms,
        rendering_offset: 0,
        is_sync,
        bytes: Bytes::from(avcc),
    };
    mp4.write_sample(1, &sample)
        .map_err(|e| format!("mp4 write_sample: {e}"))?;
    *wrote_samples = wrote_samples.saturating_add(1);
    Ok(())
}

fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut start: Option<usize> = None;
    while i + 3 <= data.len() {
        let sc3 = data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1;
        let sc4 = i + 4 <= data.len()
            && data[i] == 0
            && data[i + 1] == 0
            && data[i + 2] == 0
            && data[i + 3] == 1;
        if sc4 || sc3 {
            let nal_start = if sc4 { i + 4 } else { i + 3 };
            if let Some(s) = start {
                if s < i {
                    out.push(&data[s..i]);
                }
            }
            start = Some(nal_start);
            i = nal_start;
            continue;
        }
        i += 1;
    }
    if let Some(s) = start {
        if s < data.len() {
            out.push(&data[s..]);
        }
    } else if !data.is_empty() {
        // Already length-less single NAL without start code — rare.
        out.push(data);
    }
    out
}

fn nals_to_avcc(nals: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in nals {
        let len = nal.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}

/// Lightweight MP4 validation without ffprobe.
pub fn validate_mp4_basic(path: &str, min_duration_sec: f64) -> Result<f64, String> {
    let mut last_error = String::new();
    for attempt in 0..5 {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) => {
                last_error = format!("read failed: {e}");
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
        };
        if bytes.len() >= 64
            && find_box(&bytes, b"ftyp")
            && find_box(&bytes, b"moov")
            && find_box(&bytes, b"mdat")
        {
            return Ok(min_duration_sec.max(0.05));
        }
        last_error = if bytes.len() < 64 {
            format!("Segment too small ({} bytes)", bytes.len())
        } else {
            "Invalid MP4 (missing ftyp/moov/mdat)".to_string()
        };
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    Err(format!("{last_error}: {path}"))
}

fn find_box(data: &[u8], name: &[u8; 4]) -> bool {
    let mut offset = 0usize;
    while offset + 8 <= data.len() {
        let size32 = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        let typ = &data[offset + 4..offset + 8];
        if typ == name {
            return true;
        }
        let box_size = if size32 == 0 {
            data.len() - offset
        } else if size32 == 1 {
            if offset + 16 > data.len() {
                return false;
            }
            let large = u64::from_be_bytes([
                data[offset + 8],
                data[offset + 9],
                data[offset + 10],
                data[offset + 11],
                data[offset + 12],
                data[offset + 13],
                data[offset + 14],
                data[offset + 15],
            ]);
            match usize::try_from(large) {
                Ok(size) if size >= 16 => size,
                _ => return false,
            }
        } else if size32 >= 8 {
            size32
        } else {
            return false;
        };
        let next = match offset.checked_add(box_size) {
            Some(next) if next <= data.len() && next > offset => next,
            _ => return false,
        };
        offset = next;
    }
    false
}
