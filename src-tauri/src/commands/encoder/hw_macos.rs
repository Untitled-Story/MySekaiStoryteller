//! macOS VideoToolbox H.264 backend (quality-profile aware).
//!
//! Full VTCompressionSession integration lands here. Until the session is wired,
//! `available()` is false and the desktop worker uses openh264.

use crate::commands::encoder::quality::{target_bitrate_bps, QualityProfile};
use crate::commands::render::{RenderConfig, RenderMessage};
use crossbeam_channel::Receiver;
use std::sync::atomic::AtomicBool;

/// True when VideoToolbox path is ready for production export.
/// Currently false until VT session + annex-B/AVCC remux contract is complete.
pub fn available() -> bool {
    // Opt-in experimental path for developers implementing VT.
    std::env::var("MSS_ENABLE_VIDEOTOOLBOX")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        && vt_runtime_ok()
}

fn vt_runtime_ok() -> bool {
    // Placeholder: real probe would create a tiny VTCompressionSession.
    // Keep false by default so we never silently ship a half-wired path.
    false
}

/// Run VT encode for the full session. On any error, caller falls back to openh264.
pub fn run(
    _rx: Receiver<RenderMessage>,
    config: RenderConfig,
    _stop_flag: std::sync::Arc<AtomicBool>,
    profile: QualityProfile,
) -> Result<(), String> {
    let bitrate = target_bitrate_bps(config.width, config.height, config.fps, profile);
    log::info!(
        target: "backend::render",
        "VideoToolbox requested {}x{}@{} bitrate={bitrate} profile={profile:?} — session not linked yet",
        config.width,
        config.height,
        config.fps
    );
    Err(
        "VideoToolbox encoder not fully linked; set implementation in hw_macos.rs (VTCompressionSession → mp4 remux contract: segment-leading IDR, fixed bitrate/profile)"
            .into(),
    )
}
