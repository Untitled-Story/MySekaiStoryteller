pub mod audio_aac;
pub mod mp4_mux;
pub mod video_h264;

pub use audio_aac::{
    encode_interleaved_i16_parallel, AudioTrackEncoder, EncodedAudioPacket, OxideAacAudioEncoder,
};
pub use mp4_mux::Mp4MuxerWriter;
pub use video_h264::{
    contains_annex_b_idr, create_video_encoder, create_video_encoder_with_options,
    encode_rgba_gop_chunk, rgba_to_yuv420p_bt709, EncodedVideoPacket, H264EncoderOptions,
    RustyH264VideoEncoder, VideoFrameEncoder,
};
