use oxideav_aac::adts::AdtsHeader;
use oxideav_aac::encoder::{EncoderConfig, StreamEncoder};

use crate::renderer::audio::{OUTPUT_CHANNELS, OUTPUT_SAMPLE_RATE};
use crate::renderer::config::VideoQualityPreset;
use crate::renderer::error::RendererError;

pub const AAC_FRAME_SAMPLES_PER_CHANNEL: usize = 1024;
const CHUNK_I16_LEN: usize = AAC_FRAME_SAMPLES_PER_CHANNEL * OUTPUT_CHANNELS;
const PARALLEL_AAC_MIN_CHUNKS: usize = 64;
const PARALLEL_AAC_PRIME_HOPS: usize = 4;
const SILENCE_SETTLE_MIN_HOPS: usize = 4;

#[derive(Default)]
struct SilenceHopTracker {
    consecutive_zero_hops: usize,
    last_zero_adts: Option<Vec<u8>>,
    steady_zero_adts: Option<Vec<u8>>,
}

impl SilenceHopTracker {
    fn encode_chunk(
        &mut self,
        encoder: &mut StreamEncoder,
        chunk: &[i16],
    ) -> Result<Vec<u8>, RendererError> {
        let is_full_silence: bool =
            chunk.len() == CHUNK_I16_LEN && chunk.iter().all(|&sample| sample == 0);
        if !is_full_silence {
            self.consecutive_zero_hops = 0;
            self.last_zero_adts = None;
            self.steady_zero_adts = None;
            return encoder
                .encode_frame(chunk)
                .map_err(|err| RendererError::AudioEncode(format!("AAC encode failed: {err}")));
        }

        if let Some(cached) = self.steady_zero_adts.as_ref() {
            self.consecutive_zero_hops += 1;
            return Ok(cached.clone());
        }

        let adts: Vec<u8> = encoder
            .encode_frame(chunk)
            .map_err(|err| RendererError::AudioEncode(format!("AAC encode failed: {err}")))?;
        self.consecutive_zero_hops += 1;
        if self.consecutive_zero_hops >= SILENCE_SETTLE_MIN_HOPS
            && self.last_zero_adts.as_deref() == Some(adts.as_slice())
        {
            self.steady_zero_adts = Some(adts.clone());
        }
        self.last_zero_adts = Some(adts.clone());
        Ok(adts)
    }
}

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
    silence: SilenceHopTracker,
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
            silence: SilenceHopTracker::default(),
        })
    }

    fn encode_chunk_or_silence(&mut self, chunk: &[i16]) -> Result<Vec<u8>, RendererError> {
        self.silence.encode_chunk(&mut self.encoder, chunk)
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
            let adts: Vec<u8> = self.encode_chunk_or_silence(chunk)?;
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
    let default_workers: usize = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(1)
        .clamp(1, 16);
    encode_interleaved_i16_parallel_with_workers(pcm, bitrate_bps, default_workers)
}

/// Encodes interleaved stereo PCM with an explicit upper bound on parallel AAC worker threads.
pub fn encode_interleaved_i16_parallel_with_workers(
    pcm: &[i16],
    bitrate_bps: u32,
    max_workers: usize,
) -> Result<Vec<EncodedAudioPacket>, RendererError> {
    let total_chunks: usize = pcm.len().div_ceil(CHUNK_I16_LEN);
    let worker_count: usize = max_workers
        .clamp(1, 16)
        .min(total_chunks / PARALLEL_AAC_PRIME_HOPS.max(1))
        .max(1);

    if pcm.is_empty() || total_chunks < PARALLEL_AAC_MIN_CHUNKS || worker_count <= 1 {
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
                        let _ = enc.encode_chunk_or_silence(chunks_ref[prime_idx])?;
                    }
                    enc.frame_index = seg_start as u64;
                    let mut out: Vec<EncodedAudioPacket> =
                        Vec::with_capacity(seg_end - seg_start + usize::from(is_last));
                    for idx in seg_start..seg_end {
                        let adts: Vec<u8> = enc.encode_chunk_or_silence(chunks_ref[idx])?;
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

    fn decode_adts_to_interleaved_i16(packets: &[EncodedAudioPacket]) -> Vec<i16> {
        let mut adts_stream: Vec<u8> = Vec::new();
        for pkt in packets {
            adts_stream.extend_from_slice(&pkt.adts_frame);
        }
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

        let mut samples: Vec<i16> = Vec::new();
        while let Some(packet) = format.next_packet().expect("next packet") {
            if packet.track_id != track_id {
                continue;
            }
            let buf = decoder.decode(&packet).expect("decode aac packet");
            buf.copy_to_vec_interleaved::<i16>(&mut samples);
        }
        samples
    }

    #[test]
    fn silence_hop_short_circuit_matches_raw_stream_encoder() {
        let bitrate: u32 = VideoQualityPreset::Balanced.aac_bitrate();
        let tone_samples: usize = 24_000;
        let silence_samples: usize = 72_000;
        let mut pcm: Vec<i16> = Vec::with_capacity((tone_samples * 2 + silence_samples * 2) * 2);
        let push_tone = |dst: &mut Vec<i16>, freq: f32| {
            for i in 0..tone_samples {
                let s: i16 =
                    ((i as f32 * freq * std::f32::consts::TAU / 48_000.0).sin() * 9000.0) as i16;
                dst.push(s);
                dst.push(s);
            }
        };
        push_tone(&mut pcm, 440.0);
        pcm.resize(pcm.len() + silence_samples * 2, 0);
        push_tone(&mut pcm, 660.0);
        pcm.resize(pcm.len() + silence_samples * 2, 0);

        let mut fast_enc: OxideAacAudioEncoder =
            OxideAacAudioEncoder::with_bitrate(bitrate).expect("fast aac");
        let mut fast_packets: Vec<EncodedAudioPacket> =
            fast_enc.encode_interleaved_i16(&pcm).expect("fast encode");
        fast_packets.extend(fast_enc.finish().expect("fast finish"));

        let mut raw_enc: StreamEncoder = StreamEncoder::new(EncoderConfig {
            sample_rate: OUTPUT_SAMPLE_RATE,
            channels: OUTPUT_CHANNELS as u8,
            bitrate,
        })
        .expect("raw aac");
        let mut raw_packets: Vec<EncodedAudioPacket> = Vec::with_capacity(fast_packets.len());
        for (idx, chunk) in pcm.chunks(CHUNK_I16_LEN).enumerate() {
            let adts_frame: Vec<u8> = raw_enc.encode_frame(chunk).expect("raw encode");
            raw_packets.push(EncodedAudioPacket {
                pts_secs: (idx as f64 * AAC_FRAME_SAMPLES_PER_CHANNEL as f64)
                    / (OUTPUT_SAMPLE_RATE as f64),
                adts_frame,
            });
        }
        let trailing: Vec<u8> = raw_enc.finish().expect("raw finish");
        if !trailing.is_empty() {
            raw_packets.push(EncodedAudioPacket {
                pts_secs: (raw_packets.len() as f64 * AAC_FRAME_SAMPLES_PER_CHANNEL as f64)
                    / (OUTPUT_SAMPLE_RATE as f64),
                adts_frame: trailing,
            });
        }

        assert_eq!(fast_packets.len(), raw_packets.len());
        let fast_pcm: Vec<i16> = decode_adts_to_interleaved_i16(&fast_packets);
        let raw_pcm: Vec<i16> = decode_adts_to_interleaved_i16(&raw_packets);
        assert_eq!(fast_pcm.len(), raw_pcm.len());
        let max_delta: i32 = fast_pcm
            .iter()
            .zip(raw_pcm.iter())
            .map(|(&a, &b)| (a as i32 - b as i32).abs())
            .max()
            .unwrap_or(0);
        assert!(
            max_delta <= 2,
            "expected silence hop cache to decode cleanly, got max sample delta {max_delta}"
        );

        let parallel_packets: Vec<EncodedAudioPacket> =
            encode_interleaved_i16_parallel_with_workers(&pcm, bitrate, 4)
                .expect("parallel silence encode");
        let parallel_pcm: Vec<i16> = decode_adts_to_interleaved_i16(&parallel_packets);
        assert_eq!(parallel_pcm.len(), raw_pcm.len());
    }
}
