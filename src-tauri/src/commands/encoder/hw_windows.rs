//! Windows Media Foundation H.264 backend (quality-profile aware).
//!
//! Full IMFSinkWriter / MFT path lands here. Until linked, `available()` is false
//! and the desktop worker uses openh264.

use crate::commands::encoder::quality::{target_bitrate_bps, QualityProfile};
use crate::commands::render::{RenderConfig, RenderMessage};
use crossbeam_channel::Receiver;
use std::sync::atomic::AtomicBool;

/// True when MF path is ready for production export.
pub fn available() -> bool {
    std::env::var("MSS_ENABLE_MEDIAFOUNDATION")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        && mf_runtime_ok()
}

fn mf_runtime_ok() -> bool {
    // Placeholder: real probe would MFStartup + enumerate H.264 encoders.
    false
}

/// Run MF encode for the full session. On any error, caller falls back to openh264.
pub fn run(
    _rx: Receiver<RenderMessage>,
    config: RenderConfig,
    _stop_flag: std::sync::Arc<AtomicBool>,
    profile: QualityProfile,
) -> Result<(), String> {
    let bitrate = target_bitrate_bps(config.width, config.height, config.fps, profile);
    log::info!(
        target: "backend::render",
        "Media Foundation requested {}x{}@{} bitrate={bitrate} profile={profile:?} — session not linked yet",
        config.width,
        config.height,
        config.fps
    );
    Err(
        "Media Foundation encoder not fully linked; implement IMFSinkWriter H.264 with remux contract (segment IDR, QualityProfile bitrate)"
            .into(),
    )
}
