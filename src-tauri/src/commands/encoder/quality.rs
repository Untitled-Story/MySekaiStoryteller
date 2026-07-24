//! Speed / quality / size trade-offs for export encode.

use serde::{Deserialize, Serialize};

/// User-facing encode intent. Default is Balanced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum QualityProfile {
    /// Default: good quality, controlled size, solid speed with HW.
    #[default]
    Balanced,
    /// Prefer wall-clock; slightly larger files allowed.
    Fast,
    /// Prefer smaller files; quality stays acceptable.
    Small,
}

impl QualityProfile {
    /// Bits-per-pixel-per-frame budget (rough VBR target).
    pub fn bpp(self) -> f64 {
        match self {
            QualityProfile::Balanced => 0.095,
            QualityProfile::Fast => 0.12,
            QualityProfile::Small => 0.065,
        }
    }

    /// Absolute clamp (bps).
    pub fn bitrate_clamp(self) -> (u32, u32) {
        match self {
            QualityProfile::Balanced => (400_000, 12_000_000),
            QualityProfile::Fast => (500_000, 16_000_000),
            QualityProfile::Small => (300_000, 8_000_000),
        }
    }

    /// openh264 complexity: Medium for quality, Low only for Fast.
    pub fn openh264_low_complexity(self) -> bool {
        matches!(self, QualityProfile::Fast)
    }

    /// Keyframe interval in seconds (GOP).
    pub fn keyframe_interval_sec(self) -> u32 {
        match self {
            QualityProfile::Fast => 2,
            QualityProfile::Balanced => 3,
            QualityProfile::Small => 4,
        }
    }
}

/// Target average bitrate for width×height@fps under profile.
pub fn target_bitrate_bps(width: u32, height: u32, fps: u32, profile: QualityProfile) -> u32 {
    let w = u64::from(width.max(2));
    let h = u64::from(height.max(2));
    let f = u64::from(fps.max(1));
    let raw = ((w * h * f) as f64 * profile.bpp()) as u64;
    let (lo, hi) = profile.bitrate_clamp();
    raw.clamp(u64::from(lo), u64::from(hi)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrate_1080p30_balanced_in_band() {
        let b = target_bitrate_bps(1920, 1080, 30, QualityProfile::Balanced);
        assert!(b >= 4_000_000 && b <= 9_000_000, "bps={b}");
    }

    #[test]
    fn bitrate_720p30_balanced_in_band() {
        let b = target_bitrate_bps(1280, 720, 30, QualityProfile::Balanced);
        assert!(b >= 1_500_000 && b <= 5_000_000, "bps={b}");
    }
}
