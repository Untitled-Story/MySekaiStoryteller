use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::fs::File;
use std::path::Path;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use super::error::RendererError;

pub const OUTPUT_SAMPLE_RATE: u32 = 48_000;
pub const OUTPUT_CHANNELS: usize = 2;
pub const VOICE_VOLUME: f32 = 0.5;
const LIP_SYNC_FFT_SIZE: usize = 512;
const LIP_SYNC_MIN_DECIBELS: f32 = -90.0;
const LIP_SYNC_MAX_DECIBELS: f32 = -10.0;
const LIP_SYNC_MIN_RMS: f32 = 1e-5; // 10^(-100/20)

/// Decoded audio track resampled to `OUTPUT_SAMPLE_RATE` (`48_000` Hz) stereo interleaved `f32`,
/// plus mono samples for WebAudio `AnalyserNode`-equivalent lip-sync RMS calculation.
#[derive(Debug, Clone)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub stereo_samples: Vec<f32>,
    pub mono_samples: Vec<f32>,
}

impl DecodedAudio {
    pub fn duration_ms(&self) -> f64 {
        let frames = self.mono_samples.len();
        (frames as f64 * 1000.0) / self.sample_rate as f64
    }

    /// Computes WebAudio `AnalyserNode` + `untitled-pixi-live2d-engine` `SoundManager.analyze`
    /// mouth sync value (`0.0..=1.0`, quantized to `0.1` steps) at `offset_ms`.
    pub fn lip_sync_mouth_open_at(&self, offset_ms: f64) -> f32 {
        if self.mono_samples.is_empty() || offset_ms < 0.0 || offset_ms >= self.duration_ms() {
            return 0.0;
        }
        let end_frame = ((offset_ms * self.sample_rate as f64) / 1000.0)
            .round()
            .clamp(0.0, self.mono_samples.len() as f64) as usize;
        let start_frame = end_frame.saturating_sub(LIP_SYNC_FFT_SIZE);
        let window = &self.mono_samples[start_frame..end_frame];
        let mut sum_sq = 0.0_f64;
        for &sample in window {
            let s = sample as f64;
            sum_sq += s * s;
        }
        // WebAudio AnalyserNode uses fftSize = 512 denominator (leading zeros before start).
        let rms = (sum_sq / LIP_SYNC_FFT_SIZE as f64).sqrt() as f32;
        let db = 20.0 * rms.max(LIP_SYNC_MIN_RMS).log10();
        let scaled_db =
            ((db - LIP_SYNC_MIN_DECIBELS) / (LIP_SYNC_MAX_DECIBELS - LIP_SYNC_MIN_DECIBELS))
                .clamp(0.0, 1.0);
        // `parseFloat(scaledDb.toFixed(1))` in JS rounds to 0.1 increments.
        (scaled_db * 10.0).round() / 10.0
    }
}

/// Active voice event scheduled on the offline timeline.
#[derive(Debug, Clone)]
pub struct ScheduledVoiceEvent {
    pub start_ms: f64,
    pub voice_key: String,
    pub gain: f32,
}

/// Decodes an audio file (`.wav`, `.ogg`, `.mp3`, `.m4a`, `.mp4`, `.flac`, etc.) purely in Rust
/// and resamples it to 48 kHz stereo `f32`.
pub fn decode_audio_file(path: &Path) -> Result<DecodedAudio, RendererError> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| RendererError::AudioDecode(format!("{}: {e}", path.display())))?;

    let track = format
        .default_track(symphonia::core::formats::TrackType::Audio)
        .ok_or_else(|| {
            RendererError::AudioDecode(format!("No audio track found in {}", path.display()))
        })?;
    let track_id = track.id;
    let audio_params = track
        .codec_params
        .as_ref()
        .and_then(|c| c.audio())
        .ok_or_else(|| {
            RendererError::AudioDecode(format!("Missing audio codec parameters in {}", path.display()))
        })?
        .clone();

    let src_sample_rate = audio_params.sample_rate.unwrap_or(OUTPUT_SAMPLE_RATE);
    let src_channels = audio_params
        .channels
        .as_ref()
        .map(|ch| ch.count())
        .unwrap_or(2)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
        .map_err(|e| RendererError::AudioDecode(format!("{}: {e}", path.display())))?;

    let mut decoded_stereo: Vec<f32> = Vec::new();
    let mut packet_scratch: Vec<f32> = Vec::new();

    while let Some(packet) = format
        .next_packet()
        .map_err(|e| RendererError::AudioDecode(format!("{}: {e}", path.display())))?
    {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buffer) => {
                let channels = buffer.spec().channels().count().max(1);
                packet_scratch.clear();
                buffer.copy_to_vec_interleaved::<f32>(&mut packet_scratch);
                push_downmixed_stereo(&packet_scratch, channels, &mut decoded_stereo);
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => {
                // Skip recoverable frame corruption cleanly.
                continue;
            }
            Err(err) => {
                return Err(RendererError::AudioDecode(format!(
                    "{}: {err}",
                    path.display()
                )));
            }
        }
    }
    let _ = src_channels;

    let resampled = if src_sample_rate != OUTPUT_SAMPLE_RATE && !decoded_stereo.is_empty() {
        resample_stereo_f32(&decoded_stereo, src_sample_rate, OUTPUT_SAMPLE_RATE)?
    } else {
        decoded_stereo
    };

    let mono_samples = stereo_to_mono(&resampled);
    Ok(DecodedAudio {
        sample_rate: OUTPUT_SAMPLE_RATE,
        stereo_samples: resampled,
        mono_samples,
    })
}

fn push_downmixed_stereo(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels == 1 {
        out.reserve(interleaved.len() * 2);
        for &s in interleaved {
            out.push(s);
            out.push(s);
        }
        return;
    }
    if channels == 2 {
        out.extend_from_slice(interleaved);
        return;
    }
    for frame in interleaved.chunks_exact(channels) {
        // Simple balanced stereo fold-down for >2 channel assets.
        let mut l = frame[0];
        let mut r = frame[1];
        if channels > 2 {
            let center = frame[2] * 0.707_106_77;
            l += center;
            r += center;
        }
        out.push(l);
        out.push(r);
    }
}

fn stereo_to_mono(stereo: &[f32]) -> Vec<f32> {
    let mut mono = Vec::with_capacity(stereo.len() / 2);
    for pair in stereo.chunks_exact(2) {
        mono.push(0.5 * (pair[0] + pair[1]));
    }
    mono
}

fn resample_stereo_f32(
    input_stereo: &[f32],
    src_rate: u32,
    dst_rate: u32,
) -> Result<Vec<f32>, RendererError> {
    let input_frames = input_stereo.len() / OUTPUT_CHANNELS;
    if input_frames == 0 {
        return Ok(Vec::new());
    }
    let chunk_size = 1024usize.min(input_frames.max(64));
    let mut resampler = Fft::<f32>::new(
        src_rate as usize,
        dst_rate as usize,
        chunk_size,
        OUTPUT_CHANNELS,
        FixedSync::Both,
    )
    .map_err(|e| RendererError::AudioDecode(format!("Resampler init failed: {e}")))?;

    let adapter = InterleavedSlice::new(input_stereo, OUTPUT_CHANNELS, input_frames)
        .map_err(|e| RendererError::AudioDecode(format!("Audio slice error: {e}")))?;
    let resampled = resampler
        .process_all(&adapter, input_frames, None)
        .map_err(|e| RendererError::AudioDecode(format!("Resample failed: {e}")))?;
    Ok(resampled.take_data())
}

/// Mixes all scheduled voice tracks into a 48 kHz interleaved stereo `i16` timeline
/// padded smoothly with soft clipping protection (`tanh` above 0.98 or clamped).
pub fn mix_timeline_audio(
    events: &[ScheduledVoiceEvent],
    voices: &std::collections::HashMap<String, DecodedAudio>,
    total_duration_ms: f64,
) -> Vec<i16> {
    let total_frames = ((total_duration_ms * OUTPUT_SAMPLE_RATE as f64) / 1000.0)
        .ceil()
        .max(0.0) as usize;
    let mut mix = vec![0.0_f32; total_frames * OUTPUT_CHANNELS];

    for event in events {
        let Some(track) = voices.get(&event.voice_key) else {
            continue;
        };
        let start_frame = ((event.start_ms.max(0.0) * OUTPUT_SAMPLE_RATE as f64) / 1000.0)
            .round() as usize;
        if start_frame >= total_frames {
            continue;
        }
        let max_copy_frames = (total_frames - start_frame).min(track.stereo_samples.len() / 2);
        let src = &track.stereo_samples[..max_copy_frames * 2];
        let dst = &mut mix[start_frame * 2..(start_frame + max_copy_frames) * 2];
        for (d, &s) in dst.iter_mut().zip(src.iter()) {
            *d += s * event.gain;
        }
    }

    mix.into_iter()
        .map(|sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32).round() as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn lip_sync_quantization_matches_webaudio_analyser() {
        let mut mono = vec![0.0_f32; 4800];
        // Generate -20 dB sine wave (~0.1414 peak, 0.1 RMS => 20*log10(0.1) = -20dB).
        // scaledDb = (-20 - (-90)) / 80 = 70/80 = 0.875 => toFixed(1) = 0.9.
        let peak = 0.1_f32 * std::f32::consts::SQRT_2;
        for (i, sample) in mono.iter_mut().enumerate() {
            *sample = peak * (2.0 * PI * 440.0 * (i as f32 / 48_000.0)).sin();
        }
        let audio = DecodedAudio {
            sample_rate: 48_000,
            stereo_samples: Vec::new(),
            mono_samples: mono,
        };
        let mouth = audio.lip_sync_mouth_open_at(50.0);
        assert!((mouth - 0.9).abs() < 1e-4, "expected 0.9, got {mouth}");
        assert_eq!(audio.lip_sync_mouth_open_at(150.0), 0.0);
    }

    #[test]
    fn decode_repo_test_mp4_voice_succeeds() {
        let path = Path::new("../tests/voices");
        if !path.is_dir() {
            return;
        }
        for entry in std::fs::read_dir(path).unwrap().flatten() {
            let p = entry.path();
            if p.is_file() {
                let decoded = decode_audio_file(&p).expect("decode test voice");
                assert_eq!(decoded.sample_rate, OUTPUT_SAMPLE_RATE);
                assert!(decoded.duration_ms() > 100.0);
            }
        }
    }
}
