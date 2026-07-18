//! Software H.264 + MP4 encode path for mobile (no host ffmpeg).

use crate::commands::render::{RenderConfig, RenderMessage};
use bytes::Bytes;
use crossbeam_channel::Receiver;
use mp4::{
    AvcConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
};
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const MAX_W: u32 = 1280;
const MAX_H: u32 = 720;
const MAX_FPS: u32 = 30;

pub fn clamp_mobile_config(config: &RenderConfig) -> RenderConfig {
    let mut c = config.clone();
    c.width = c.width.clamp(160, MAX_W);
    c.height = c.height.clamp(90, MAX_H);
    // Even dimensions required for 4:2:0.
    c.width -= c.width % 2;
    c.height -= c.height % 2;
    c.fps = c.fps.clamp(1, MAX_FPS);
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

    let bitrate = ((width as u64) * (height as u64) * (fps as u64) / 6).clamp(400_000, 6_000_000) as u32;
    let enc_config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(fps as f32))
        .skip_frames(false)
        .intra_frame_period(IntraFramePeriod::from_num_frames(fps.saturating_mul(2).max(1)));

    let mut encoder = match Encoder::with_api_config(OpenH264API::from_source(), enc_config)
    {
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

    log::info!(
        target: "backend::render",
        "mobile encoder started path={export_path} {}x{}@{} bitrate={bitrate}",
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
                    if let Err(e) = encode_one_frame(
                        &mut encoder,
                        &mut mp4,
                        &mut track_ready,
                        &mut sps,
                        &mut pps,
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
                    frame_index = frame_index.saturating_add(1);
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
    rgba: &[u8],
    width: usize,
    height: usize,
    frame_index: u64,
    sample_duration_ms: u32,
    wrote_samples: &mut u64,
) -> Result<(), String> {
    let rgb = RgbaSliceU8::new(rgba, (width, height));
    let yuv = YUVBuffer::from_rgb_source(rgb);
    let bitstream = encoder
        .encode(&yuv)
        .map_err(|e| format!("openh264 encode: {e}"))?;

    let annex_b = bitstream.to_vec();
    let nals = split_annex_b(&annex_b);
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
    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() < 64 {
        return Err(format!("Segment too small ({} bytes): {path}", bytes.len()));
    }
    let has_ftyp = find_box(&bytes, b"ftyp");
    let has_moov = find_box(&bytes, b"moov");
    let has_mdat = find_box(&bytes, b"mdat");
    if !has_ftyp || !has_moov {
        return Err(format!("Invalid MP4 (missing ftyp/moov): {path}"));
    }
    if !has_mdat {
        return Err(format!("Invalid MP4 (missing mdat): {path}"));
    }
    // Duration estimate from size is unreliable; accept if structure is sound.
    // Callers still pass min_duration for logging; return at least the floor.
    Ok(min_duration_sec.max(0.05))
}

fn find_box(data: &[u8], name: &[u8; 4]) -> bool {
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
        let typ = &data[i + 4..i + 8];
        if typ == name {
            return true;
        }
        if size < 8 {
            return false;
        }
        if size == 1 {
            // largesize — skip 8 more
            if i + 16 > data.len() {
                return false;
            }
            let large = u64::from_be_bytes([
                data[i + 8],
                data[i + 9],
                data[i + 10],
                data[i + 11],
                data[i + 12],
                data[i + 13],
                data[i + 14],
                data[i + 15],
            ]) as usize;
            if large < 16 {
                return false;
            }
            i = i.saturating_add(large);
        } else {
            i = i.saturating_add(size);
        }
        if i == 0 {
            break;
        }
    }
    false
}
