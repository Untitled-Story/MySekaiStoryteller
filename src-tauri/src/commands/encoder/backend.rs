//! Encoder backend selection: platform HW first, openh264 soft fallback.
//! No system ffmpeg.

use crate::commands::encoder::openh264_worker::run_openh264_with_profile;
use crate::commands::encoder::quality::QualityProfile;
use crate::commands::render::{RenderConfig, RenderMessage};
use crossbeam_channel::Receiver;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBackendKind {
    OpenH264,
    #[cfg(target_os = "macos")]
    VideoToolbox,
    #[cfg(windows)]
    MediaFoundation,
    #[cfg(target_os = "android")]
    MediaCodec,
}

impl EncoderBackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EncoderBackendKind::OpenH264 => "openh264",
            #[cfg(target_os = "macos")]
            EncoderBackendKind::VideoToolbox => "videotoolbox",
            #[cfg(windows)]
            EncoderBackendKind::MediaFoundation => "mediafoundation",
            #[cfg(target_os = "android")]
            EncoderBackendKind::MediaCodec => "mediacodec",
        }
    }
}

/// Prefer platform HW when available; always safe to fall back to openh264.
pub fn probe_encoder_backend() -> EncoderBackendKind {
    if force_soft() {
        log::info!(target: "backend::render", "encoder probe: forced openh264 (MSS_FORCE_SOFT_ENCODER)");
        return EncoderBackendKind::OpenH264;
    }

    #[cfg(target_os = "macos")]
    {
        if crate::commands::encoder::hw_macos::available() {
            log::info!(target: "backend::render", "encoder probe: VideoToolbox");
            return EncoderBackendKind::VideoToolbox;
        }
        log::info!(target: "backend::render", "encoder probe: VideoToolbox unavailable → openh264");
    }

    #[cfg(windows)]
    {
        if crate::commands::encoder::hw_windows::available() {
            log::info!(target: "backend::render", "encoder probe: Media Foundation");
            return EncoderBackendKind::MediaFoundation;
        }
        log::info!(target: "backend::render", "encoder probe: Media Foundation unavailable → openh264");
    }

    #[cfg(target_os = "linux")]
    {
        log::info!(
            target: "backend::render",
            "encoder probe: Linux uses openh264 (VAAPI/NVENC not wired in P1)"
        );
    }

    EncoderBackendKind::OpenH264
}

fn force_soft() -> bool {
    std::env::var("MSS_FORCE_SOFT_ENCODER")
        .map(|v| {
            v == "1"
                || v.eq_ignore_ascii_case("true")
                || v.eq_ignore_ascii_case("yes")
                || v.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false)
}

/// Desktop entry: probe HW, encode with profile, soft fallback on HW failure.
pub fn run_encode_worker(
    rx: Receiver<RenderMessage>,
    config: RenderConfig,
    stop_flag: std::sync::Arc<AtomicBool>,
) {
    let profile = QualityProfile::Balanced;
    let kind = probe_encoder_backend();
    log::info!(
        target: "backend::render",
        "encoder start backend={} profile={:?} {}x{}@{} path={}",
        kind.as_str(),
        profile,
        config.width,
        config.height,
        config.fps,
        config.export_path
    );

    match kind {
        #[cfg(target_os = "macos")]
        EncoderBackendKind::VideoToolbox => {
            match crate::commands::encoder::hw_macos::run(rx.clone(), config.clone(), std::sync::Arc::clone(&stop_flag), profile)
            {
                Ok(()) => return,
                Err(e) => {
                    log::warn!(
                        target: "backend::render",
                        "VideoToolbox failed, falling back to openh264: {e}"
                    );
                }
            }
        }
        #[cfg(windows)]
        EncoderBackendKind::MediaFoundation => {
            match crate::commands::encoder::hw_windows::run(
                rx.clone(),
                config.clone(),
                std::sync::Arc::clone(&stop_flag),
                profile,
            ) {
                Ok(()) => return,
                Err(e) => {
                    log::warn!(
                        target: "backend::render",
                        "Media Foundation failed, falling back to openh264: {e}"
                    );
                }
            }
        }
        EncoderBackendKind::OpenH264 => {}
        #[cfg(target_os = "android")]
        EncoderBackendKind::MediaCodec => {
            // Android still enters via mobile_encoder (MediaCodec path).
        }
    }

    run_openh264_with_profile(rx, config, stop_flag, profile);
}
