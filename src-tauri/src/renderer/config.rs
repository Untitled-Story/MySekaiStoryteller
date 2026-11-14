use serde::{Deserialize, Serialize};

use super::error::RendererError;

pub const DEFAULT_EXPORT_SEED: u64 = 0x5E4A_1202_6000_0001;
pub const MAX_EXPORT_WIDTH: u32 = 3840;
pub const MAX_EXPORT_HEIGHT: u32 = 2160;
pub const MAX_EXPORT_FPS: u32 = 120;
pub const MAX_TRAILING_HOLD_MS: u32 = 30_000;
pub const MAX_VIDEO_QP: u8 = 51;
pub const MIN_VIDEO_BITRATE_KBPS: u32 = 100;
pub const MAX_VIDEO_BITRATE_KBPS: u32 = 100_000;
pub const MAX_GOP_FRAMES: u32 = 600;
pub const MIN_AUDIO_BITRATE_KBPS: u32 = 32;
pub const MAX_AUDIO_BITRATE_KBPS: u32 = 512;
pub const MAX_AUDIO_VOLUME_PERCENT: u32 = 200;

/// Visual + encoding quality preset mapped to pure-Rust H.264 / AAC settings.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VideoQualityPreset {
    Fast,
    #[default]
    Balanced,
    Quality,
}

impl VideoQualityPreset {
    /// Target H.264 QP (lower = higher quality; YUV420p Constrained Baseline).
    pub fn h264_qp(self) -> u8 {
        match self {
            Self::Fast => 24,
            Self::Balanced => 19,
            Self::Quality => 14,
        }
    }

    /// Target H.264 bitrate in bits/sec when rate control is used cleanly alongside QP.
    pub fn aac_bitrate(self) -> u32 {
        match self {
            Self::Fast => 128_000,
            Self::Balanced => 192_000,
            Self::Quality => 256_000,
        }
    }
}

/// Deterministic PRNG seeding strategy for randomized VFX (`OldFilm`, `CRT`, `TriangleParticles`, EyeBlink).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum SeedMode {
    Fixed {
        #[serde(default = "default_seed_value")]
        seed: u64,
    },
    Random,
}

impl Default for SeedMode {
    fn default() -> Self {
        Self::Fixed {
            seed: DEFAULT_EXPORT_SEED,
        }
    }
}

fn default_seed_value() -> u64 {
    DEFAULT_EXPORT_SEED
}

/// Video export parameters passed from the frontend dialog or CLI/tests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportConfig {
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default)]
    pub quality: VideoQualityPreset,
    #[serde(default)]
    pub seed_mode: SeedMode,
    #[serde(default = "default_trailing_hold_ms")]
    pub trailing_hold_ms: u32,
    #[serde(default)]
    pub video_qp: Option<u8>,
    #[serde(default)]
    pub video_bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub gop_frames: Option<u32>,
    #[serde(default = "default_true")]
    pub include_audio: bool,
    #[serde(default)]
    pub audio_bitrate_kbps: Option<u32>,
    #[serde(default = "default_audio_volume_percent")]
    pub audio_volume_percent: u32,
    #[serde(default = "default_background_color")]
    pub background_color: String,
}

fn default_width() -> u32 {
    1920
}
fn default_height() -> u32 {
    1080
}
fn default_fps() -> u32 {
    60
}
fn default_trailing_hold_ms() -> u32 {
    500
}
fn default_true() -> bool {
    true
}
fn default_audio_volume_percent() -> u32 {
    100
}
fn default_background_color() -> String {
    "#000000".to_string()
}

impl Default for VideoExportConfig {
    fn default() -> Self {
        Self {
            width: default_width(),
            height: default_height(),
            fps: default_fps(),
            quality: VideoQualityPreset::default(),
            seed_mode: SeedMode::default(),
            trailing_hold_ms: default_trailing_hold_ms(),
            video_qp: None,
            video_bitrate_kbps: None,
            gop_frames: None,
            include_audio: true,
            audio_bitrate_kbps: None,
            audio_volume_percent: default_audio_volume_percent(),
            background_color: default_background_color(),
        }
    }
}

impl VideoExportConfig {
    /// Validates export dimensions (must be even for YUV420p), FPS, codec options, audio, and backdrop bounds.
    pub fn validate(&self) -> Result<(), RendererError> {
        if self.width < 16 || self.height < 16 {
            return Err(RendererError::InvalidConfig(
                "Output resolution must be at least 16x16".into(),
            ));
        }
        if self.width > MAX_EXPORT_WIDTH || self.height > MAX_EXPORT_HEIGHT {
            return Err(RendererError::InvalidConfig(format!(
                "Output resolution cannot exceed {MAX_EXPORT_WIDTH}x{MAX_EXPORT_HEIGHT}"
            )));
        }
        if self.width % 2 != 0 || self.height % 2 != 0 {
            return Err(RendererError::InvalidConfig(
                "Output width and height must be even numbers for H.264 YUV420p encoding".into(),
            ));
        }
        if self.fps == 0 || self.fps > MAX_EXPORT_FPS {
            return Err(RendererError::InvalidConfig(format!(
                "FPS must be between 1 and {MAX_EXPORT_FPS}"
            )));
        }
        if self.trailing_hold_ms > MAX_TRAILING_HOLD_MS {
            return Err(RendererError::InvalidConfig(format!(
                "Trailing hold duration cannot exceed {MAX_TRAILING_HOLD_MS}ms"
            )));
        }
        if let Some(qp) = self.video_qp {
            if qp > MAX_VIDEO_QP {
                return Err(RendererError::InvalidConfig(format!(
                    "Video QP must be between 0 and {MAX_VIDEO_QP}"
                )));
            }
        }
        if let Some(kbps) = self.video_bitrate_kbps {
            if !(MIN_VIDEO_BITRATE_KBPS..=MAX_VIDEO_BITRATE_KBPS).contains(&kbps) {
                return Err(RendererError::InvalidConfig(format!(
                    "Video target bitrate must be between {MIN_VIDEO_BITRATE_KBPS} and {MAX_VIDEO_BITRATE_KBPS} kbps"
                )));
            }
        }
        if let Some(gop) = self.gop_frames {
            if !(1..=MAX_GOP_FRAMES).contains(&gop) {
                return Err(RendererError::InvalidConfig(format!(
                    "Keyframe interval must be between 1 and {MAX_GOP_FRAMES} frames"
                )));
            }
        }
        if let Some(kbps) = self.audio_bitrate_kbps {
            if !(MIN_AUDIO_BITRATE_KBPS..=MAX_AUDIO_BITRATE_KBPS).contains(&kbps) {
                return Err(RendererError::InvalidConfig(format!(
                    "Audio bitrate must be between {MIN_AUDIO_BITRATE_KBPS} and {MAX_AUDIO_BITRATE_KBPS} kbps"
                )));
            }
        }
        if self.audio_volume_percent > MAX_AUDIO_VOLUME_PERCENT {
            return Err(RendererError::InvalidConfig(format!(
                "Audio volume must be between 0% and {MAX_AUDIO_VOLUME_PERCENT}%"
            )));
        }
        super::story::parse_hex_color(&self.background_color)?;
        Ok(())
    }

    pub fn resolved_video_qp(&self) -> u8 {
        self.video_qp.unwrap_or_else(|| self.quality.h264_qp())
    }

    pub fn resolved_video_bitrate_bps(&self) -> u32 {
        self.video_bitrate_kbps
            .map(|kbps| kbps.saturating_mul(1000))
            .unwrap_or(0)
    }

    pub fn resolved_gop_frames(&self) -> u32 {
        self.gop_frames
            .unwrap_or_else(|| (self.fps / 2).clamp(2, 30))
    }

    pub fn resolved_audio_bitrate_bps(&self) -> u32 {
        self.audio_bitrate_kbps
            .map(|kbps| kbps.saturating_mul(1000))
            .unwrap_or_else(|| self.quality.aac_bitrate())
    }

    pub fn audio_gain_multiplier(&self) -> f32 {
        (self.audio_volume_percent as f32) / 100.0
    }

    pub fn resolved_background_rgba(&self) -> Result<[f32; 4], RendererError> {
        super::story::parse_hex_color(&self.background_color)
    }

    /// Resolves the concrete PRNG seed used for this export run.
    pub fn resolve_seed(&self) -> u64 {
        match self.seed_mode {
            SeedMode::Fixed { seed } => seed,
            SeedMode::Random => rand::random::<u64>(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VideoExportPhase {
    Preparing,
    SimulatingAudio,
    RenderingFrames,
    EncodingAudio,
    Muxing,
    WritingDestination,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportProgress {
    pub export_id: String,
    pub phase: VideoExportPhase,
    pub rendered_frames: u64,
    pub total_frames: Option<u64>,
    pub progress: f32,
    pub elapsed_ms: u64,
    pub eta_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultStats {
    pub duration_ms: u64,
    pub frame_count: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub seed_used: u64,
    pub output_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_odd_dimensions_and_zero_fps() {
        let mut cfg = VideoExportConfig::default();
        assert!(cfg.validate().is_ok());

        cfg.width = 1281;
        assert!(cfg.validate().is_err());

        cfg.width = 1280;
        cfg.fps = 0;
        assert!(cfg.validate().is_err());

        cfg.fps = 30;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn config_fixed_seed_is_reproducible() {
        let cfg = VideoExportConfig {
            seed_mode: SeedMode::Fixed { seed: 42 },
            ..Default::default()
        };
        assert_eq!(cfg.resolve_seed(), 42);
    }

    #[test]
    fn config_validates_custom_codec_audio_and_backdrop_fields() {
        let legacy: VideoExportConfig =
            serde_json::from_str(r#"{"width":1280,"height":720,"fps":24}"#).expect("legacy json");
        assert!(legacy.include_audio);
        assert_eq!(legacy.audio_volume_percent, 100);
        assert_eq!(legacy.background_color, "#000000");
        assert_eq!(legacy.resolved_gop_frames(), 12);
        assert!(legacy.validate().is_ok());

        let mut custom = VideoExportConfig {
            fps: 120,
            video_qp: Some(16),
            video_bitrate_kbps: Some(12_000),
            gop_frames: Some(1),
            include_audio: false,
            audio_bitrate_kbps: Some(256),
            audio_volume_percent: 150,
            background_color: "#112233".to_string(),
            trailing_hold_ms: 25_000,
            ..Default::default()
        };
        assert!(custom.validate().is_ok());
        assert_eq!(custom.resolved_video_qp(), 16);
        assert_eq!(custom.resolved_video_bitrate_bps(), 12_000_000);
        assert_eq!(custom.resolved_gop_frames(), 1);
        assert_eq!(custom.resolved_audio_bitrate_bps(), 256_000);
        assert!((custom.audio_gain_multiplier() - 1.5).abs() < 1e-6);

        custom.video_qp = Some(52);
        assert!(custom.validate().is_err());
        custom.video_qp = None;

        custom.video_bitrate_kbps = Some(50);
        assert!(custom.validate().is_err());
        custom.video_bitrate_kbps = None;

        custom.gop_frames = Some(0);
        assert!(custom.validate().is_err());
        custom.gop_frames = None;

        custom.audio_bitrate_kbps = Some(16);
        assert!(custom.validate().is_err());
        custom.audio_bitrate_kbps = None;

        custom.audio_volume_percent = 201;
        assert!(custom.validate().is_err());
        custom.audio_volume_percent = 100;

        custom.background_color = "not-hex".to_string();
        assert!(custom.validate().is_err());
    }
}
