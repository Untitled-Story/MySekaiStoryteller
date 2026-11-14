use oxideav_aac::adts::AdtsHeader;
use oxideav_aac::encoder::{EncoderConfig, StreamEncoder};

use crate::renderer::audio::{OUTPUT_CHANNELS, OUTPUT_SAMPLE_RATE};
use crate::renderer::config::VideoQualityPreset;
use crate::renderer::error::RendererError;

pub const AAC_FRAME_SAMPLES_PER_CHANNEL: usize = 1024;
const CHUNK_I16_LEN: usize = AAC_FRAME_SAMPLES_PER_CHANNEL * OUTPUT_CHANNELS;
const PARALLEL_AAC_MIN_CHUNKS: usize = 64;
const PARALLEL_AAC_PRIME_HOPS: usize = 4;

#[derive(Debug, Clone)]
pub struct EncodedAudioPacket {
    pub pts_secs: f64,
    pub adts_frame: Vec<u8>,
}

/// Abstract audio track encoder producing container-ready audio packets.
pub trait AudioTrackEncoder {
    fn encode_interleaved_i16(
        &mut self,
        pcm: &[i16],
    ) -> Result<Vec<EncodedAudioPacket>, RendererError>;

    fn finish(&mut self) -> Result<Vec<EncodedAudioPacket>, RendererError>;
}

/// Pure-Rust AAC-LC encoder backed by `oxideav_aac::encoder::StreamEncoder`.
pub struct OxideAacAudioEncoder {
    encoder: StreamEncoder,
    frame_index: u64,
}

impl OxideAacAudioEncoder {
    pub fn new(quality: VideoQualityPreset) -> Result<Self, RendererError> {
        Self::with_bitrate(quality.aac_bitrate())
    }

    pub fn with_bitrate(bitrate_bps: u32) -> Result<Self, RendererError> {
        let cfg = EncoderConfig {
            sample_rate: OUTPUT_SAMPLE_RATE,
            channels: OUTPUT_CHANNELS as u8,
            bitrate: bitrate_bps,
        };
        let encoder = StreamEncoder::new(cfg)
            .map_err(|err| RendererError::AudioEncode(format!("AAC init failed: {err}")))?;
        Ok(Self {
            encoder,
            frame_index: 0,
        })
    }

    fn push_frame_bytes(
        &mut self,
        bytes: Vec<u8>,
        out: &mut Vec<EncodedAudioPacket>,
    ) -> Result<(), RendererError> {
        if bytes.is_empty() {
            return Ok(());
        }
        AdtsHeader::parse(&bytes).map_err(|err| {
            RendererError::AudioEncode(format!("Invalid ADTS frame emitted by encoder: {err}"))
        })?;
        let pts_secs = (self.frame_index as f64 * AAC_FRAME_SAMPLES_PER_CHANNEL as f64)
            / (OUTPUT_SAMPLE_RATE as f64);
        self.frame_index += 1;
        out.push(EncodedAudioPacket {
            pts_secs,
            adts_frame: bytes,
        });
        Ok(())
    }
}

impl AudioTrackEncoder for OxideAacAudioEncoder {
    fn encode_interleaved_i16(
        &mut self,
        pcm: &[i16],
    ) -> Result<Vec<EncodedAudioPacket>, RendererError> {
        if pcm.is_empty() {
            let silence = vec![0_i16; CHUNK_I16_LEN];
            let frame = self
                .encoder
                .encode_frame(&silence)
                .map_err(|err| RendererError::AudioEncode(format!("AAC encode failed: {err}")))?;
            let mut out = Vec::with_capacity(1);
            self.push_frame_bytes(frame, &mut out)?;
            return Ok(out);
        }

        let mut packets = Vec::with_capacity(pcm.len().div_ceil(CHUNK_I16_LEN));
        for chunk in pcm.chunks(CHUNK_I16_LEN) {
            let adts = self
                .encoder
                .encode_frame(chunk)
                .map_err(|err| RendererError::AudioEncode(format!("AAC encode failed: {err}")))?;
            self.push_frame_bytes(adts, &mut packets)?;
        }
        Ok(packets)
    }

    fn finish(&mut self) -> Result<Vec<EncodedAudioPacket>, RendererError> {
        let flushed = self
            .encoder
            .finish()
            .map_err(|err| RendererError::AudioEncode(format!("AAC finish failed: {err}")))?;
        let mut out = Vec::new();
        self.push_frame_bytes(flushed, &mut out)?;
        Ok(out)
    }
}

/// Encodes interleaved stereo PCM using lookback-primed parallel AAC workers when the stream
/// is long enough to benefit, falling back to sequential [`OxideAacAudioEncoder`] otherwise.
pub fn encode_interleaved_i16_parallel(
    pcm: &[i16],
    bitrate_bps: u32,
) -> Result<Vec<EncodedAudioPacket>, RendererError> {
    let total_chunks: usize = pcm.len().div_ceil(CHUNK_I16_LEN);
    if pcm.is_empty() || total_chunks < PARALLEL_AAC_MIN_CHUNKS {
        let mut enc: OxideAacAudioEncoder = OxideAacAudioEncoder::with_bitrate(bitrate_bps)?;
        let mut packets: Vec<EncodedAudioPacket> = enc.encode_interleaved_i16(pcm)?;
        packets.extend(enc.finish()?);
        return Ok(packets);
    }

    let worker_count: usize = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(1)
        .clamp(1, 8)
        .min(total_chunks / PARALLEL_AAC_PRIME_HOPS.max(1))
        .max(1);

    if worker_count <= 1 {
        let mut enc: OxideAacAudioEncoder = OxideAacAudioEncoder::with_bitrate(bitrate_bps)?;
        let mut packets: Vec<EncodedAudioPacket> = enc.encode_interleaved_i16(pcm)?;
        packets.extend(enc.finish()?);
        return Ok(packets);
    }

    let chunks: Vec<&[i16]> = pcm.chunks(CHUNK_I16_LEN).collect();
    let chunks_per_worker: usize = total_chunks.div_ceil(worker_count);
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(worker_count);
    let mut start: usize = 0;
    while start < total_chunks {
        let end: usize = (start + chunks_per_worker).min(total_chunks);
        ranges.push((start, end));
        start = end;
    }

    let num_segments: usize = ranges.len();
    let segment_results: Vec<Result<Vec<EncodedAudioPacket>, RendererError>> =
        std::thread::scope(|scope| {
            let mut handles = Vec::with_capacity(num_segments);
            for (seg_idx, &(seg_start, seg_end)) in ranges.iter().enumerate() {
                let chunks_ref: &[&[i16]] = &chunks;
                handles.push(scope.spawn(move || {
                    let is_last: bool = seg_idx + 1 == num_segments;
                    let prime_start: usize = if seg_idx == 0 {
                        0
                    } else {
                        seg_start.saturating_sub(PARALLEL_AAC_PRIME_HOPS)
                    };
                    let mut enc: OxideAacAudioEncoder =
                        OxideAacAudioEncoder::with_bitrate(bitrate_bps)?;
                    for prime_idx in prime_start..seg_start {
                        let _ = enc.encoder.encode_frame(chunks_ref[prime_idx]).map_err(|err| {
                            RendererError::AudioEncode(format!("AAC prime failed: {err}"))
                        })?;
                    }
                    enc.frame_index = seg_start as u64;
                    let mut out: Vec<EncodedAudioPacket> =
                        Vec::with_capacity(seg_end - seg_start + usize::from(is_last));
                    for idx in seg_start..seg_end {
                        let adts: Vec<u8> =
                            enc.encoder.encode_frame(chunks_ref[idx]).map_err(|err| {
                                RendererError::AudioEncode(format!("AAC encode failed: {err}"))
                            })?;
                        enc.push_frame_bytes(adts, &mut out)?;
                    }
                    if is_last {
                        let flushed: Vec<u8> = enc.encoder.finish().map_err(|err| {
                            RendererError::AudioEncode(format!("AAC finish failed: {err}"))
                        })?;
                        enc.push_frame_bytes(flushed, &mut out)?;
                    }
                    Ok(out)
                }));
            }
            handles
                .into_iter()
                .map(|h| {
                    h.join().unwrap_or_else(|_| {
                        Err(RendererError::AudioEncode(
                            "Parallel AAC worker thread panicked".to_string(),
                        ))
                    })
                })
                .collect()
        });

    let mut all_packets: Vec<EncodedAudioPacket> = Vec::with_capacity(total_chunks + 1);
    for res in segment_results {
        all_packets.extend(res?);
    }
    Ok(all_packets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, TrackType};
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;

    #[test]
    fn aac_encoder_produces_valid_adts_frames() {
        let mut enc = OxideAacAudioEncoder::new(VideoQualityPreset::Balanced).expect("init aac");
        let mut pcm = Vec::with_capacity(48_000 * 2);
        for i in 0..48_000 {
            let s = ((i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 8000.0) as i16;
            pcm.push(s);
            pcm.push(s);
        }
        let mut packets = enc.encode_interleaved_i16(&pcm).expect("encode aac");
        packets.extend(enc.finish().expect("finish aac"));
        assert!(packets.len() >= 47);
        for (idx, pkt) in packets.iter().enumerate() {
            let (hdr, _) = AdtsHeader::parse(&pkt.adts_frame).expect("valid adts");
            assert_eq!(hdr.sample_rate(), OUTPUT_SAMPLE_RATE);
            assert!(
                idx == 0 || pkt.pts_secs > packets[idx - 1].pts_secs,
                "PTS must increase strictly"
            );
        }
    }

    #[test]
    fn parallel_aac_encodes_continuous_decodable_adts_stream() {
        // 3 seconds @ 48kHz stereo (~141 chunks >= PARALLEL_AAC_MIN_CHUNKS)
        let samples_per_ch: usize = 48_000 * 3 + 333;
        let mut pcm: Vec<i16> = Vec::with_capacity(samples_per_ch * 2);
        for i in 0..samples_per_ch {
            let amp: f32 = if i > 48_000 && i < 49_000 { 18_000.0 } else { 7_000.0 };
            let l: i16 = ((i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * amp) as i16;
            let r: i16 = ((i as f32 * 660.0 * std::f32::consts::TAU / 48_000.0).sin() * amp) as i16;
            pcm.push(l);
            pcm.push(r);
        }

        let bitrate: u32 = VideoQualityPreset::Balanced.aac_bitrate();
        let packets: Vec<EncodedAudioPacket> =
            encode_interleaved_i16_parallel(&pcm, bitrate).expect("parallel aac");
        let expected_chunks: usize = pcm.len().div_ceil(CHUNK_I16_LEN);
        assert_eq!(packets.len(), expected_chunks + 1);

        let mut adts_stream: Vec<u8> = Vec::new();
        for (idx, pkt) in packets.iter().enumerate() {
            let (hdr, _) = AdtsHeader::parse(&pkt.adts_frame).expect("valid adts header");
            assert_eq!(hdr.sample_rate(), OUTPUT_SAMPLE_RATE);
            if idx > 0 {
                assert!(pkt.pts_secs > packets[idx - 1].pts_secs);
            }
            adts_stream.extend_from_slice(&pkt.adts_frame);
        }

        // Decode concatenated ADTS bitstream with Symphonia to verify continuity across workers.
        let mss = MediaSourceStream::new(
            Box::new(Cursor::new(adts_stream)),
            MediaSourceStreamOptions::default(),
        );
        let mut hint = Hint::new();
        hint.with_extension("aac");
        let mut format = symphonia::default::get_probe()
            .probe(
                &hint,
                mss,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .expect("probe adts stream");
        let track = format
            .default_track(TrackType::Audio)
            .expect("default aac track");
        let track_id: u32 = track.id;
        let audio_params = track
            .codec_params
            .as_ref()
            .and_then(|c| c.audio())
            .expect("audio codec params")
            .clone();
        let mut decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
            .expect("make aac decoder");

        let mut decoded_frames: usize = 0;
        let mut total_decoded_samples_per_ch: usize = 0;
        while let Some(packet) = format.next_packet().expect("next packet") {
            if packet.track_id != track_id {
                continue;
            }
            let buf = decoder.decode(&packet).expect("decode aac packet");
            decoded_frames += 1;
            total_decoded_samples_per_ch += buf.frames();
        }
        assert_eq!(decoded_frames, packets.len());
        assert_eq!(
            total_decoded_samples_per_ch,
            packets.len() * AAC_FRAME_SAMPLES_PER_CHANNEL
        );
    }
}
