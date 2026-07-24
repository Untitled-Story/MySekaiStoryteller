//! Soft H.264 + MP4 encode worker (openh264). Shared by desktop and mobile fallback.

use crate::commands::encoder::quality::{target_bitrate_bps, QualityProfile};
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

const ABS_MAX_W: u32 = 4096;
const ABS_MAX_H: u32 = 2160;
const ABS_MAX_FPS: u32 = 120;

/// Even dimensions + sane clamps for 4:2:0 encode.
pub fn clamp_export_config(config: &RenderConfig) -> RenderConfig {
    let mut c = config.clone();
    c.width = c.width.clamp(160, ABS_MAX_W);
    c.height = c.height.clamp(90, ABS_MAX_H);
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

/// Soft H.264 encode worker (mobile MediaCodec fallback / forced soft path).
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn run_soft_encode_worker(
    rx: Receiver<RenderMessage>,
    config: RenderConfig,
    stop_flag: std::sync::Arc<AtomicBool>,
) {
    run_openh264_with_profile(rx, config, stop_flag, QualityProfile::Balanced);
}

/// Soft encode with an explicit quality profile (used after HW fallback).
pub fn run_openh264_with_profile(
    rx: Receiver<RenderMessage>,
    config: RenderConfig,
    stop_flag: std::sync::Arc<AtomicBool>,
    profile: QualityProfile,
) {
    let config = clamp_export_config(&config);
    let width = config.width;
    let height = config.height;
    let fps = config.fps.max(1);
    let frame_bytes = (width as usize) * (height as usize) * 4;
    let export_path = config.export_path.clone();
    let bitrate = target_bitrate_bps(width, height, fps, profile);

    if let Some(parent) = Path::new(&export_path).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::error!(target: "backend::render", "encoder mkdir failed: {e}");
                drain_until_stop(&rx);
                return;
            }
        }
    }

    let complexity = if profile.openh264_low_complexity() {
        Complexity::Low
    } else {
        Complexity::Medium
    };
    let gop = fps.saturating_mul(profile.keyframe_interval_sec()).max(1);
    let enc_config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(fps as f32))
        .skip_frames(false)
        .complexity(complexity)
        .intra_frame_period(IntraFramePeriod::from_num_frames(gop));

    let mut encoder = match Encoder::with_api_config(OpenH264API::from_source(), enc_config) {
        Ok(enc) => enc,
        Err(e) => {
            log::error!(target: "backend::render", "openh264 init failed: {e}");
            drain_until_stop(&rx);
            return;
        }
    };

    let file = match File::create(&export_path) {
        Ok(f) => f,
        Err(e) => {
            log::error!(target: "backend::render", "create output failed path={export_path}: {e}");
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
            log::error!(target: "backend::render", "mp4 start failed: {e}");
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
    let mut yuv = YUVBuffer::new(width as usize, height as usize);
    let mut annex_b: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut encode_ns_acc: u128 = 0;
    let mut encode_ns_count: u64 = 0;
    let encode_started = std::time::Instant::now();

    log::info!(
        target: "backend::render",
        "encoder: openh264 profile={profile:?} path={export_path} {}x{}@{} bitrate={bitrate}",
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
                let data = match expand_payload(data, frame_bytes) {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!(target: "backend::render", "frame expand failed: {e}");
                        stop_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                };
                if data.is_empty() || data.len() % frame_bytes != 0 {
                    log::error!(
                        target: "backend::render",
                        "unexpected batch size {} (frame {})",
                        data.len(),
                        frame_bytes
                    );
                    break;
                }
                let frame_count = data.len() / frame_bytes;
                for i in 0..frame_count {
                    let start = i * frame_bytes;
                    let frame = &data[start..start + frame_bytes];
                    // Force IDR on first frame of every segment (remux-friendly).
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
                        log::error!(target: "backend::render", "encode frame failed: {e}");
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
                            "encoder progress frames={} path={} avg_encode_ms={avg_ms:.2} wall_fps={wall_fps:.2}",
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
        log::error!(target: "backend::render", "mp4 write_end failed: {e}");
    }
    if let Err(e) = writer.flush() {
        log::error!(target: "backend::render", "flush failed: {e}");
    }
    log::info!(
        target: "backend::render",
        "encoder finished path={export_path} frames={wrote_samples} track_ready={track_ready}"
    );
}

fn expand_payload(data: Vec<u8>, frame_bytes: usize) -> Result<Vec<u8>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return crate::commands::render::expand_frame_payload(data, frame_bytes);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = frame_bytes;
        Ok(data)
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
    // WebGL readPixels is bottom-up.
    let row = width * 4;
    let mut flipped = vec![0u8; width * height * 4];
    for y in 0..height {
        let src = (height - 1 - y) * row;
        let dst = y * row;
        flipped[dst..dst + row].copy_from_slice(&rgba[src..src + row]);
    }
    let rgb = RgbaSliceU8::new(&flipped, (width, height));
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
            _ => {}
        }
    }

    if !*track_ready {
        if sps.is_empty() || pps.is_empty() {
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
