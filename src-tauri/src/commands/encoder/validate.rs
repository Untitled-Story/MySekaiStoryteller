//! Lightweight MP4 validation without ffprobe.

/// Returns an estimated duration (at least `min_duration_sec`) when ftyp/moov/mdat look present.
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
            // Prefer real duration from mp4 crate when possible.
            if let Ok(dur) = read_duration_sec(path) {
                if dur + 1e-3 < min_duration_sec {
                    return Err(format!(
                        "Segment too short: {path} duration={dur:.3}s < expected {min_duration_sec:.3}s"
                    ));
                }
                return Ok(dur.max(0.05));
            }
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

fn read_duration_sec(path: &str) -> Result<f64, String> {
    use mp4::Mp4Reader;
    use std::fs::File;
    use std::io::BufReader;

    let f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let reader = BufReader::new(f);
    let mp4 = Mp4Reader::read_header(reader, size).map_err(|e| e.to_string())?;
    Ok(mp4.duration().as_secs_f64())
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
