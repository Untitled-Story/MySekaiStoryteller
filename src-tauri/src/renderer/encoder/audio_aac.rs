use oxideav_aac::adts::AdtsHeader;
use oxideav_aac::encoder::{EncoderConfig, StreamEncoder};

use crate::renderer::audio::{OUTPUT_CHANNELS, OUTPUT_SAMPLE_RATE};
use crate::renderer::config::VideoQualityPreset;
use crate::renderer::error::RendererError;

pub const AAC_FRAME_SAMPLES_PER_CHANNEL: usize = 1024;
const CHUNK_I16_LEN: usize = AAC_FRAME_SAMPLES_PER_CHANNEL * OUTPUT_CHANNELS;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
