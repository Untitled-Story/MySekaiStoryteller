use rusty_h264_common::{Profile, YuvFrame};
use rusty_h264_encoder::{Encoder, EncoderConfig, Preset};

use crate::renderer::config::{RenderBackend, VideoQualityPreset};
use crate::renderer::error::RendererError;

#[derive(Debug, Clone)]
pub struct EncodedVideoPacket {
    pub pts_secs: f64,
    pub annex_b: Vec<u8>,
    pub is_keyframe: bool,
}

/// Abstract video frame encoder boundary allowing software pure-Rust H.264 by default
/// and optional hardware acceleration backends behind `--features native-hw-accel`.
pub trait VideoFrameEncoder: Send {
    fn encode_rgba(
        &mut self,
        rgba: &[u8],
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError>;

    fn encode_yuv(
        &mut self,
        yuv: &YuvFrame,
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError>;

    fn finish(&mut self) -> Result<Vec<EncodedVideoPacket>, RendererError>;
}

#[derive(Debug, Clone, Copy)]
pub struct H264EncoderOptions {
    pub quality: VideoQualityPreset,
    pub qp: u8,
    pub bitrate_bps: u32,
    pub gop_size: u32,
}

impl H264EncoderOptions {
    pub fn from_quality(quality: VideoQualityPreset, fps: u32) -> Self {
        Self {
            quality,
            qp: quality.h264_qp(),
            bitrate_bps: 0,
            gop_size: (fps / 2).clamp(2, 30),
        }
    }
}

fn build_encoder_config(
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
    fixed_gop_frames: Option<u32>,
) -> Result<EncoderConfig, RendererError> {
    if width < 16 || height < 16 || width % 2 != 0 || height % 2 != 0 {
        return Err(RendererError::InvalidConfig(format!(
            "H.264 encoder requires even dimensions >= 16x16, got {width}x{height}"
        )));
    }
    let w: usize = width as usize;
    let h: usize = height as usize;
    let mut cfg: EncoderConfig = EncoderConfig::new(w, h);
    cfg.profile = Profile::High;
    cfg.qp = options.qp.min(51);
    cfg.bitrate = options.bitrate_bps;
    cfg.framerate = fps.max(1) as f32;
    cfg.mbtree = false;
    cfg.lookahead = 0;
    cfg.bframes = 0;
    cfg.cabac = true;
    cfg.transform_8x8 = true;
    cfg.aq_strength = 1.0;

    if let Some(chunk_len) = fixed_gop_frames {
        let len: u32 = chunk_len.max(1);
        cfg.scenecut = 0;
        cfg.gop_size = len;
        cfg.min_keyint = len;
    } else {
        let gop: u32 = options.gop_size.max(1);
        cfg.gop_size = gop;
        cfg.min_keyint = if gop <= 1 { 1 } else { fps.clamp(1, gop) };
    }
    cfg.level_idc = select_h264_level(width, height, fps);

    cfg.coded_path_v2 = true;
    match options.quality {
        VideoQualityPreset::Speed | VideoQualityPreset::Fast => {
            cfg.preset = Preset::Fast;
            cfg.num_ref_frames = 1;
            cfg.weightp = false;
            cfg.mbtree = false;
            cfg.scenecut = 0;
            cfg.lookahead = 0;
            cfg.cabac = false;
            cfg.profile = Profile::Baseline;
            cfg.aq_strength = 0.0;
            cfg.me_wide = Some(false);
            cfg.bframes = 0;
            cfg.cabac_rdoq = 0.0;
            cfg.cabac_rdoq_p = 0.0;
            cfg.tune_sub8x8_split = false;
            cfg.tune_sub8_rd = false;
            cfg.tune_shape_rd = false;
            cfg.tune_intra_rd = false;
        }
        VideoQualityPreset::Balanced | VideoQualityPreset::High => {
            cfg.preset = Preset::Fast;
            cfg.num_ref_frames = 1;
            cfg.weightp = false;
            cfg.cabac_rdoq = 0.0;
            cfg.cabac_rdoq_p = 0.0;
            cfg.tune_sub8x8_split = false;
            cfg.tune_sub8_rd = false;
            cfg.tune_shape_rd = false;
            cfg.tune_intra_rd = false;
        }
        VideoQualityPreset::Quality
        | VideoQualityPreset::NearLossless
        | VideoQualityPreset::Archive => {
            // Balanced + QP 14 yields sub-pel quality at ~7x higher throughput than Preset::Quality.
            cfg.preset = Preset::Balanced;
            cfg.num_ref_frames = 3;
        }
    }
    Ok(cfg)
}

fn validate_yuv_frame(
    yuv: &YuvFrame,
    width: usize,
    height: usize,
    frame_index: u64,
) -> Result<(), RendererError> {
    let expected_y: usize = width * height;
    let expected_uv: usize = (width / 2) * (height / 2);
    if yuv.width != width
        || yuv.height != height
        || yuv.y.len() != expected_y
        || yuv.u.len() != expected_uv
        || yuv.v.len() != expected_uv
    {
        return Err(RendererError::VideoEncode(format!(
            "YUV420p frame buffer size mismatch at frame {frame_index}: expected {width}x{height} ({expected_y}/{expected_uv}), got {}x{} ({}/{}/{})",
            yuv.width,
            yuv.height,
            yuv.y.len(),
            yuv.u.len(),
            yuv.v.len(),
        )));
    }
    Ok(())
}

/// Encodes one independent CQP GOP (`yuv_frames`, starting with an IDR frame at `base_frame_index`)
/// via `Encoder::encode_all`, enabling grain fast-path detection across the GOP without a second
/// RGBA->YUV conversion.
pub fn encode_yuv_gop_chunk(
    yuv_frames: &[YuvFrame],
    base_frame_index: u64,
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
) -> Result<Vec<EncodedVideoPacket>, RendererError> {
    if yuv_frames.is_empty() {
        return Ok(Vec::new());
    }
    let w: usize = width as usize;
    let h: usize = height as usize;
    for (idx, yuv) in yuv_frames.iter().enumerate() {
        validate_yuv_frame(yuv, w, h, base_frame_index + idx as u64)?;
    }
    let cfg: EncoderConfig =
        build_encoder_config(width, height, fps, options, Some(yuv_frames.len() as u32))?;
    let encoder: Encoder = Encoder::new(cfg)
        .map_err(|err| RendererError::VideoEncode(format!("Encoder init failed: {err}")))?;

    let aus: Vec<Vec<u8>> = encoder
        .encode_all(yuv_frames)
        .map_err(|err| RendererError::VideoEncode(format!("H.264 GOP encode failed: {err}")))?;

    let fps_f64: f64 = fps.max(1) as f64;
    let mut packets: Vec<EncodedVideoPacket> = Vec::with_capacity(aus.len());
    for (idx, annex_b) in aus.into_iter().enumerate() {
        if annex_b.is_empty() {
            continue;
        }
        let is_keyframe: bool = contains_annex_b_idr(&annex_b);
        let pts_secs: f64 = ((base_frame_index + idx as u64) as f64) / fps_f64;
        packets.push(EncodedVideoPacket {
            pts_secs,
            annex_b,
            is_keyframe,
        });
    }
    Ok(packets)
}

/// Encodes one independent CQP GOP (`rgba_frames`, starting with an IDR frame at `base_frame_index`)
/// via `Encoder::encode_all`, enabling grain fast-path detection across the GOP.
pub fn encode_rgba_gop_chunk(
    rgba_frames: &[Vec<u8>],
    base_frame_index: u64,
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
) -> Result<Vec<EncodedVideoPacket>, RendererError> {
    if rgba_frames.is_empty() {
        return Ok(Vec::new());
    }
    let w: usize = width as usize;
    let h: usize = height as usize;
    let expected_len: usize = w * h * 4;
    let cw: usize = w / 2;
    let ch: usize = h / 2;

    let mut yuv_frames: Vec<YuvFrame> = Vec::with_capacity(rgba_frames.len());
    for (idx, rgba) in rgba_frames.iter().enumerate() {
        if rgba.len() != expected_len {
            return Err(RendererError::VideoEncode(format!(
                "RGBA frame buffer size mismatch at frame {}: expected {expected_len}, got {}",
                base_frame_index + idx as u64,
                rgba.len()
            )));
        }
        let mut y: Vec<u8> = Vec::with_capacity(w * h);
        let mut u: Vec<u8> = Vec::with_capacity(cw * ch);
        let mut v: Vec<u8> = Vec::with_capacity(cw * ch);
        rgba_to_yuv420p_bt709(rgba, w, h, &mut y, &mut u, &mut v);
        yuv_frames.push(YuvFrame {
            width: w,
            height: h,
            y,
            u,
            v,
        });
    }

    encode_yuv_gop_chunk(&yuv_frames, base_frame_index, width, height, fps, options)
}

/// Returns `true` when the build targets a hardware streaming video encoder backend.
pub fn prefers_hardware_streaming_encoder() -> bool {
    cfg!(all(target_os = "macos", feature = "native-hw-accel"))
}

/// Factory returning the active video encoder backend.
pub fn create_video_encoder(
    width: u32,
    height: u32,
    fps: u32,
    quality: VideoQualityPreset,
) -> Result<Box<dyn VideoFrameEncoder>, RendererError> {
    create_video_encoder_with_options(
        width,
        height,
        fps,
        H264EncoderOptions::from_quality(quality, fps),
    )
}

/// Factory returning the active video encoder backend with explicit encoding options.
/// Returns whether the hardware streaming H.264 encoder is preferred for the given [`RenderBackend`].
pub fn prefers_hardware_streaming_encoder_for_backend(backend: RenderBackend) -> bool {
    if backend == RenderBackend::Cpu {
        return false;
    }
    prefers_hardware_streaming_encoder()
}

pub fn create_video_encoder_with_options(
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
) -> Result<Box<dyn VideoFrameEncoder>, RendererError> {
    create_video_encoder_for_backend(width, height, fps, options, RenderBackend::Auto)
}

/// Creates a video frame encoder honoring the requested [`RenderBackend`].
/// `RenderBackend::Cpu` forces pure-CPU H.264 encoding even when hardware acceleration is available.
pub fn create_video_encoder_for_backend(
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
    backend: RenderBackend,
) -> Result<Box<dyn VideoFrameEncoder>, RendererError> {
    #[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
    if backend != RenderBackend::Cpu {
        let enc: super::video_vt::VideoVtEncoder =
            super::video_vt::VideoVtEncoder::new_with_options(width, height, fps, options)?;
        return Ok(Box::new(enc));
    }
    let _ = backend;
    let enc: RustyH264VideoEncoder = RustyH264VideoEncoder::new_with_options(width, height, fps, options)?;
    Ok(Box::new(enc))
}

/// Pure-Rust software H.264 encoder powered by `rusty_h264_encoder`.
pub struct RustyH264VideoEncoder {
    width: usize,
    height: usize,
    encoder: Encoder,
    yuv_scratch: YuvFrame,
    frame_index: u64,
}

impl RustyH264VideoEncoder {
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        quality: VideoQualityPreset,
    ) -> Result<Self, RendererError> {
        Self::new_with_options(
            width,
            height,
            fps,
            H264EncoderOptions::from_quality(quality, fps),
        )
    }

    pub fn new_with_options(
        width: u32,
        height: u32,
        fps: u32,
        options: H264EncoderOptions,
    ) -> Result<Self, RendererError> {
        let w: usize = width as usize;
        let h: usize = height as usize;
        let cfg: EncoderConfig = build_encoder_config(width, height, fps, options, None)?;
        let encoder: Encoder = Encoder::new(cfg)
            .map_err(|err| RendererError::VideoEncode(format!("Encoder init failed: {err}")))?;
        let yuv_scratch: YuvFrame = YuvFrame::black(w, h);

        Ok(Self {
            width: w,
            height: h,
            encoder,
            yuv_scratch,
            frame_index: 0,
        })
    }
}

fn encode_yuv_planes(
    encoder: &mut Encoder,
    frame_index: &mut u64,
    yuv: &YuvFrame,
    pts_secs: f64,
) -> Result<Vec<EncodedVideoPacket>, RendererError> {
    let annex_b: Vec<u8> = encoder
        .encode_planes(&yuv.as_planes())
        .map_err(|err| {
            RendererError::VideoEncode(format!(
                "H.264 encode failed at frame {}: {err}",
                *frame_index
            ))
        })?;
    *frame_index += 1;

    if annex_b.is_empty() {
        return Ok(Vec::new());
    }
    let is_keyframe: bool = contains_annex_b_idr(&annex_b);
    Ok(vec![EncodedVideoPacket {
        pts_secs,
        annex_b,
        is_keyframe,
    }])
}

impl VideoFrameEncoder for RustyH264VideoEncoder {
    fn encode_rgba(
        &mut self,
        rgba: &[u8],
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        let expected_len: usize = self.width * self.height * 4;
        if rgba.len() != expected_len {
            return Err(RendererError::VideoEncode(format!(
                "RGBA frame buffer size mismatch: expected {expected_len}, got {}",
                rgba.len()
            )));
        }

        rgba_to_yuv420p_bt709(
            rgba,
            self.width,
            self.height,
            &mut self.yuv_scratch.y,
            &mut self.yuv_scratch.u,
            &mut self.yuv_scratch.v,
        );

        encode_yuv_planes(
            &mut self.encoder,
            &mut self.frame_index,
            &self.yuv_scratch,
            pts_secs,
        )
    }

    fn encode_yuv(
        &mut self,
        yuv: &YuvFrame,
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        validate_yuv_frame(yuv, self.width, self.height, self.frame_index)?;
        encode_yuv_planes(&mut self.encoder, &mut self.frame_index, yuv, pts_secs)
    }

    fn finish(&mut self) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        let trailing = self.encoder.flush();
        if trailing.is_empty() {
            Ok(Vec::new())
        } else {
            // mbtree = false + bframes = 0 already flushes synchronously on every encode_planes call.
            let is_keyframe = contains_annex_b_idr(&trailing);
            Ok(vec![EncodedVideoPacket {
                pts_secs: 0.0,
                annex_b: trailing,
                is_keyframe,
            }])
        }
    }
}

/// Converts tight `RGBA8` (`[R, G, B, A]`, already composited over black) into BT.709 limited-range
/// planar YUV420p (`Y: 16..235`, `Cb/Cr: 16..240`).
pub fn rgba_to_yuv420p_bt709(
    rgba: &[u8],
    width: usize,
    height: usize,
    y_out: &mut Vec<u8>,
    u_out: &mut Vec<u8>,
    v_out: &mut Vec<u8>,
) {
    let cw: usize = width / 2;
    let ch: usize = height / 2;
    y_out.resize(width * height, 16);
    u_out.resize(cw * ch, 128);
    v_out.resize(cw * ch, 128);

    let row_stride: usize = width * 4;
    for cy in 0..ch {
        let r0: &[u8] = &rgba[(cy * 2) * row_stride..(cy * 2 + 1) * row_stride];
        let r1: &[u8] = &rgba[(cy * 2 + 1) * row_stride..(cy * 2 + 2) * row_stride];
        let (y_top_slice, y_bot_slice) =
            y_out[(cy * 2) * width..(cy * 2 + 2) * width].split_at_mut(width);
        let u_row: &mut [u8] = &mut u_out[cy * cw..(cy + 1) * cw];
        let v_row: &mut [u8] = &mut v_out[cy * cw..(cy + 1) * cw];

        for cx in 0..cw {
            let x0: usize = cx * 8;
            let x1: usize = x0 + 4;
            let yx: usize = cx * 2;

            let r00: i32 = r0[x0] as i32;
            let g00: i32 = r0[x0 + 1] as i32;
            let b00: i32 = r0[x0 + 2] as i32;
            let r01: i32 = r0[x1] as i32;
            let g01: i32 = r0[x1 + 1] as i32;
            let b01: i32 = r0[x1 + 2] as i32;
            let r10: i32 = r1[x0] as i32;
            let g10: i32 = r1[x0 + 1] as i32;
            let b10: i32 = r1[x0 + 2] as i32;
            let r11: i32 = r1[x1] as i32;
            let g11: i32 = r1[x1 + 1] as i32;
            let b11: i32 = r1[x1 + 2] as i32;

            y_top_slice[yx] =
                (((11_966 * r00 + 40_254 * g00 + 4_064 * b00 + 32_768) >> 16) + 16).clamp(16, 235)
                    as u8;
            y_top_slice[yx + 1] =
                (((11_966 * r01 + 40_254 * g01 + 4_064 * b01 + 32_768) >> 16) + 16).clamp(16, 235)
                    as u8;
            y_bot_slice[yx] =
                (((11_966 * r10 + 40_254 * g10 + 4_064 * b10 + 32_768) >> 16) + 16).clamp(16, 235)
                    as u8;
            y_bot_slice[yx + 1] =
                (((11_966 * r11 + 40_254 * g11 + 4_064 * b11 + 32_768) >> 16) + 16).clamp(16, 235)
                    as u8;

            let sum_r: i32 = r00 + r01 + r10 + r11;
            let sum_g: i32 = g00 + g01 + g10 + g11;
            let sum_b: i32 = b00 + b01 + b10 + b11;
            let cb: i32 =
                ((-6_596 * sum_r - 22_188 * sum_g + 28_784 * sum_b + 131_072) >> 18) + 128;
            let cr: i32 =
                ((28_784 * sum_r - 26_145 * sum_g - 2_639 * sum_b + 131_072) >> 18) + 128;
            u_row[cx] = cb.clamp(16, 240) as u8;
            v_row[cx] = cr.clamp(16, 240) as u8;
        }
    }
}

/// Scans an Annex-B access unit for an IDR slice NAL unit (`nal_unit_type == 5`).
pub fn contains_annex_b_idr(annex_b: &[u8]) -> bool {
    let mut i = 0;
    let len = annex_b.len();
    while i + 3 < len {
        if annex_b[i] == 0 && annex_b[i + 1] == 0 {
            let nal_offset = if annex_b[i + 2] == 1 {
                Some(i + 3)
            } else if i + 4 < len && annex_b[i + 2] == 0 && annex_b[i + 3] == 1 {
                Some(i + 4)
            } else {
                None
            };
            if let Some(off) = nal_offset {
                if (annex_b[off] & 0x1F) == 5 {
                    return true;
                }
                i = off + 1;
                continue;
            }
        }
        i += 1;
    }
    false
}

fn select_h264_level(width: u32, height: u32, fps: u32) -> u8 {
    let macroblocks_per_frame = width.div_ceil(16) * height.div_ceil(16);
    let mb_per_sec = macroblocks_per_frame.saturating_mul(fps);
    if width <= 1280 && height <= 720 && mb_per_sec <= 108_000 {
        31 // Level 3.1
    } else if macroblocks_per_frame <= 8_192 && mb_per_sec <= 245_760 {
        40 // Level 4.0 (1080p30)
    } else if macroblocks_per_frame <= 8_704 && mb_per_sec <= 522_240 {
        42 // Level 4.2 (1080p60)
    } else if macroblocks_per_frame <= 36_864 && mb_per_sec <= 983_040 {
        51 // Level 5.1 (4K30 / 1080p120)
    } else if macroblocks_per_frame <= 36_864 && mb_per_sec <= 2_073_600 {
        52 // Level 5.2 (4K60)
    } else {
        60 // Level 6.0 (4K120)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusty_h264_decoder::Decoder;

    #[test]
    fn bt709_conversion_maps_black_white_and_neutral_gray_cleanly() {
        let rgba = [
            0, 0, 0, 255, // black
            255, 255, 255, 255, // white
            128, 128, 128, 255, // neutral gray
            128, 128, 128, 255,
        ];
        let mut y = Vec::new();
        let mut u = Vec::new();
        let mut v = Vec::new();
        rgba_to_yuv420p_bt709(&rgba, 2, 2, &mut y, &mut u, &mut v);
        assert_eq!(y[0], 16);
        assert_eq!(y[1], 235);
        assert_eq!(u.len(), 1);
        assert_eq!(v.len(), 1);
        assert!((u[0] as i32 - 128).abs() <= 1);
        assert!((v[0] as i32 - 128).abs() <= 1);
    }

    #[test]
    fn h264_encoder_roundtrips_through_pure_rust_decoder() {
        let mut enc =
            RustyH264VideoEncoder::new(64, 64, 30, VideoQualityPreset::Balanced).expect("init");
        let mut bitstream = Vec::new();
        for f in 0..8u8 {
            let mut rgba = vec![0u8; 64 * 64 * 4];
            for px in rgba.chunks_exact_mut(4) {
                px[0] = f.saturating_mul(25);
                px[1] = 100;
                px[2] = 200u8.saturating_sub(f.saturating_mul(15));
                px[3] = 255;
            }
            let pkts = enc.encode_rgba(&rgba, f as f64 / 30.0).expect("encode");
            assert_eq!(pkts.len(), 1);
            if f == 0 {
                assert!(pkts[0].is_keyframe);
            }
            bitstream.extend_from_slice(&pkts[0].annex_b);
        }
        for pkt in enc.finish().expect("finish") {
            bitstream.extend_from_slice(&pkt.annex_b);
        }

        let mut dec = Decoder::new();
        let decoded = dec.decode_stream(&bitstream).expect("decode H.264 stream");
        assert_eq!(decoded.len(), 8);
        assert_eq!(decoded[0].width, 64);
        assert_eq!(decoded[0].height, 64);
    }

    #[test]
    fn h264_encoder_supports_abr_and_all_intra_gop_roundtrip() {
        let mut enc = RustyH264VideoEncoder::new_with_options(
            64,
            64,
            120,
            H264EncoderOptions {
                quality: VideoQualityPreset::Fast,
                qp: 22,
                bitrate_bps: 400_000,
                gop_size: 1,
            },
        )
        .expect("init abr/intra");
        let mut bitstream = Vec::new();
        for f in 0..4u8 {
            let mut rgba = vec![0u8; 64 * 64 * 4];
            for px in rgba.chunks_exact_mut(4) {
                px[0] = f.saturating_mul(40);
                px[1] = 160;
                px[2] = 90;
                px[3] = 255;
            }
            let pkts = enc.encode_rgba(&rgba, f as f64 / 120.0).expect("encode");
            assert_eq!(pkts.len(), 1);
            assert!(
                pkts[0].is_keyframe,
                "gop_size=1 must make every frame an IDR"
            );
            bitstream.extend_from_slice(&pkts[0].annex_b);
        }
        for pkt in enc.finish().expect("finish") {
            bitstream.extend_from_slice(&pkt.annex_b);
        }
        let mut dec = Decoder::new();
        let decoded = dec
            .decode_stream(&bitstream)
            .expect("decode abr/intra stream");
        assert_eq!(decoded.len(), 4);
    }
    /// 4K micro-benchmark: how expensive is encoding a frame that is byte-identical to its
        /// predecessor, compared with one that has motion? Answers whether a duplicate-frame
        /// fast path has anything left to save (the encoder may already emit P_Skip cheaply).
        #[test]
        #[ignore = "4K identical vs moving frame encode cost"]
        fn bench_4k_identical_vs_moving() {
            use std::time::Instant;

            const W: u32 = 3840;
            const H: u32 = 2160;
            const FPS: u32 = 60;
            const FRAMES: usize = 30;

            let w: usize = W as usize;
            let h: usize = H as usize;

            fn build(w: usize, h: usize) -> YuvFrame {
                let mut y: Vec<u8> = vec![0u8; w * h];
                for row in 0..h {
                    for col in 0..w {
                        y[row * w + col] = ((((row / 8) + (col / 8)) % 2) * 40 + 60) as u8;
                    }
                }
                YuvFrame {
                    width: w,
                    height: h,
                    y,
                    u: vec![128u8; (w / 2) * (h / 2)],
                    v: vec![128u8; (w / 2) * (h / 2)],
                }
            }

            let opts: H264EncoderOptions = H264EncoderOptions {
                quality: VideoQualityPreset::Balanced,
                qp: 19,
                bitrate_bps: 0,
                gop_size: 15,
            };

            let frame: YuvFrame = build(w, h);
            let mut enc = RustyH264VideoEncoder::new_with_options(W, H, FPS, opts).expect("init");
            let started: Instant = Instant::now();
            let mut first_secs: f64 = 0.0;
            for i in 0..FRAMES {
                let t: Instant = Instant::now();
                let _ = enc.encode_yuv(&frame, i as f64 / FPS as f64).expect("enc");
                if i == 0 {
                    first_secs = t.elapsed().as_secs_f64();
                }
            }
            let _ = enc.finish().expect("finish");
            let total: f64 = started.elapsed().as_secs_f64();
            eprintln!(
                "[IDENTICAL] frames={FRAMES} total={total:.3}s ms_per_frame={:.1} idr={:.1}ms p_frames_avg={:.1}ms",
                total * 1000.0 / FRAMES as f64,
                first_secs * 1000.0,
                (total - first_secs) * 1000.0 / (FRAMES as f64 - 1.0)
            );

            let mut moving: YuvFrame = build(w, h);
            let mut enc2 = RustyH264VideoEncoder::new_with_options(W, H, FPS, opts).expect("init");
            let started2: Instant = Instant::now();
            let mut first2: f64 = 0.0;
            for i in 0..FRAMES {
                let band_top: usize = (i * 37) % (h - 64);
                for row in band_top..(band_top + 64) {
                    let base: usize = row * w;
                    for col in 0..w {
                        moving.y[base + col] = ((row + i * 3) % 200 + 20) as u8;
                    }
                }
                let t: Instant = Instant::now();
                let _ = enc2.encode_yuv(&moving, i as f64 / FPS as f64).expect("enc");
                if i == 0 {
                    first2 = t.elapsed().as_secs_f64();
                }
            }
            let _ = enc2.finish().expect("finish");
            let total2: f64 = started2.elapsed().as_secs_f64();
            eprintln!(
                "[MOVING] frames={FRAMES} total={total2:.3}s ms_per_frame={:.1} idr={:.1}ms p_frames_avg={:.1}ms",
                total2 * 1000.0 / FRAMES as f64,
                first2 * 1000.0,
                (total2 - first2) * 1000.0 / (FRAMES as f64 - 1.0)
            );
        }
        /// 4K measurement: cost of constructing an `Encoder` (per-GOP-chunk today) versus
            /// encoding work, to judge whether per-worker encoder reuse is worth it.
            #[test]
            #[ignore = "4K encoder construction cost"]
            fn bench_4k_encoder_init_cost() {
                use std::time::Instant;

                const W: u32 = 3840;
                const H: u32 = 2160;
                const FPS: u32 = 60;
                const INIT_CALLS: usize = 20;

                let opts: H264EncoderOptions = H264EncoderOptions {
                    quality: VideoQualityPreset::Balanced,
                    qp: 19,
                    bitrate_bps: 0,
                    gop_size: 15,
                };

                let started: Instant = Instant::now();
                for _ in 0..INIT_CALLS {
                    let _enc = RustyH264VideoEncoder::new_with_options(W, H, FPS, opts).expect("init");
                }
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[INIT COST] calls={INIT_CALLS} total={secs:.3}s per_init={:.2}ms per_chunk_frame_cost_if_15={:.2}ms",
                    secs * 1000.0 / INIT_CALLS as f64,
                    secs * 1000.0 / INIT_CALLS as f64 / 15.0
                );
            }

    #[test]
    fn fused_bt709_conversion_matches_reference() {
        let w: usize = 16;
        let h: usize = 12;
        let mut rgba: Vec<u8> = vec![0; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let idx: usize = (y * w + x) * 4;
                rgba[idx] = ((x * 17 + y * 31) % 256) as u8;
                rgba[idx + 1] = ((x * 43 + y * 13 + 77) % 256) as u8;
                rgba[idx + 2] = ((x * 7 + y * 59 + 199) % 256) as u8;
                rgba[idx + 3] = 255;
            }
        }

        let mut y_fused: Vec<u8> = Vec::new();
        let mut u_fused: Vec<u8> = Vec::new();
        let mut v_fused: Vec<u8> = Vec::new();
        rgba_to_yuv420p_bt709(&rgba, w, h, &mut y_fused, &mut u_fused, &mut v_fused);

        let cw: usize = w / 2;
        let ch: usize = h / 2;
        let mut y_ref: Vec<u8> = vec![16; w * h];
        let mut u_ref: Vec<u8> = vec![128; cw * ch];
        let mut v_ref: Vec<u8> = vec![128; cw * ch];
        for y in 0..h {
            for x in 0..w {
                let p: usize = (y * w + x) * 4;
                let r: i32 = rgba[p] as i32;
                let g: i32 = rgba[p + 1] as i32;
                let b: i32 = rgba[p + 2] as i32;
                y_ref[y * w + x] =
                    (((11_966 * r + 40_254 * g + 4_064 * b + 32_768) >> 16) + 16).clamp(16, 235)
                        as u8;
            }
        }
        for cy in 0..ch {
            for cx in 0..cw {
                let p00: usize = ((cy * 2) * w + cx * 2) * 4;
                let p01: usize = ((cy * 2) * w + cx * 2 + 1) * 4;
                let p10: usize = ((cy * 2 + 1) * w + cx * 2) * 4;
                let p11: usize = ((cy * 2 + 1) * w + cx * 2 + 1) * 4;
                let sr: i32 = rgba[p00] as i32
                    + rgba[p01] as i32
                    + rgba[p10] as i32
                    + rgba[p11] as i32;
                let sg: i32 = rgba[p00 + 1] as i32
                    + rgba[p01 + 1] as i32
                    + rgba[p10 + 1] as i32
                    + rgba[p11 + 1] as i32;
                let sb: i32 = rgba[p00 + 2] as i32
                    + rgba[p01 + 2] as i32
                    + rgba[p10 + 2] as i32
                    + rgba[p11 + 2] as i32;
                u_ref[cy * cw + cx] =
                    (((-6_596 * sr - 22_188 * sg + 28_784 * sb + 131_072) >> 18) + 128)
                        .clamp(16, 240) as u8;
                v_ref[cy * cw + cx] =
                    (((28_784 * sr - 26_145 * sg - 2_639 * sb + 131_072) >> 18) + 128)
                        .clamp(16, 240) as u8;
            }
        }

        assert_eq!(y_fused, y_ref);
        assert_eq!(u_fused, u_ref);
        assert_eq!(v_fused, v_ref);
    }

    #[test]
    fn parallel_gop_matches_sequential_decodability_and_frame_count() {
        let mut frames: Vec<Vec<u8>> = Vec::with_capacity(6);
        for i in 0..6_u8 {
            let mut f: Vec<u8> = vec![0; 64 * 64 * 4];
            for px in f.chunks_exact_mut(4) {
                px[0] = 30 + i * 25;
                px[1] = 200 - i * 15;
                px[2] = 60 + i * 20;
                px[3] = 255;
            }
            frames.push(f);
        }

        let opts: H264EncoderOptions = H264EncoderOptions::from_quality(VideoQualityPreset::Balanced, 30);
        let gop0: Vec<EncodedVideoPacket> =
            encode_rgba_gop_chunk(&frames[0..3], 0, 64, 64, 30, opts).expect("encode gop0");
        let gop1: Vec<EncodedVideoPacket> =
            encode_rgba_gop_chunk(&frames[3..6], 3, 64, 64, 30, opts).expect("encode gop1");

        assert!(gop0.first().map(|p| p.is_keyframe).unwrap_or(false));
        assert!(gop1.first().map(|p| p.is_keyframe).unwrap_or(false));

        let mut combined: Vec<u8> = Vec::new();
        let mut all_pts: Vec<f64> = Vec::new();
        for pkt in gop0.into_iter().chain(gop1.into_iter()) {
            all_pts.push(pkt.pts_secs);
            combined.extend_from_slice(&pkt.annex_b);
        }
        assert_eq!(all_pts.len(), 6);
        for idx in 1..all_pts.len() {
            assert!(all_pts[idx] > all_pts[idx - 1]);
        }

        let mut dec = Decoder::new();
        let decoded = dec
            .decode_stream(&combined)
            .expect("decode concatenated parallel gops");
        assert_eq!(decoded.len(), 6);
    }
}
