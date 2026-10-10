//! Embedded encode stack: quality profiles, openh264 soft path, pure remux, MP4 validate.
//! Platform HW backends (VT/MF) probe-first with soft fallback. No system ffmpeg/ffprobe.

mod backend;
mod openh264_worker;
mod quality;
mod remux;
mod validate;

#[cfg(target_os = "macos")]
pub mod hw_macos;
#[cfg(windows)]
pub mod hw_windows;

pub use backend::run_encode_worker;
#[allow(unused_imports)]
pub use backend::{probe_encoder_backend, EncoderBackendKind};
pub use openh264_worker::clamp_export_config;
#[cfg(mobile)]
pub use openh264_worker::run_soft_encode_worker;
#[allow(unused_imports)]
pub use openh264_worker::run_openh264_with_profile;
#[allow(unused_imports)]
pub use quality::{target_bitrate_bps, QualityProfile};
pub use remux::concat_mp4_segments;
pub use validate::validate_mp4_basic;
