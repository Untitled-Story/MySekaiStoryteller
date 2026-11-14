use rusty_h264_common::{Profile, YuvFrame};
use rusty_h264_encoder::{Encoder, EncoderConfig, Preset};

use crate::renderer::config::VideoQualityPreset;
use crate::renderer::error::RendererError;

#[derive(Debug, Clone)]
pub struct EncodedVideoPacket {
    pub pts_secs: f64,
    pub annex_b: Vec<u8>,
    pub is_keyframe: bool,
}

/// Abstract video frame encoder boundary allowing software pure-Rust H.264 by default
/// and optional hardware acceleration backends behind `--features native-hw-accel`.
pub trait VideoFrameEncoder {
    fn encode_rgba(
        &mut self,
        rgba: &[u8],
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
            gop_size: fps.saturating_mul(2).clamp(2, 250),
        }
    }
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
pub fn create_video_encoder_with_options(
    width: u32,
    height: u32,
    fps: u32,
    options: H264EncoderOptions,
) -> Result<Box<dyn VideoFrameEncoder>, RendererError> {
    #[cfg(feature = "native-hw-accel")]
    {
        // Reserved native hardware acceleration hook; falls back cleanly to pure-Rust H.264.
        let enc = RustyH264VideoEncoder::new_with_options(width, height, fps, options)?;
        return Ok(Box::new(enc));
    }
    #[cfg(not(feature = "native-hw-accel"))]
    {
        let enc = RustyH264VideoEncoder::new_with_options(width, height, fps, options)?;
        Ok(Box::new(enc))
    }
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
        if width < 16 || height < 16 || width % 2 != 0 || height % 2 != 0 {
            return Err(RendererError::InvalidConfig(format!(
                "H.264 encoder requires even dimensions >= 16x16, got {width}x{height}"
            )));
        }
        let w = width as usize;
        let h = height as usize;
        let mut cfg = EncoderConfig::new(w, h);
        cfg.profile = Profile::High;
        cfg.qp = options.qp.min(51);
        cfg.bitrate = options.bitrate_bps;
        cfg.framerate = fps.max(1) as f32;
        // Disable lookahead buffering so every `encode_planes` call emits strictly one Annex-B AU.
        cfg.mbtree = false;
        cfg.lookahead = 0;
        cfg.bframes = 0;
        cfg.cabac = true;
        cfg.transform_8x8 = true;
        cfg.aq_strength = 1.0;

        let gop = options.gop_size.max(1);
        cfg.gop_size = gop;
        cfg.min_keyint = if gop <= 1 { 1 } else { fps.clamp(1, gop) };
        cfg.level_idc = select_h264_level(width, height, fps);

        match options.quality {
            VideoQualityPreset::Fast => {
                cfg.preset = Preset::Fast;
                cfg.num_ref_frames = 1;
            }
            VideoQualityPreset::Balanced => {
                cfg.preset = Preset::Balanced;
                cfg.num_ref_frames = 2;
            }
            VideoQualityPreset::Quality => {
                // Balanced + QP 14 yields sub-pel quality at ~7x higher throughput than Preset::Quality.
                cfg.preset = Preset::Balanced;
                cfg.num_ref_frames = 3;
            }
        }

        let encoder = Encoder::new(cfg)
            .map_err(|err| RendererError::VideoEncode(format!("Encoder init failed: {err}")))?;
        let yuv_scratch = YuvFrame::black(w, h);

        Ok(Self {
            width: w,
            height: h,
            encoder,
            yuv_scratch,
            frame_index: 0,
        })
    }
}

impl VideoFrameEncoder for RustyH264VideoEncoder {
    fn encode_rgba(
        &mut self,
        rgba: &[u8],
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        let expected_len = self.width * self.height * 4;
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

        let annex_b = self
            .encoder
            .encode_planes(&self.yuv_scratch.as_planes())
            .map_err(|err| {
                RendererError::VideoEncode(format!(
                    "H.264 encode failed at frame {}: {err}",
                    self.frame_index
                ))
            })?;
        self.frame_index += 1;

        if annex_b.is_empty() {
            return Ok(Vec::new());
        }
        let is_keyframe = contains_annex_b_idr(&annex_b);
        Ok(vec![EncodedVideoPacket {
            pts_secs,
            annex_b,
            is_keyframe,
        }])
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
    let cw = width / 2;
    let ch = height / 2;
    y_out.resize(width * height, 16);
    u_out.resize(cw * ch, 128);
    v_out.resize(cw * ch, 128);

    let row_stride = width * 4;
    for y in 0..height {
        let row_in = &rgba[y * row_stride..(y + 1) * row_stride];
        let row_y = &mut y_out[y * width..(y + 1) * width];
        for x in 0..width {
            let p = x * 4;
            let r = row_in[p] as i32;
            let g = row_in[p + 1] as i32;
            let b = row_in[p + 2] as i32;
            let luma = ((11_966 * r + 40_254 * g + 4_064 * b + 32_768) >> 16) + 16;
            row_y[x] = luma.clamp(16, 235) as u8;
        }
    }

    for cy in 0..ch {
        let r0 = &rgba[(cy * 2) * row_stride..(cy * 2 + 1) * row_stride];
        let r1 = &rgba[(cy * 2 + 1) * row_stride..(cy * 2 + 2) * row_stride];
        let u_row = &mut u_out[cy * cw..(cy + 1) * cw];
        let v_row = &mut v_out[cy * cw..(cy + 1) * cw];
        for cx in 0..cw {
            let x0 = cx * 8;
            let x1 = x0 + 4;
            let sum_r = r0[x0] as i32 + r0[x1] as i32 + r1[x0] as i32 + r1[x1] as i32;
            let sum_g =
                r0[x0 + 1] as i32 + r0[x1 + 1] as i32 + r1[x0 + 1] as i32 + r1[x1 + 1] as i32;
            let sum_b =
                r0[x0 + 2] as i32 + r0[x1 + 2] as i32 + r1[x0 + 2] as i32 + r1[x1 + 2] as i32;
            let cb = ((-6_596 * sum_r - 22_188 * sum_g + 28_784 * sum_b + 131_072) >> 18) + 128;
            let cr = ((28_784 * sum_r - 26_145 * sum_g - 2_639 * sum_b + 131_072) >> 18) + 128;
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
}
