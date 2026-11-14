pub mod audio_aac;
pub mod mp4_mux;
pub mod video_h264;
#[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
pub mod video_vt;

pub use audio_aac::{
    encode_interleaved_i16_parallel, encode_interleaved_i16_parallel_with_workers,
    AudioTrackEncoder, EncodedAudioPacket, OxideAacAudioEncoder,
};
pub use mp4_mux::Mp4MuxerWriter;
pub use video_h264::{
    contains_annex_b_idr, create_video_encoder, create_video_encoder_for_backend,
    create_video_encoder_with_options, prefers_hardware_streaming_encoder_for_backend,
    encode_rgba_gop_chunk, encode_yuv_gop_chunk, prefers_hardware_streaming_encoder,
    rgba_to_yuv420p_bt709, EncodedVideoPacket, H264EncoderOptions, RustyH264VideoEncoder,
    VideoFrameEncoder,
};
