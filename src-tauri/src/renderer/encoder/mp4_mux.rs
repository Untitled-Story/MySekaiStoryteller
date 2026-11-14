use muxide::api::{AacProfile, AudioCodec, Muxer, MuxerBuilder, MuxerStats, VideoCodec};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use crate::renderer::audio::{OUTPUT_CHANNELS, OUTPUT_SAMPLE_RATE};
use crate::renderer::error::RendererError;

/// Fast-start MP4 container muxer backed purely by `muxide`.
pub struct Mp4MuxerWriter {
    muxer: Muxer<BufWriter<File>>,
}

impl Mp4MuxerWriter {
    pub fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        include_audio: bool,
    ) -> Result<Self, RendererError> {
        let file = File::create(path)?;
        let writer = BufWriter::with_capacity(256 * 1024, file);
        let mut builder = MuxerBuilder::new(writer)
            .video(VideoCodec::H264, width, height, fps as f64)
            .with_fast_start(true);
        if include_audio {
            builder = builder.audio(
                AudioCodec::Aac(AacProfile::Lc),
                OUTPUT_SAMPLE_RATE,
                OUTPUT_CHANNELS as u16,
            );
        }
        let muxer = builder
            .build()
            .map_err(|err| RendererError::Mux(format!("Muxer build failed: {err}")))?;

        Ok(Self { muxer })
    }

    pub fn write_video(
        &mut self,
        pts_secs: f64,
        annex_b: &[u8],
        is_keyframe: bool,
    ) -> Result<(), RendererError> {
        self.muxer
            .write_video(pts_secs, annex_b, is_keyframe)
            .map_err(|err| RendererError::Mux(format!("write_video failed: {err}")))
    }

    pub fn write_audio(&mut self, pts_secs: f64, adts_frame: &[u8]) -> Result<(), RendererError> {
        self.muxer
            .write_audio(pts_secs, adts_frame)
            .map_err(|err| RendererError::Mux(format!("write_audio failed: {err}")))
    }

    pub fn finish(self) -> Result<MuxerStats, RendererError> {
        self.muxer
            .finish_with_stats()
            .map_err(|err| RendererError::Mux(format!("MP4 finalization failed: {err}")))
    }
}
