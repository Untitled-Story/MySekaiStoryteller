//! Pure H.264/AVC MP4 segment remux (no re-encode, no ffmpeg).

use bytes::Bytes;
use mp4::{
    AvcConfig, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;

/// Concatenate AVC MP4 segments by rewriting sample timelines into one file.
pub fn concat_mp4_segments(
    segment_paths: &[String],
    export_path: &str,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
) -> Result<(), String> {
    if segment_paths.is_empty() {
        return Err("No segments to concat".into());
    }
    if export_path.trim().is_empty() {
        return Err("Export path is empty".into());
    }

    if let Some(parent) = Path::new(export_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory: {e}"))?;
        }
    }

    // Single segment: copy (or rename) without re-mux overhead when paths differ.
    if segment_paths.len() == 1 {
        let src = &segment_paths[0];
        if Path::new(src)
            .canonicalize()
            .ok()
            .and_then(|s| Path::new(export_path).canonicalize().ok().map(|d| (s, d)))
            .map(|(s, d)| s == d)
            .unwrap_or(src == export_path)
        {
            if let Some(cb) = on_progress.as_mut() {
                cb(1.0);
            }
            return Ok(());
        }
        std::fs::copy(src, export_path).map_err(|e| format!("copy segment failed: {e}"))?;
        if let Some(cb) = on_progress.as_mut() {
            cb(1.0);
        }
        return Ok(());
    }

    let mut total_samples: u64 = 0;
    let mut segment_meta: Vec<(u32, u32, u16, u16, Vec<u8>, Vec<u8>)> = Vec::new();
    // (track_id, sample_count, width, height, sps, pps) per segment — probe first.

    for path in segment_paths {
        let f = File::open(path).map_err(|e| format!("open segment {path}: {e}"))?;
        let size = f
            .metadata()
            .map_err(|e| format!("stat segment {path}: {e}"))?
            .len();
        let reader = Mp4Reader::read_header(BufReader::new(f), size)
            .map_err(|e| format!("read header {path}: {e}"))?;
        let (track_id, width, height, sps, pps, count) = pick_avc_track(&reader, path)?;
        total_samples = total_samples.saturating_add(u64::from(count));
        segment_meta.push((track_id, count, width, height, sps, pps));
        drop(reader);
    }

    if total_samples == 0 {
        return Err("No video samples in segments".into());
    }

    let (_, _, width0, height0, sps0, pps0) = &segment_meta[0];
    for (i, meta) in segment_meta.iter().enumerate().skip(1) {
        if meta.2 != *width0 || meta.3 != *height0 {
            return Err(format!(
                "segment resolution mismatch: #0 {}x{} vs #{i} {}x{}",
                width0, height0, meta.2, meta.3
            ));
        }
        // SPS/PPS should match for seamless play; warn but still try remux if equal size.
        if meta.4 != *sps0 || meta.5 != *pps0 {
            log::warn!(
                target: "backend::render",
                "segment #{i} SPS/PPS differs from #0; remux may glitch at cut"
            );
        }
    }

    let out_tmp = format!("{export_path}.remuxing.mp4");
    let file = File::create(&out_tmp).map_err(|e| format!("create remux output: {e}"))?;
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
    let mut mp4 = Mp4Writer::write_start(&mut writer, &mp4_config)
        .map_err(|e| format!("mp4 write_start: {e}"))?;

    let track = TrackConfig {
        track_type: TrackType::Video,
        timescale: 1000,
        language: "und".to_string(),
        media_conf: MediaConfig::AvcConfig(AvcConfig {
            width: *width0,
            height: *height0,
            seq_param_set: sps0.clone(),
            pic_param_set: pps0.clone(),
        }),
    };
    mp4.add_track(&track)
        .map_err(|e| format!("mp4 add_track: {e}"))?;

    let mut written: u64 = 0;
    let mut timeline_ms: u64 = 0;

    for (seg_i, path) in segment_paths.iter().enumerate() {
        let (track_id, count, _, _, _, _) = &segment_meta[seg_i];
        let f = File::open(path).map_err(|e| format!("open segment {path}: {e}"))?;
        let size = f
            .metadata()
            .map_err(|e| format!("stat segment {path}: {e}"))?
            .len();
        let mut reader = Mp4Reader::read_header(BufReader::new(f), size)
            .map_err(|e| format!("read header {path}: {e}"))?;

        // sample_id is 1-based in mp4 crate.
        for sample_id in 1..=*count {
            let sample = reader
                .read_sample(*track_id, sample_id)
                .map_err(|e| format!("read_sample {path}#{sample_id}: {e}"))?
                .ok_or_else(|| format!("missing sample {path}#{sample_id}"))?;

            // Convert duration to ms timescale if needed.
            let src_timescale = reader
                .tracks()
                .get(track_id)
                .map(|t| t.timescale())
                .unwrap_or(1000)
                .max(1);
            let duration_ms = if src_timescale == 1000 {
                sample.duration.max(1)
            } else {
                ((u64::from(sample.duration) * 1000) / u64::from(src_timescale)).max(1) as u32
            };

            let out = Mp4Sample {
                start_time: timeline_ms,
                duration: duration_ms,
                rendering_offset: sample.rendering_offset,
                is_sync: sample.is_sync || sample_id == 1,
                bytes: Bytes::from(sample.bytes.to_vec()),
            };
            mp4.write_sample(1, &out)
                .map_err(|e| format!("write_sample: {e}"))?;
            timeline_ms = timeline_ms.saturating_add(u64::from(duration_ms));
            written = written.saturating_add(1);
            if written % 30 == 0 {
                if let Some(cb) = on_progress.as_mut() {
                    cb((written as f64 / total_samples as f64).clamp(0.0, 1.0));
                }
            }
        }
    }

    mp4.write_end().map_err(|e| format!("mp4 write_end: {e}"))?;
    writer
        .into_inner()
        .map_err(|e| format!("flush remux: {e}"))?
        .sync_all()
        .ok();

    std::fs::rename(&out_tmp, export_path).map_err(|e| {
        let _ = std::fs::remove_file(&out_tmp);
        format!("rename remux output: {e}")
    })?;

    if let Some(cb) = on_progress.as_mut() {
        cb(1.0);
    }
    log::info!(
        target: "backend::render",
        "remux done path={export_path} samples={written} duration_ms={timeline_ms}"
    );
    Ok(())
}

fn pick_avc_track<R: std::io::Read + std::io::Seek>(
    reader: &Mp4Reader<R>,
    path: &str,
) -> Result<(u32, u16, u16, Vec<u8>, Vec<u8>, u32), String> {
    for (id, track) in reader.tracks() {
        if track.media_type().ok() != Some(mp4::MediaType::H264) {
            continue;
        }
        let sps = track
            .sequence_parameter_set()
            .map_err(|e| format!("{path} sps: {e}"))?
            .to_vec();
        let pps = track
            .picture_parameter_set()
            .map_err(|e| format!("{path} pps: {e}"))?
            .to_vec();
        let count = track.sample_count();
        if count == 0 {
            continue;
        }
        return Ok((
            *id,
            track.width(),
            track.height(),
            sps,
            pps,
            count,
        ));
    }
    Err(format!("no H.264 track in {path}"))
}
