use std::ffi::c_void;
use std::ptr;
use std::sync::Mutex;

use rusty_h264_common::YuvFrame;

use super::video_h264::{
    rgba_to_yuv420p_bt709, EncodedVideoPacket, H264EncoderOptions, VideoFrameEncoder,
};
use crate::renderer::error::RendererError;

type OSStatus = i32;
type CVReturn = i32;
type CFIndex = isize;
type Boolean = u8;
type CMVideoCodecType = u32;
type FourCharCode = u32;
type VTEncodeInfoFlags = u32;

const K_CM_VIDEO_CODEC_TYPE_H264: CMVideoCodecType = u32::from_be_bytes(*b"avc1");
const K_CM_VIDEO_CODEC_TYPE_HEVC: CMVideoCodecType = u32::from_be_bytes(*b"hvc1");
const K_CV_PIXEL_FORMAT_420_BIPLANAR_VIDEO_RANGE: FourCharCode = u32::from_be_bytes(*b"420v");
const K_CF_NUMBER_SINT32_TYPE: CFIndex = 3;
const K_CM_TIME_FLAGS_VALID: u32 = 1;
const K_VT_TIME_SCALE: i32 = 600_000;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

impl CMTime {
    const INVALID: Self = Self {
        value: 0,
        timescale: 0,
        flags: 0,
        epoch: 0,
    };

    fn from_secs(pts_secs: f64) -> Self {
        let value: i64 = (pts_secs * K_VT_TIME_SCALE as f64).round() as i64;
        Self {
            value,
            timescale: K_VT_TIME_SCALE,
            flags: K_CM_TIME_FLAGS_VALID,
            epoch: 0,
        }
    }
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    static kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: *const c_void;
    static kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder: *const c_void;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: *const c_void;
    static kVTCompressionPropertyKey_RealTime: *const c_void;
    static kVTCompressionPropertyKey_MaximizePowerEfficiency: *const c_void;
    static kVTCompressionPropertyKey_AllowFrameReordering: *const c_void;
    static kVTCompressionPropertyKey_ProfileLevel: *const c_void;
    static kVTProfileLevel_H264_High_AutoLevel: *const c_void;
    static kVTProfileLevel_HEVC_Main_AutoLevel: *const c_void;
    static kVTCompressionPropertyKey_MaxKeyFrameInterval: *const c_void;
    static kVTCompressionPropertyKey_ExpectedFrameRate: *const c_void;
    static kVTCompressionPropertyKey_AverageBitRate: *const c_void;
    static kVTCompressionPropertyKey_ColorPrimaries: *const c_void;
    static kVTCompressionPropertyKey_TransferFunction: *const c_void;
    static kVTCompressionPropertyKey_YCbCrMatrix: *const c_void;

    fn VTCompressionSessionCreate(
        allocator: *const c_void,
        width: i32,
        height: i32,
        codec_type: CMVideoCodecType,
        encoder_specification: *const c_void,
        source_image_buffer_attributes: *const c_void,
        compressed_data_allocator: *const c_void,
        output_callback: extern "C" fn(*mut c_void, *mut c_void, OSStatus, VTEncodeInfoFlags, *const c_void),
        output_callback_ref_con: *mut c_void,
        compression_session_out: *mut *mut c_void,
    ) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: *mut c_void) -> OSStatus;
    fn VTCompressionSessionGetPixelBufferPool(session: *mut c_void) -> *mut c_void;
    fn VTCompressionSessionEncodeFrame(
        session: *mut c_void,
        image_buffer: *mut c_void,
        presentation_time_stamp: CMTime,
        duration: CMTime,
        frame_properties: *const c_void,
        source_frame_ref_con: *mut c_void,
        info_flags_out: *mut VTEncodeInfoFlags,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(
        session: *mut c_void,
        complete_until_presentation_time_stamp: CMTime,
    ) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: *mut c_void);
    fn VTSessionSetProperty(
        session: *mut c_void,
        property_key: *const c_void,
        property_value: *const c_void,
    ) -> OSStatus;
    fn VTSessionCopyProperty(
        session: *mut c_void,
        property_key: *const c_void,
        allocator: *const c_void,
        property_value_out: *mut *const c_void,
    ) -> OSStatus;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: *const c_void;
    static kCVPixelBufferWidthKey: *const c_void;
    static kCVPixelBufferHeightKey: *const c_void;
    static kCVPixelBufferIOSurfacePropertiesKey: *const c_void;
    static kCVPixelBufferPoolMinimumBufferCountKey: *const c_void;
    static kCVImageBufferColorPrimaries_ITU_R_709_2: *const c_void;
    static kCVImageBufferTransferFunction_ITU_R_709_2: *const c_void;
    static kCVImageBufferYCbCrMatrix_ITU_R_709_2: *const c_void;

    fn CVPixelBufferPoolCreatePixelBuffer(
        allocator: *const c_void,
        pixel_buffer_pool: *mut c_void,
        pixel_buffer_out: *mut *mut c_void,
    ) -> CVReturn;
    fn CVPixelBufferLockBaseAddress(pixel_buffer: *mut c_void, lock_flags: u64) -> CVReturn;
    fn CVPixelBufferUnlockBaseAddress(pixel_buffer: *mut c_void, unlock_flags: u64) -> CVReturn;
    fn CVPixelBufferGetBaseAddressOfPlane(pixel_buffer: *mut c_void, plane_index: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer: *mut c_void, plane_index: usize) -> usize;
    fn CVPixelBufferRelease(pixel_buffer: *mut c_void);
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    static kCMSampleAttachmentKey_NotSync: *const c_void;

    fn CMSampleBufferGetDataBuffer(sbuf: *const c_void) -> *const c_void;
    fn CMSampleBufferGetFormatDescription(sbuf: *const c_void) -> *const c_void;
    fn CMSampleBufferGetPresentationTimeStamp(sbuf: *const c_void) -> CMTime;
    fn CMSampleBufferGetSampleAttachmentsArray(
        sbuf: *const c_void,
        create_if_necessary: Boolean,
    ) -> *const c_void;
    fn CMBlockBufferGetDataLength(the_buffer: *const c_void) -> usize;
    fn CMBlockBufferCopyDataBytes(
        the_source_buffer: *const c_void,
        offset_to_data: usize,
        data_length: usize,
        destination: *mut u8,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        video_desc: *const c_void,
        parameter_set_index: usize,
        parameter_set_pointer_out: *mut *const u8,
        parameter_set_size_out: *mut usize,
        parameter_set_count_out: *mut usize,
        nal_unit_header_length_out: *mut i32,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        video_desc: *const c_void,
        parameter_set_index: usize,
        parameter_set_pointer_out: *mut *const u8,
        parameter_set_size_out: *mut usize,
        parameter_set_count_out: *mut usize,
        nal_unit_header_length_out: *mut i32,
    ) -> OSStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const c_void;
    static kCFBooleanFalse: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;

    fn CFRelease(cf: *const c_void);
    fn CFNumberCreate(
        allocator: *const c_void,
        the_type: CFIndex,
        value_ptr: *const c_void,
    ) -> *const c_void;
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        num_values: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
    fn CFDictionaryGetValueIfPresent(
        the_dict: *const c_void,
        key: *const c_void,
        value: *mut *const c_void,
    ) -> Boolean;
    fn CFArrayGetCount(the_array: *const c_void) -> CFIndex;
    fn CFArrayGetValueAtIndex(the_array: *const c_void, idx: CFIndex) -> *const c_void;
}

struct CfOwned(*const c_void);

impl Drop for CfOwned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_number_i32(val: i32) -> Result<CfOwned, RendererError> {
    let cf: *const c_void = unsafe {
        CFNumberCreate(
            ptr::null(),
            K_CF_NUMBER_SINT32_TYPE,
            (&val as *const i32).cast::<c_void>(),
        )
    };
    if cf.is_null() {
        return Err(RendererError::VideoEncode(
            "CFNumberCreate(i32) failed".to_string(),
        ));
    }
    Ok(CfOwned(cf))
}

fn cf_dict(keys: &[*const c_void], values: &[*const c_void]) -> Result<CfOwned, RendererError> {
    debug_assert_eq!(keys.len(), values.len());
    let dict: *const c_void = unsafe {
        CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        )
    };
    if dict.is_null() {
        return Err(RendererError::VideoEncode(
            "CFDictionaryCreate failed".to_string(),
        ));
    }
    Ok(CfOwned(dict))
}

#[derive(Default)]
struct VtCallbackOutput {
    packets: Vec<EncodedVideoPacket>,
    error: Option<String>,
    scratch_avcc: Vec<u8>,
}

struct VtCallbackState {
    output: Mutex<VtCallbackOutput>,
    codec: VtCodec,
}

fn vt_is_keyframe(sample_buffer: *const c_void) -> bool {
    let attachments: *const c_void =
        unsafe { CMSampleBufferGetSampleAttachmentsArray(sample_buffer, 0) };
    if attachments.is_null() {
        return true;
    }
    let count: CFIndex = unsafe { CFArrayGetCount(attachments) };
    if count <= 0 {
        return true;
    }
    let dict: *const c_void = unsafe { CFArrayGetValueAtIndex(attachments, 0) };
    if dict.is_null() {
        return true;
    }
    let mut not_sync_val: *const c_void = ptr::null();
    let present: Boolean = unsafe {
        CFDictionaryGetValueIfPresent(dict, kCMSampleAttachmentKey_NotSync, &mut not_sync_val)
    };
    if present == 0 {
        return true;
    }
    unsafe { not_sync_val != kCFBooleanTrue }
}

fn append_parameter_sets(
    codec: VtCodec,
    fmt_desc: *const c_void,
    annex_b_out: &mut Vec<u8>,
) -> Result<usize, OSStatus> {
    if fmt_desc.is_null() {
        return Ok(4);
    }
    let mut param_count: usize = 0;
    let mut nal_header_len: i32 = 4;
    let status: OSStatus = unsafe {
        match codec {
            VtCodec::H264 => CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt_desc,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut param_count,
                &mut nal_header_len,
            ),
            VtCodec::Hevc => CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                fmt_desc,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut param_count,
                &mut nal_header_len,
            ),
        }
    };
    if status != 0 {
        return Err(status);
    }
    for idx in 0..param_count {
        let mut ptr_out: *const u8 = ptr::null();
        let mut size_out: usize = 0;
        let ps_status: OSStatus = unsafe {
            match codec {
                VtCodec::H264 => CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    fmt_desc,
                    idx,
                    &mut ptr_out,
                    &mut size_out,
                    ptr::null_mut(),
                    ptr::null_mut(),
                ),
                VtCodec::Hevc => CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                    fmt_desc,
                    idx,
                    &mut ptr_out,
                    &mut size_out,
                    ptr::null_mut(),
                    ptr::null_mut(),
                ),
            }
        };
        if ps_status != 0 {
            return Err(ps_status);
        }
        if !ptr_out.is_null() && size_out > 0 {
            annex_b_out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
            let slice: &[u8] = unsafe { std::slice::from_raw_parts(ptr_out, size_out) };
            annex_b_out.extend_from_slice(slice);
        }
    }
    Ok(nal_header_len.clamp(1, 4) as usize)
}

extern "C" fn vt_output_callback(
    output_callback_ref_con: *mut c_void,
    _source_frame_ref_con: *mut c_void,
    status: OSStatus,
    _info_flags: VTEncodeInfoFlags,
    sample_buffer: *const c_void,
) {
    if output_callback_ref_con.is_null() {
        return;
    }
    let state: &VtCallbackState = unsafe { &*output_callback_ref_con.cast::<VtCallbackState>() };
    let Ok(mut guard) = state.output.lock() else {
        return;
    };
    if status != 0 {
        if guard.error.is_none() {
            guard.error = Some(format!("VideoToolbox encode callback error: OSStatus={status}"));
        }
        return;
    }
    if sample_buffer.is_null() {
        return;
    }

    let is_keyframe: bool = vt_is_keyframe(sample_buffer);
    let cm_pts: CMTime = unsafe { CMSampleBufferGetPresentationTimeStamp(sample_buffer) };
    let pts_secs: f64 = if cm_pts.timescale > 0 {
        (cm_pts.value as f64) / (cm_pts.timescale as f64)
    } else {
        0.0
    };

    let mut annex_b: Vec<u8> = Vec::new();
    let mut nal_header_len: usize = 4;
    if is_keyframe {
        let fmt_desc: *const c_void =
            unsafe { CMSampleBufferGetFormatDescription(sample_buffer) };
        match append_parameter_sets(state.codec, fmt_desc, &mut annex_b) {
            Ok(hdr) => nal_header_len = hdr,
            Err(err_code) => {
                if guard.error.is_none() {
                    guard.error = Some(format!(
                        "VideoToolbox parameter-set extraction failed for {}: OSStatus={err_code}",
                        state.codec.label()
                    ));
                }
                return;
            }
        }
    }

    let data_buf: *const c_void = unsafe { CMSampleBufferGetDataBuffer(sample_buffer) };
    if data_buf.is_null() {
        if !annex_b.is_empty() {
            guard.packets.push(EncodedVideoPacket {
                pts_secs,
                annex_b,
                is_keyframe,
            });
        }
        return;
    }

    let total_len: usize = unsafe { CMBlockBufferGetDataLength(data_buf) };
    if total_len == 0 {
        return;
    }

    let mut avcc_tmp: Vec<u8> = std::mem::take(&mut guard.scratch_avcc);
    avcc_tmp.resize(total_len, 0);
    let copy_status: OSStatus =
        unsafe { CMBlockBufferCopyDataBytes(data_buf, 0, total_len, avcc_tmp.as_mut_ptr()) };
    if copy_status != 0 {
        guard.scratch_avcc = avcc_tmp;
        if guard.error.is_none() {
            guard.error = Some(format!("CMBlockBufferCopyDataBytes failed: {copy_status}"));
        }
        return;
    }

    annex_b.reserve(total_len + 16);
    let mut pos: usize = 0;
    while pos + nal_header_len <= total_len {
        let mut nal_len: usize = 0;
        for b_idx in 0..nal_header_len {
            nal_len = (nal_len << 8) | (avcc_tmp[pos + b_idx] as usize);
        }
        pos += nal_header_len;
        if nal_len == 0 || pos + nal_len > total_len {
            break;
        }
        annex_b.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        annex_b.extend_from_slice(&avcc_tmp[pos..pos + nal_len]);
        pos += nal_len;
    }
    guard.scratch_avcc = avcc_tmp;

    guard.packets.push(EncodedVideoPacket {
        pts_secs,
        annex_b,
        is_keyframe,
    });
}

fn copy_plane_bytes(
    src: &[u8],
    src_stride: usize,
    dst_ptr: *mut u8,
    dst_stride: usize,
    rows: usize,
) {
    if dst_ptr.is_null() || rows == 0 {
        return;
    }
    if src_stride == dst_stride {
        let total: usize = src_stride * rows;
        debug_assert!(src.len() >= total);
        unsafe { ptr::copy_nonoverlapping(src.as_ptr(), dst_ptr, total) };
        return;
    }
    let copy_len: usize = src_stride.min(dst_stride);
    for row in 0..rows {
        let src_off: usize = row * src_stride;
        let dst_off: usize = row * dst_stride;
        unsafe {
            ptr::copy_nonoverlapping(src.as_ptr().add(src_off), dst_ptr.add(dst_off), copy_len);
        }
    }
}

/// Interleaves planar U and V (`cw` x `ch`) into NV12 bi-planar chroma plane (`dst_stride` bytes/row).
unsafe fn copy_uv_interleaved_nv12(
    u: &[u8],
    v: &[u8],
    cw: usize,
    dst_ptr: *mut u8,
    dst_stride: usize,
    ch: usize,
) {
    for row in 0..ch {
        let src_off: usize = row * cw;
        let u_row: *const u8 = u.as_ptr().add(src_off);
        let v_row: *const u8 = v.as_ptr().add(src_off);
        let dst_row: *mut u8 = dst_ptr.add(row * dst_stride);
        let mut x: usize = 0;

        #[cfg(target_arch = "aarch64")]
        {
            use std::arch::aarch64::{uint8x16x2_t, vld1q_u8, vst2q_u8};
            while x + 16 <= cw {
                let vu = vld1q_u8(u_row.add(x));
                let vv = vld1q_u8(v_row.add(x));
                vst2q_u8(dst_row.add(x * 2), uint8x16x2_t(vu, vv));
                x += 16;
            }
        }

        while x < cw {
            *dst_row.add(x * 2) = *u_row.add(x);
            *dst_row.add(x * 2 + 1) = *v_row.add(x);
            x += 1;
        }
    }
}

fn default_vt_bitrate_bps(width: u32, height: u32, fps: u32, qp: u8) -> u32 {
    let pixels_per_sec: f64 = (width as f64) * (height as f64) * (fps.max(1) as f64);
    let bpp: f64 = if qp <= 15 {
        0.11
    } else if qp <= 20 {
        0.068
    } else {
        0.042
    };
    (pixels_per_sec * bpp).clamp(500_000.0, 80_000_000.0) as u32
}

/// Video codec to use with the platform hardware encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VtCodec {
    /// H.264/AVC (`avc1`, High profile).
    H264,
    /// H.265/HEVC (`hvc1`, Main profile). Emits VPS/SPS/PPS with the first keyframe,
    /// which is what `muxide`'s HEVC path requires.
    Hevc,
}

impl VtCodec {
    fn codec_type(self) -> CMVideoCodecType {
        match self {
            Self::H264 => K_CM_VIDEO_CODEC_TYPE_H264,
            Self::Hevc => K_CM_VIDEO_CODEC_TYPE_HEVC,
        }
    }

    unsafe fn profile_level(self) -> *const c_void {
        match self {
            Self::H264 => kVTProfileLevel_H264_High_AutoLevel,
            Self::Hevc => kVTProfileLevel_HEVC_Main_AutoLevel,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::H264 => "H.264",
            Self::Hevc => "HEVC",
        }
    }
}

/// Hardware-accelerated macOS VideoToolbox encoder writing directly from
/// `CVPixelBufferPool` (`420v` bi-planar YUV420p) to Annex-B packets without B-frames.
pub struct VideoVtEncoder {
    width: usize,
    height: usize,
    session: *mut c_void,
    callback_state: *mut VtCallbackState,
    yuv_scratch: YuvFrame,
    finished: bool,
}

unsafe impl Send for VideoVtEncoder {}

impl VideoVtEncoder {
    pub fn new_with_options(
        width: u32,
        height: u32,
        fps: u32,
        options: H264EncoderOptions,
    ) -> Result<Self, RendererError> {
        Self::new_with_codec(VtCodec::H264, width, height, fps, options)
    }

    /// Create a hardware encoder for a specific codec.
    pub fn new_with_codec(
        codec: VtCodec,
        width: u32,
        height: u32,
        fps: u32,
        options: H264EncoderOptions,
    ) -> Result<Self, RendererError> {
        if width < 16 || height < 16 || width % 2 != 0 || height % 2 != 0 {
            return Err(RendererError::InvalidConfig(format!(
                "{} encoder requires even dimensions >= 16x16, got {width}x{height}",
                codec.label()
            )));
        }

        let callback_state_box: Box<VtCallbackState> = Box::new(VtCallbackState {
            output: Mutex::new(VtCallbackOutput::default()),
            codec,
        });
        let callback_state: *mut VtCallbackState = Box::into_raw(callback_state_box);

        let result: Result<*mut c_void, RendererError> = (|| {
            let enc_spec: CfOwned = unsafe {
                cf_dict(
                    &[kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder],
                    &[kCFBooleanTrue],
                )?
            };

            let cf_fmt: CfOwned =
                cf_number_i32(K_CV_PIXEL_FORMAT_420_BIPLANAR_VIDEO_RANGE as i32)?;
            let cf_w: CfOwned = cf_number_i32(width as i32)?;
            let cf_h: CfOwned = cf_number_i32(height as i32)?;
            let empty_iosurface: CfOwned = cf_dict(&[], &[])?;
            // EXPERIMENT (MSS_VT_POOL): the encoder's pixel-buffer pool depth. With the
            // default depth the pool can run dry, so CVPixelBufferPoolCreatePixelBuffer
            // blocks and frames are submitted serially, hiding the VPU's pipelining.
            let pool_min: usize = std::env::var("MSS_VT_POOL")
                .ok()
                .and_then(|v: String| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let src_attrs: CfOwned = unsafe {
                let mut attr_keys: Vec<*const c_void> = vec![
                    kCVPixelBufferPixelFormatTypeKey,
                    kCVPixelBufferWidthKey,
                    kCVPixelBufferHeightKey,
                    kCVPixelBufferIOSurfacePropertiesKey,
                ];
                let mut attr_vals: Vec<*const c_void> =
                    vec![cf_fmt.0, cf_w.0, cf_h.0, empty_iosurface.0];
                if pool_min > 0 {
                    let pool_cf: CfOwned = cf_number_i32(pool_min.min(64) as i32)?;
                    attr_keys.push(kCVPixelBufferPoolMinimumBufferCountKey);
                    attr_vals.push(pool_cf.0);
                }
                cf_dict(&attr_keys, &attr_vals)?
            };

            let mut session: *mut c_void = ptr::null_mut();
            let create_status: OSStatus = unsafe {
                VTCompressionSessionCreate(
                    ptr::null(),
                    width as i32,
                    height as i32,
codec.codec_type(),
                    enc_spec.0,
                    src_attrs.0,
                    ptr::null(),
                    vt_output_callback,
                    callback_state.cast::<c_void>(),
                    &mut session,
                )
            };
            if create_status != 0 || session.is_null() {
                return Err(RendererError::VideoEncode(format!(
                    "VTCompressionSessionCreate failed: OSStatus={create_status}"
                )));
            }

            let setup_res: Result<(), RendererError> = (|| {
                let set_prop = |key: *const c_void, val: *const c_void| -> Result<(), RendererError> {
                    let s: OSStatus = unsafe { VTSessionSetProperty(session, key, val) };
                    if s != 0 {
                        return Err(RendererError::VideoEncode(format!(
                            "VTSessionSetProperty failed: OSStatus={s}"
                        )));
                    }
                    Ok(())
                };

                unsafe {
                    set_prop(kVTCompressionPropertyKey_RealTime, kCFBooleanFalse)?;
                    let _ = VTSessionSetProperty(
                        session,
                        kVTCompressionPropertyKey_MaximizePowerEfficiency,
                        kCFBooleanFalse,
                    );
                    set_prop(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)?;
                    set_prop(
                        kVTCompressionPropertyKey_ProfileLevel,
                        codec.profile_level(),
                    )?;
                    set_prop(
                        kVTCompressionPropertyKey_ColorPrimaries,
                        kCVImageBufferColorPrimaries_ITU_R_709_2,
                    )?;
                    set_prop(
                        kVTCompressionPropertyKey_TransferFunction,
                        kCVImageBufferTransferFunction_ITU_R_709_2,
                    )?;
                    set_prop(
                        kVTCompressionPropertyKey_YCbCrMatrix,
                        kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                    )?;
                }

                let cf_gop: CfOwned = cf_number_i32(options.gop_size.max(1) as i32)?;
                unsafe {
                    set_prop(kVTCompressionPropertyKey_MaxKeyFrameInterval, cf_gop.0)?;
                }
                let cf_fps: CfOwned = cf_number_i32(fps.max(1) as i32)?;
                unsafe {
                    set_prop(kVTCompressionPropertyKey_ExpectedFrameRate, cf_fps.0)?;
                }

                let target_bps: u32 = if options.bitrate_bps > 0 {
                    options.bitrate_bps
                } else {
                    default_vt_bitrate_bps(width, height, fps, options.qp)
                };
                let cf_abr: CfOwned =
                    cf_number_i32((target_bps.min(i32::MAX as u32)) as i32)?;
                unsafe {
                    set_prop(kVTCompressionPropertyKey_AverageBitRate, cf_abr.0)?;
                }

                let prep_status: OSStatus =
                    unsafe { VTCompressionSessionPrepareToEncodeFrames(session) };
                if prep_status != 0 {
                    return Err(RendererError::VideoEncode(format!(
                        "VTCompressionSessionPrepareToEncodeFrames failed: OSStatus={prep_status}"
                    )));
                }
                Ok(())
            })();

            if let Err(err) = setup_res {
                unsafe {
                    VTCompressionSessionInvalidate(session);
                    CFRelease(session.cast::<c_void>());
                }
                return Err(err);
            }

            let pool: *mut c_void = unsafe { VTCompressionSessionGetPixelBufferPool(session) };
            if pool.is_null() {
                unsafe {
                    VTCompressionSessionInvalidate(session);
                    CFRelease(session.cast::<c_void>());
                }
                return Err(RendererError::VideoEncode(
                    "VTCompressionSessionGetPixelBufferPool returned null".to_string(),
                ));
            }
            Ok(session)
        })();

        match result {
            Ok(session) => {
                let w: usize = width as usize;
                let h: usize = height as usize;
                let cw: usize = w / 2;
                let ch: usize = h / 2;
                Ok(Self {
                    width: w,
                    height: h,
                    session,
                    callback_state,
                    yuv_scratch: YuvFrame {
                        width: w,
                        height: h,
                        y: vec![0u8; w * h],
                        u: vec![0u8; cw * ch],
                        v: vec![0u8; cw * ch],
                    },
                    finished: false,
                })
            }
            Err(err) => {
                unsafe {
                    drop(Box::from_raw(callback_state));
                }
                Err(err)
            }
        }
    }

    pub fn is_hardware_accelerated(&self) -> bool {
        let mut val: *const c_void = ptr::null();
        let status: OSStatus = unsafe {
            VTSessionCopyProperty(
                self.session,
                kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                ptr::null(),
                &mut val,
            )
        };
        if status != 0 || val.is_null() {
            return false;
        }
        let is_hw: bool = unsafe { val == kCFBooleanTrue };
        unsafe { CFRelease(val) };
        is_hw
    }

    fn take_callback_packets(&self) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        let state: &VtCallbackState = unsafe { &*self.callback_state };
        let mut guard = state
            .output
            .lock()
            .map_err(|_| RendererError::VideoEncode("VT callback mutex poisoned".to_string()))?;
        if let Some(err) = guard.error.take() {
            return Err(RendererError::VideoEncode(err));
        }
        Ok(std::mem::take(&mut guard.packets))
    }

    fn encode_yuv_with_props(
        &mut self,
        yuv: &YuvFrame,
        pts_secs: f64,
        frame_properties: *const c_void,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        let expected_y: usize = self.width * self.height;
        let cw: usize = self.width / 2;
        let ch: usize = self.height / 2;
        let expected_uv: usize = cw * ch;
        if yuv.width != self.width
            || yuv.height != self.height
            || yuv.y.len() != expected_y
            || yuv.u.len() != expected_uv
            || yuv.v.len() != expected_uv
        {
            return Err(RendererError::VideoEncode(format!(
                "YUV frame buffer mismatch: got {}x{} (y={}, u={}, v={}), expected {}x{}",
                yuv.width,
                yuv.height,
                yuv.y.len(),
                yuv.u.len(),
                yuv.v.len(),
                self.width,
                self.height
            )));
        }

        let pool: *mut c_void = unsafe { VTCompressionSessionGetPixelBufferPool(self.session) };
        if pool.is_null() {
            return Err(RendererError::VideoEncode(
                "VTCompressionSessionGetPixelBufferPool returned null".to_string(),
            ));
        }

        let mut pixel_buffer: *mut c_void = ptr::null_mut();
        let alloc_ret: CVReturn =
            unsafe { CVPixelBufferPoolCreatePixelBuffer(ptr::null(), pool, &mut pixel_buffer) };
        if alloc_ret != 0 || pixel_buffer.is_null() {
            return Err(RendererError::VideoEncode(format!(
                "CVPixelBufferPoolCreatePixelBuffer failed: CVReturn={alloc_ret}"
            )));
        }

        let lock_ret: CVReturn = unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, 0) };
        if lock_ret != 0 {
            unsafe { CVPixelBufferRelease(pixel_buffer) };
            return Err(RendererError::VideoEncode(format!(
                "CVPixelBufferLockBaseAddress failed: CVReturn={lock_ret}"
            )));
        }

        unsafe {
            let y_ptr: *mut u8 = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 0);
            let y_stride: usize = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 0);
            copy_plane_bytes(&yuv.y, self.width, y_ptr, y_stride, self.height);

            let uv_ptr: *mut u8 = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 1);
            let uv_stride: usize = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 1);
            copy_uv_interleaved_nv12(&yuv.u, &yuv.v, cw, uv_ptr, uv_stride, ch);

            CVPixelBufferUnlockBaseAddress(pixel_buffer, 0);
        }

        let pts: CMTime = CMTime::from_secs(pts_secs);
        let encode_status: OSStatus = unsafe {
            VTCompressionSessionEncodeFrame(
                self.session,
                pixel_buffer,
                pts,
                CMTime::INVALID,
                frame_properties,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        unsafe { CVPixelBufferRelease(pixel_buffer) };

        if encode_status != 0 {
            return Err(RendererError::VideoEncode(format!(
                "VTCompressionSessionEncodeFrame failed: OSStatus={encode_status}"
            )));
        }
        self.take_callback_packets()
    }

    /// Encodes a closed GOP chunk starting with a forced IDR keyframe and flushes all packets.
    pub fn encode_gop(
        &mut self,
        frames: &[YuvFrame],
        base_frame_index: u64,
        fps: u32,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        if frames.is_empty() {
            return Ok(Vec::new());
        }
        let force_kf_props: CfOwned = unsafe {
            cf_dict(&[kVTEncodeFrameOptionKey_ForceKeyFrame], &[kCFBooleanTrue])?
        };
        let mut packets: Vec<EncodedVideoPacket> = Vec::with_capacity(frames.len());
        let fps_f64: f64 = fps.max(1) as f64;
        for (i, frame) in frames.iter().enumerate() {
            let pts_secs: f64 = ((base_frame_index + i as u64) as f64) / fps_f64;
            let props: *const c_void = if i == 0 {
                force_kf_props.0
            } else {
                ptr::null()
            };
            packets.extend(self.encode_yuv_with_props(frame, pts_secs, props)?);
        }
        let status: OSStatus =
            unsafe { VTCompressionSessionCompleteFrames(self.session, CMTime::INVALID) };
        if status != 0 {
            return Err(RendererError::VideoEncode(format!(
                "VTCompressionSessionCompleteFrames failed: OSStatus={status}"
            )));
        }
        packets.extend(self.take_callback_packets()?);
        Ok(packets)
    }
}

impl Drop for VideoVtEncoder {
    fn drop(&mut self) {
        if !self.session.is_null() {
            unsafe {
                VTCompressionSessionInvalidate(self.session);
                CFRelease(self.session.cast::<c_void>());
            }
            self.session = ptr::null_mut();
        }
        if !self.callback_state.is_null() {
            unsafe {
                drop(Box::from_raw(self.callback_state));
            }
            self.callback_state = ptr::null_mut();
        }
    }
}

impl VideoFrameEncoder for VideoVtEncoder {
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
        let yuv: YuvFrame = std::mem::replace(
            &mut self.yuv_scratch,
            YuvFrame {
                width: 0,
                height: 0,
                y: Vec::new(),
                u: Vec::new(),
                v: Vec::new(),
            },
        );
        let res: Result<Vec<EncodedVideoPacket>, RendererError> = self.encode_yuv(&yuv, pts_secs);
        self.yuv_scratch = yuv;
        res
    }

    fn encode_yuv(
        &mut self,
        yuv: &YuvFrame,
        pts_secs: f64,
    ) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        self.encode_yuv_with_props(yuv, pts_secs, ptr::null())
    }

    fn finish(&mut self) -> Result<Vec<EncodedVideoPacket>, RendererError> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;
        let status: OSStatus =
            unsafe { VTCompressionSessionCompleteFrames(self.session, CMTime::INVALID) };
        if status != 0 {
            return Err(RendererError::VideoEncode(format!(
                "VTCompressionSessionCompleteFrames failed: OSStatus={status}"
            )));
        }
        self.take_callback_packets()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::encoder::contains_annex_b_idr;
    use rusty_h264_decoder::Decoder;

    #[test]
    fn vt_encodes_and_decodes_valid_h264_stream() {
        let width: u32 = 320;
        let height: u32 = 180;
        let fps: u32 = 30;
        let opts: H264EncoderOptions = H264EncoderOptions::from_quality(
            crate::renderer::config::VideoQualityPreset::Balanced,
            fps,
        );
        let mut enc: VideoVtEncoder =
            VideoVtEncoder::new_with_options(width, height, fps, opts).expect("vt init");

        let w: usize = width as usize;
        let h: usize = height as usize;
        let mut all_annex_b: Vec<u8> = Vec::new();
        let mut packets: Vec<EncodedVideoPacket> = Vec::new();

        for idx in 0..8u32 {
            let mut y: Vec<u8> = vec![0u8; w * h];
            let u: Vec<u8> = vec![128u8; (w / 2) * (h / 2)];
            let v: Vec<u8> = vec![128u8; (w / 2) * (h / 2)];
            for row in 0..h {
                for col in 0..w {
                    y[row * w + col] = ((row + col + idx as usize * 8) % 200 + 20) as u8;
                }
            }
            let frame: YuvFrame = YuvFrame {
                width: w,
                height: h,
                y,
                u,
                v,
            };
            let pts: f64 = idx as f64 / fps as f64;
            let pkts: Vec<EncodedVideoPacket> = enc.encode_yuv(&frame, pts).expect("encode_yuv");
            for pkt in pkts {
                all_annex_b.extend_from_slice(&pkt.annex_b);
                packets.push(pkt);
            }
        }
        let tail: Vec<EncodedVideoPacket> = enc.finish().expect("finish");
        for pkt in tail {
            all_annex_b.extend_from_slice(&pkt.annex_b);
            packets.push(pkt);
        }

        assert_eq!(packets.len(), 8);
        assert!(packets[0].is_keyframe);
        assert!(contains_annex_b_idr(&packets[0].annex_b));

        let mut decoder: Decoder = Decoder::new();
        let decoded = decoder
            .decode_stream(&all_annex_b)
            .expect("decode vt h264 stream");
        assert_eq!(decoded.len(), 8);
        assert_eq!(decoded[0].width, w);
        assert_eq!(decoded[0].height, h);
    }
    /// 4K hardware codec throughput probe: H.264 vs HEVC on identical synthetic content.
        /// Reports encodes/sec and byte size, and verifies that the HEVC keyframe carries
        /// VPS/SPS/PPS (NAL types 32/33/34), which `muxide`'s H265 path requires.
        #[test]
        #[ignore = "4K hardware codec throughput probe"]
        fn vt_4k_codec_throughput_probe() {
            use std::time::Instant;

            const W: u32 = 3840;
            const H: u32 = 2160;
            const FPS: u32 = 60;
            const FRAMES: usize = 60;

            let w: usize = W as usize;
            let h: usize = H as usize;

            fn build_frame(w: usize, h: usize) -> YuvFrame {
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

            fn hevc_has_parameter_sets(annex_b: &[u8]) -> bool {
                let mut has_vps: bool = false;
                let mut has_sps: bool = false;
                let mut has_pps: bool = false;
                let mut i: usize = 0;
                while i + 5 < annex_b.len() {
                    if annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1 {
                        let nal_type: u8 = (annex_b[i + 3] >> 1) & 0x3F;
                        match nal_type {
                            32 => has_vps = true,
                            33 => has_sps = true,
                            34 => has_pps = true,
                            _ => {}
                        }
                        i += 4;
                    } else {
                        i += 1;
                    }
                }
                has_vps && has_sps && has_pps
            }

            let mut frame: YuvFrame = build_frame(w, h);
            let opts: H264EncoderOptions = H264EncoderOptions {
                quality: crate::renderer::config::VideoQualityPreset::Balanced,
                qp: 19,
                bitrate_bps: 0,
                gop_size: 15,
            };

            for codec in [VtCodec::H264, VtCodec::Hevc] {
                let started: Instant = Instant::now();
                let mut enc: VideoVtEncoder =
                    match VideoVtEncoder::new_with_codec(codec, W, H, FPS, opts) {
                        Ok(e) => e,
                        Err(err) => {
                            eprintln!("[CODEC PROBE] {:?} unavailable: {err}", codec);
                            continue;
                        }
                    };
                let hw: bool = enc.is_hardware_accelerated();
                let mut bytes: usize = 0;
                let mut param_sets: bool = false;
                for f in 0..FRAMES {
                    let band_top: usize = (f * 37) % (h - 64);
                    for row in band_top..(band_top + 64) {
                        let base: usize = row * w;
                        for col in 0..w {
                            frame.y[base + col] = ((row + f * 3) % 200 + 20) as u8;
                        }
                    }
                    match enc.encode_yuv(&frame, f as f64 / FPS as f64) {
                        Ok(pkts) => {
                            for p in pkts {
                                if codec == VtCodec::Hevc && !param_sets && p.is_keyframe {
                                    param_sets = hevc_has_parameter_sets(&p.annex_b);
                                }
                                bytes += p.annex_b.len();
                            }
                        }
                        Err(err) => {
                            eprintln!("[CODEC PROBE] {:?} encode failed: {err}", codec);
                            break;
                        }
                    }
                }
                for p in enc.finish().unwrap_or_default() {
                    bytes += p.annex_b.len();
                }
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[CODEC PROBE] {:?} hw={} frames={FRAMES} elapsed={secs:.3}s fps={:.2} bytes={bytes} hevc_param_sets={param_sets}",
                    codec,
                    hw,
                    FRAMES as f64 / secs.max(1e-9)
                );
            }
        }
}

/// Encode one independently-decodable GOP chunk with VideoToolbox.
///
/// Mirrors [`super::video_h264::encode_yuv_gop_chunk`]: a **fresh encoder per chunk**,
/// so every chunk starts with its own SPS/PPS + IDR and can therefore be encoded out
/// of order in parallel and concatenated back in sequence order afterwards. That
/// property is what makes the hybrid (VideoToolbox + software) pipeline possible.
pub fn encode_yuv_gop_chunk_vt(
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
    let mut encoder: VideoVtEncoder = VideoVtEncoder::new_with_options(width, height, fps, options)?;
    let fps_f64: f64 = fps.max(1) as f64;
    let mut packets: Vec<EncodedVideoPacket> = Vec::with_capacity(yuv_frames.len());
    for (idx, yuv) in yuv_frames.iter().enumerate() {
        let pts_secs: f64 = ((base_frame_index + idx as u64) as f64) / fps_f64;
        for pkt in encoder.encode_yuv(yuv, pts_secs)? {
            packets.push(pkt);
        }
    }
    for pkt in encoder.finish()? {
        packets.push(pkt);
    }
    Ok(packets)
}
