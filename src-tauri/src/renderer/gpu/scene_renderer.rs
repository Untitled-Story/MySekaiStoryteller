use bytemuck::{Pod, Zeroable};
use mocari::moc3::Moc3DrawableBlendMode;
use mocari::render::common::draw_order_indices;
use rusty_h264_common::YuvFrame;
use std::collections::{HashMap, VecDeque};
use std::f32::consts::FRAC_PI_2;
use std::path::Path;

use crate::renderer::config::{GpuBackendInfo, RenderBackend};
use crate::renderer::encoder::prefers_hardware_streaming_encoder_for_backend;
use crate::renderer::error::RendererError;
use crate::renderer::live2d::Live2DModelInstance;
use crate::renderer::svg_assets::{load_image_premul, BuiltinUiBitmaps, PremulImage};
use crate::renderer::text::{RenderedTextSurface, StoryTextRenderer};
use crate::renderer::vfx::{GpuFilterSpec, HologramBeamRenderData, TriangleParticle};

use super::filters::{
    encode_pointwise_op, has_effective_filters, is_pointwise_filter, live2d_additive_blend,
    live2d_mask_setup_blend, live2d_multiplicative_blend, ops_preserve_transparent, pixi_add_blend,
    pixi_normal_blend, FilterChainOutput, FilterPipelines, FilterRegion, FilterUniformScratch,
    PointwiseOpGpu, PostChainScratch, PostChainUniformGpu, ScaledPoolLevel, YuvConvertUniformGpu,
    MAX_FUSED_POINTWISE_OPS,
};

const WGSL_SHADERS: &str = include_str!("shaders.wgsl");
const MASK_ATLAS_SIZE: u32 = 1024;
const READBACK_RING_DEPTH: usize = 4;

const SLOT_STAGE_ROOT: usize = 0;
const SLOT_MODEL_RT: usize = 1;
const SLOT_BEAM_RT: usize = 2;
const SLOT_TELOP_RT: usize = 3;
const SLOT_FINAL_OUTPUT: usize = 4;
const SLOT_UI_RT: usize = 5;
const SLOT_MODEL_RT_ALT: usize = 6;
const SCRATCH_START: usize = 7;
const POOL_SIZE: usize = 12; // 7 named slots + 5 filter scratch slots
const SCALED_POOL_SLOTS: usize = 3;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct QuadVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Live2dVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    draw_id: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Live2dMaskUniformGpu {
    clip_matrix: [f32; 16],
    base_color: [f32; 4],
    channel_flag: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Live2dDrawVsParamsGpu {
    mvp: [f32; 16],
    clip_matrix: [f32; 16],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Live2dDrawFsParamsGpu {
    base_color: [f32; 4],
    multiply_color: [f32; 4],
    screen_color: [f32; 4],
    channel_flag: [f32; 4],
    mask_mode: u32,
    _pad: [u32; 3],
}

#[derive(Clone, Copy)]
struct Live2dDrawBatch {
    blend_idx: usize,
    cull_idx: usize,
    tex_idx: usize,
    idx_start: u32,
    idx_count: u32,
}

pub struct GpuTextureAsset {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub quad_bg: wgpu::BindGroup,
    pub width: u32,
    pub height: u32,
}

fn downsample_mip_2x2(src: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let nw: u32 = (w / 2).max(1);
    let nh: u32 = (h / 2).max(1);
    let mut dst: Vec<u8> = vec![0; (nw * nh * 4) as usize];
    for y in 0..nh {
        let sy0: u32 = (y * 2).min(h - 1);
        let sy1: u32 = (sy0 + 1).min(h - 1);
        for x in 0..nw {
            let sx0: u32 = (x * 2).min(w - 1);
            let sx1: u32 = (sx0 + 1).min(w - 1);
            let i00: usize = ((sy0 * w + sx0) * 4) as usize;
            let i10: usize = ((sy0 * w + sx1) * 4) as usize;
            let i01: usize = ((sy1 * w + sx0) * 4) as usize;
            let i11: usize = ((sy1 * w + sx1) * 4) as usize;
            let o: usize = ((y * nw + x) * 4) as usize;
            for c in 0..4 {
                let sum: u32 =
                    src[i00 + c] as u32 + src[i10 + c] as u32 + src[i01 + c] as u32 + src[i11 + c] as u32;
                dst[o + c] = ((sum + 2) >> 2) as u8;
            }
        }
    }
    (dst, nw, nh)
}

pub(crate) struct PrecomputedTextureMips {
    base: PremulImage,
    mips: Vec<(Vec<u8>, u32, u32)>,
}

pub(crate) fn precompute_texture_mips(
    img: PremulImage,
    generate_mips: bool,
) -> PrecomputedTextureMips {
    let width: u32 = img.width.max(1);
    let height: u32 = img.height.max(1);
    let mip_level_count: u32 = if generate_mips && width >= 64 && height >= 64 {
        (width.max(height).ilog2() + 1).min(8)
    } else {
        1
    };
    let mut mips: Vec<(Vec<u8>, u32, u32)> =
        Vec::with_capacity(mip_level_count.saturating_sub(1) as usize);
    if mip_level_count > 1 {
        let mut cur_w: u32 = width;
        let mut cur_h: u32 = height;
        for level in 1..mip_level_count {
            let src_ref: &[u8] = if level == 1 {
                &img.data
            } else {
                &mips[mips.len() - 1].0
            };
            let (next_data, nw, nh): (Vec<u8>, u32, u32) =
                downsample_mip_2x2(src_ref, cur_w, cur_h);
            mips.push((next_data, nw, nh));
            cur_w = nw;
            cur_h = nh;
        }
    }
    PrecomputedTextureMips { base: img, mips }
}

pub(crate) fn precompute_background_mips(
    path: &Path,
) -> Result<PrecomputedTextureMips, RendererError> {
    let img: PremulImage = load_image_premul(path)?;
    Ok(precompute_texture_mips(img, true))
}

pub(crate) fn precompute_model_texture_mips(
    model: &Live2DModelInstance,
) -> Vec<PrecomputedTextureMips> {
    let textures = model.textures();
    if textures.len() <= 1 {
        return textures
            .iter()
            .map(|decoded| {
                let premul: PremulImage = PremulImage::from_straight_rgba(
                    decoded.width(),
                    decoded.height(),
                    decoded.rgba().to_vec(),
                );
                precompute_texture_mips(premul, true)
            })
            .collect();
    }
    std::thread::scope(|s| {
        let handles: Vec<_> = textures
            .iter()
            .map(|decoded| {
                s.spawn(move || -> PrecomputedTextureMips {
                    let premul: PremulImage = PremulImage::from_straight_rgba(
                        decoded.width(),
                        decoded.height(),
                        decoded.rgba().to_vec(),
                    );
                    precompute_texture_mips(premul, true)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("texture mip worker panicked"))
            .collect()
    })
}

impl GpuTextureAsset {
    fn create_quad_bg(
        device: &wgpu::Device,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler_clamp: &wgpu::Sampler,
        view: &wgpu::TextureView,
        label: &str,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: quad_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler_clamp),
                },
            ],
        })
    }

    fn from_premul(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler_clamp: &wgpu::Sampler,
        img: &PremulImage,
        label: &str,
    ) -> Self {
        Self::from_premul_with_mips(device, queue, quad_tex_bgl, sampler_clamp, img, label, false)
    }

    fn from_premul_with_mips(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        img: &PremulImage,
        label: &str,
        generate_mips: bool,
    ) -> Self {
        let width: u32 = img.width.max(1);
        let height: u32 = img.height.max(1);
        let mip_level_count: u32 = if generate_mips && width >= 64 && height >= 64 {
            (width.max(height).ilog2() + 1).min(8)
        } else {
            1
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &img.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        if mip_level_count > 1 {
            let mut cur_data: Vec<u8> = img.data.clone();
            let mut cur_w: u32 = width;
            let mut cur_h: u32 = height;
            for level in 1..mip_level_count {
                let (next_data, nw, nh) = downsample_mip_2x2(&cur_data, cur_w, cur_h);
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture,
                        mip_level: level,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &next_data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(nw * 4),
                        rows_per_image: Some(nh),
                    },
                    wgpu::Extent3d {
                        width: nw,
                        height: nh,
                        depth_or_array_layers: 1,
                    },
                );
                cur_data = next_data;
                cur_w = nw;
                cur_h = nh;
            }
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let quad_bg = Self::create_quad_bg(device, quad_tex_bgl, sampler, &view, label);
        Self {
            texture,
            view,
            quad_bg,
            width,
            height,
        }
    }

    fn from_precomputed_mips(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        pre: &PrecomputedTextureMips,
        label: &str,
    ) -> Self {
        let width: u32 = pre.base.width.max(1);
        let height: u32 = pre.base.height.max(1);
        let mip_level_count: u32 = 1 + pre.mips.len() as u32;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pre.base.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        for (idx, (mip_data, nw, nh)) in pre.mips.iter().enumerate() {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: (idx + 1) as u32,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                mip_data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(*nw * 4),
                    rows_per_image: Some(*nh),
                },
                wgpu::Extent3d {
                    width: *nw,
                    height: *nh,
                    depth_or_array_layers: 1,
                },
            );
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let quad_bg = Self::create_quad_bg(device, quad_tex_bgl, sampler, &view, label);
        Self {
            texture,
            view,
            quad_bg,
            width,
            height,
        }
    }

    fn create_render_target(
        device: &wgpu::Device,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler_clamp: &wgpu::Sampler,
        width: u32,
        height: u32,
        include_storage_binding: bool,
        label: &str,
    ) -> Self {
        let mut usage: wgpu::TextureUsages = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST;
        if include_storage_binding {
            usage |= wgpu::TextureUsages::STORAGE_BINDING;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let quad_bg = Self::create_quad_bg(device, quad_tex_bgl, sampler_clamp, &view, label);
        Self {
            texture,
            view,
            quad_bg,
            width,
            height,
        }
    }
}

pub struct GpuRenderModelInput<'a> {
    pub model: &'a Live2DModelInstance,
    pub parent_filters: &'a [GpuFilterSpec],
    pub particles: &'a [&'a TriangleParticle],
    pub hologram_beams: &'a [HologramBeamRenderData],
}

pub struct GpuRenderFrameInput<'a> {
    pub background_key: Option<&'a str>,
    pub models: &'a [GpuRenderModelInput<'a>],
    pub stage_filters: &'a [GpuFilterSpec],
    pub screen_filters: &'a [GpuFilterSpec],
    pub dialogue_visible: bool,
    pub dialogue_bg_alpha: f32,
    pub dialogue_underline_alpha: f32,
    pub dialogue_body_text: &'a str,
    pub dialogue_body_alpha: f32,
    pub dialogue_speaker_text: &'a str,
    pub dialogue_speaker_alpha: f32,
    pub telop_visible: bool,
    pub telop_text: &'a str,
    pub telop_alpha: f32,
    pub telop_x_offset: f32,
    pub fade_visible: bool,
    pub fade_color: [f32; 4],
    pub fade_alpha: f32,
    pub background_clear: [f32; 4],
}

struct CachedTextTexture {
    source_text: String,
    surface: Option<(GpuTextureAsset, f32, f32)>,
}

impl Default for CachedTextTexture {
    fn default() -> Self {
        Self {
            source_text: String::new(),
            surface: None,
        }
    }
}

struct ModelGpuCache {
    textures: Vec<GpuTextureAsset>,
    ibuf: wgpu::Buffer,
    mesh_ranges: Vec<(i32, u32, u32)>,
    total_verts: usize,
    mask_tbgs: Vec<wgpu::BindGroup>,
    draw_tbgs: Vec<wgpu::BindGroup>,
}

struct ScaledPoolBuffers {
    width: u32,
    height: u32,
    scale_factor: u32,
    _textures: Vec<wgpu::Texture>,
    _views: Vec<wgpu::TextureView>,
    quad_bgs: Vec<wgpu::BindGroup>,
    filter_bgs: Vec<wgpu::BindGroup>,
    cs_dst_bgs: Vec<wgpu::BindGroup>,
}

impl ScaledPoolBuffers {
    fn new(
        device: &wgpu::Device,
        quad_tex_bgl: &wgpu::BindGroupLayout,
        sampler_clamp: &wgpu::Sampler,
        filters: &FilterPipelines,
        width: u32,
        height: u32,
        scale_factor: u32,
        label_prefix: &str,
    ) -> Self {
        let mut _textures: Vec<wgpu::Texture> = Vec::with_capacity(SCALED_POOL_SLOTS);
        let mut _views: Vec<wgpu::TextureView> = Vec::with_capacity(SCALED_POOL_SLOTS);
        let mut quad_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(SCALED_POOL_SLOTS);
        let mut filter_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(SCALED_POOL_SLOTS);
        let mut cs_dst_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(SCALED_POOL_SLOTS);
        for i in 0..SCALED_POOL_SLOTS {
            let rt = GpuTextureAsset::create_render_target(
                device,
                quad_tex_bgl,
                sampler_clamp,
                width,
                height,
                true,
                &format!("{label_prefix}_{i}"),
            );
            filter_bgs.push(filters.create_tex_bind_group(
                device,
                &rt.view,
                &format!("{label_prefix}_flt_{i}"),
            ));
            if let Some(dst_bg) = filters.create_cs_dst_bind_group(
                device,
                &rt.view,
                &format!("{label_prefix}_dst_{i}"),
            ) {
                cs_dst_bgs.push(dst_bg);
            }
            quad_bgs.push(rt.quad_bg);
            _views.push(rt.view);
            _textures.push(rt.texture);
        }
        Self {
            width,
            height,
            scale_factor,
            _textures,
            _views,
            quad_bgs,
            filter_bgs,
            cs_dst_bgs,
        }
    }

    fn as_level(&self) -> ScaledPoolLevel<'_> {
        ScaledPoolLevel {
            width: self.width,
            height: self.height,
            scale_factor: self.scale_factor,
            filter_bgs: &self.filter_bgs,
            cs_dst_bgs: &self.cs_dst_bgs,
        }
    }
}

struct FrameScratch {
    quad_vbuf: wgpu::Buffer,
    quad_cap_verts: usize,
    quad_verts: Vec<QuadVertex>,

    l2d_vbuf: wgpu::Buffer,
    l2d_cap_verts: usize,
    l2d_verts: Vec<Live2dVertex>,

    l2d_ibuf: wgpu::Buffer,
    l2d_cap_indices: usize,
    l2d_indices: Vec<u32>,

    l2d_mask_ubuf: wgpu::Buffer,
    l2d_mask_ubg: wgpu::BindGroup,
    l2d_mask_cap_slots: usize,
    l2d_mask_raw: Vec<u8>,

    l2d_draw_vs_sbuf: wgpu::Buffer,
    l2d_draw_fs_sbuf: wgpu::Buffer,
    l2d_draw_sbg: wgpu::BindGroup,
    l2d_draw_cap_slots: usize,
    l2d_draw_vs_params: Vec<Live2dDrawVsParamsGpu>,
    l2d_draw_fs_params: Vec<Live2dDrawFsParamsGpu>,

    drawable_ctx: Vec<Option<usize>>,
    mask_calls: Vec<(usize, bool, usize)>,
    mesh_slot_map: Vec<u32>,
    draw_batches: Vec<Live2dDrawBatch>,
    model_filters: Vec<GpuFilterSpec>,

    filter_scratch: FilterUniformScratch,
    chain_scratch: Option<PostChainScratch>,
    uniform_stride: usize,
}

impl FrameScratch {
    fn new(
        device: &wgpu::Device,
        filters: &FilterPipelines,
        live2d_mask_ubgl: &wgpu::BindGroupLayout,
        live2d_draw_ubgl: &wgpu::BindGroupLayout,
        uniform_stride: usize,
        storage_align: usize,
    ) -> Self {
        let quad_cap_verts: usize = 8192;
        let quad_vbuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scratch_quad_vbuf"),
            size: (quad_cap_verts * std::mem::size_of::<QuadVertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let l2d_cap_verts: usize = 131_072;
        let l2d_vbuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scratch_l2d_vbuf"),
            size: (l2d_cap_verts * std::mem::size_of::<Live2dVertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let l2d_cap_indices: usize = 262_144;
        let l2d_ibuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scratch_l2d_ibuf"),
            size: (l2d_cap_indices * std::mem::size_of::<u32>()) as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let l2d_mask_cap_slots: usize = 512;
        let (l2d_mask_ubuf, l2d_mask_ubg) = Self::create_dynamic_ubuf(
            device,
            live2d_mask_ubgl,
            "scratch_l2d_mask_ubuf",
            l2d_mask_cap_slots * uniform_stride,
            std::mem::size_of::<Live2dMaskUniformGpu>() as u64,
        );

        let l2d_draw_cap_slots: usize = 4096;
        let (l2d_draw_vs_sbuf, l2d_draw_fs_sbuf, l2d_draw_sbg) = Self::create_draw_sbuf(
            device,
            live2d_draw_ubgl,
            l2d_draw_cap_slots,
        );

        let filter_scratch: FilterUniformScratch =
            FilterUniformScratch::new(device, filters, uniform_stride, 256);
        let chain_scratch: Option<PostChainScratch> =
            PostChainScratch::new(device, filters, storage_align, 16);

        Self {
            quad_vbuf,
            quad_cap_verts,
            quad_verts: Vec::with_capacity(quad_cap_verts),
            l2d_vbuf,
            l2d_cap_verts,
            l2d_verts: Vec::with_capacity(l2d_cap_verts),
            l2d_ibuf,
            l2d_cap_indices,
            l2d_indices: Vec::with_capacity(l2d_cap_indices),
            l2d_mask_ubuf,
            l2d_mask_ubg,
            l2d_mask_cap_slots,
            l2d_mask_raw: Vec::with_capacity(l2d_mask_cap_slots * uniform_stride),
            l2d_draw_vs_sbuf,
            l2d_draw_fs_sbuf,
            l2d_draw_sbg,
            l2d_draw_cap_slots,
            l2d_draw_vs_params: Vec::with_capacity(l2d_draw_cap_slots),
            l2d_draw_fs_params: Vec::with_capacity(l2d_draw_cap_slots),
            drawable_ctx: Vec::with_capacity(512),
            mask_calls: Vec::with_capacity(64),
            mesh_slot_map: Vec::with_capacity(512),
            draw_batches: Vec::with_capacity(256),
            model_filters: Vec::with_capacity(16),
            filter_scratch,
            chain_scratch,
            uniform_stride,
        }
    }

    fn create_dynamic_ubuf(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        label: &str,
        byte_len: usize,
        bind_size: u64,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        let ubuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: byte_len as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let ubg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &ubuf,
                    offset: 0,
                    size: wgpu::BufferSize::new(bind_size),
                }),
            }],
        });
        (ubuf, ubg)
    }

    fn create_draw_sbuf(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        slots: usize,
    ) -> (wgpu::Buffer, wgpu::Buffer, wgpu::BindGroup) {
        let vs_sbuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scratch_l2d_draw_vs_sbuf"),
            size: (slots.max(1) * std::mem::size_of::<Live2dDrawVsParamsGpu>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let fs_sbuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scratch_l2d_draw_fs_sbuf"),
            size: (slots.max(1) * std::mem::size_of::<Live2dDrawFsParamsGpu>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sbg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scratch_l2d_draw_sbg"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: vs_sbuf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: fs_sbuf.as_entire_binding(),
                },
            ],
        });
        (vs_sbuf, fs_sbuf, sbg)
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &mut self,
        device: &wgpu::Device,
        filters: &FilterPipelines,
        live2d_mask_ubgl: &wgpu::BindGroupLayout,
        live2d_draw_ubgl: &wgpu::BindGroupLayout,
        req_quad_verts: usize,
        req_l2d_verts: usize,
        req_l2d_indices: usize,
        req_mask_slots: usize,
        req_draw_slots: usize,
        req_filter_slots: usize,
        req_post_chain_slots: usize,
    ) {
        self.quad_verts.clear();
        self.l2d_verts.clear();
        self.l2d_indices.clear();
        self.l2d_mask_raw.clear();
        self.l2d_draw_vs_params.clear();
        self.l2d_draw_fs_params.clear();
        self.filter_scratch.prepare(device, filters, req_filter_slots);
        if let Some(cs) = self.chain_scratch.as_mut() {
            cs.prepare(device, filters, req_post_chain_slots);
        }

        if req_quad_verts > self.quad_cap_verts {
            let new_cap: usize = req_quad_verts.next_power_of_two();
            self.quad_vbuf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("scratch_quad_vbuf"),
                size: (new_cap * std::mem::size_of::<QuadVertex>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.quad_cap_verts = new_cap;
        }
        if req_l2d_verts > self.l2d_cap_verts {
            let new_cap: usize = req_l2d_verts.next_power_of_two();
            self.l2d_vbuf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("scratch_l2d_vbuf"),
                size: (new_cap * std::mem::size_of::<Live2dVertex>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.l2d_cap_verts = new_cap;
        }
        if req_l2d_indices > self.l2d_cap_indices {
            let new_cap: usize = req_l2d_indices.next_power_of_two();
            self.l2d_ibuf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("scratch_l2d_ibuf"),
                size: (new_cap * std::mem::size_of::<u32>()) as u64,
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.l2d_cap_indices = new_cap;
        }
        if req_mask_slots > self.l2d_mask_cap_slots {
            let new_slots: usize = req_mask_slots.next_power_of_two();
            let (ubuf, ubg) = Self::create_dynamic_ubuf(
                device,
                live2d_mask_ubgl,
                "scratch_l2d_mask_ubuf",
                new_slots * self.uniform_stride,
                std::mem::size_of::<Live2dMaskUniformGpu>() as u64,
            );
            self.l2d_mask_ubuf = ubuf;
            self.l2d_mask_ubg = ubg;
            self.l2d_mask_cap_slots = new_slots;
        }
        if req_draw_slots > self.l2d_draw_cap_slots {
            let new_slots: usize = req_draw_slots.next_power_of_two();
            let (vs_sbuf, fs_sbuf, sbg) =
                Self::create_draw_sbuf(device, live2d_draw_ubgl, new_slots);
            self.l2d_draw_vs_sbuf = vs_sbuf;
            self.l2d_draw_fs_sbuf = fs_sbuf;
            self.l2d_draw_sbg = sbg;
            self.l2d_draw_cap_slots = new_slots;
        }
    }

    fn flush(&self, queue: &wgpu::Queue) {
        if !self.quad_verts.is_empty() {
            queue.write_buffer(&self.quad_vbuf, 0, bytemuck::cast_slice(&self.quad_verts));
        }
        if !self.l2d_verts.is_empty() {
            queue.write_buffer(&self.l2d_vbuf, 0, bytemuck::cast_slice(&self.l2d_verts));
        }
        if !self.l2d_indices.is_empty() {
            queue.write_buffer(&self.l2d_ibuf, 0, bytemuck::cast_slice(&self.l2d_indices));
        }
        if !self.l2d_mask_raw.is_empty() {
            queue.write_buffer(&self.l2d_mask_ubuf, 0, &self.l2d_mask_raw);
        }
        if !self.l2d_draw_vs_params.is_empty() {
            queue.write_buffer(
                &self.l2d_draw_vs_sbuf,
                0,
                bytemuck::cast_slice(&self.l2d_draw_vs_params),
            );
            queue.write_buffer(
                &self.l2d_draw_fs_sbuf,
                0,
                bytemuck::cast_slice(&self.l2d_draw_fs_params),
            );
        }
        self.filter_scratch.flush(queue);
        if let Some(cs) = self.chain_scratch.as_ref() {
            cs.flush(queue);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadbackKind {
    Rgba,
    Yuv,
}

struct InFlightReadback {
    slot: usize,
    kind: ReadbackKind,
    submission_index: wgpu::SubmissionIndex,
    rx: std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
}

struct GpuYuvPackResources {
    y_words: u32,
    uv_words: u32,
    yuv_byte_len: u64,
    gpu_buf: wgpu::Buffer,
    _uniform_buf: wgpu::Buffer,
    pack_bg: wgpu::BindGroup,
    fused_aux_none: wgpu::BindGroup,
    fused_aux_half: Option<wgpu::BindGroup>,
    fused_aux_quarter: Option<wgpu::BindGroup>,
    readback_bufs: [wgpu::Buffer; READBACK_RING_DEPTH],
}

#[derive(Clone, PartialEq, Default)]
struct CachedUiState {
    valid: bool,
    dialogue_visible: bool,
    dialogue_bg_alpha: u32,
    dialogue_underline_alpha: u32,
    dialogue_body_alpha: u32,
    dialogue_speaker_alpha: u32,
    body_text: String,
    speaker_text: String,
    telop_active: bool,
    telop_alpha: u32,
    telop_x_offset: u32,
    telop_text: String,
    min_y: u32,
    max_y: u32,
}

pub struct GpuSceneRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    stage_width: u32,
    stage_height: u32,
    uniform_stride: usize,
    filters: FilterPipelines,

    // Quad rendering resources
    quad_tex_bgl: wgpu::BindGroupLayout,
    quad_pipe_normal: wgpu::RenderPipeline,
    quad_pipe_replace: wgpu::RenderPipeline,
    quad_pipe_add: wgpu::RenderPipeline,
    quad_pipe_pointwise: Option<wgpu::RenderPipeline>,
    bloom_pipe_normal: wgpu::RenderPipeline,
    empty_bg: wgpu::BindGroup,
    beam_glow_aux: Option<GpuTextureAsset>,
    sampler_clamp: wgpu::Sampler,
    sampler_mipmap: wgpu::Sampler,
    white_tex: GpuTextureAsset,

    // Live2D mask + drawable pipelines
    live2d_mask_ubgl: wgpu::BindGroupLayout,
    live2d_mask_tbgl: wgpu::BindGroupLayout,
    live2d_mask_pipe_cull: wgpu::RenderPipeline,
    live2d_mask_pipe_nocull: wgpu::RenderPipeline,
    live2d_draw_ubgl: wgpu::BindGroupLayout,
    live2d_draw_tbgl: wgpu::BindGroupLayout,
    live2d_pipes: [[wgpu::RenderPipeline; 2]; 3], // [Normal|Add|Mult][cull|nocull]

    // Render target pool & deep asynchronous readback ring
    pool_textures: Vec<wgpu::Texture>,
    pool_views: Vec<wgpu::TextureView>,
    pool_quad_bgs: Vec<wgpu::BindGroup>,
    pool_filter_bgs: Vec<wgpu::BindGroup>,
    pool_cs_dst_bgs: Vec<wgpu::BindGroup>,
    pool_cs_orig_bgs: Vec<wgpu::BindGroup>,
    half_pool: Option<ScaledPoolBuffers>,
    quarter_pool: Option<ScaledPoolBuffers>,
    mask_atlas: GpuTextureAsset,
    readback_bufs: Option<[wgpu::Buffer; READBACK_RING_DEPTH]>,
    readback_byte_size: u64,
    yuv_resources: Option<GpuYuvPackResources>,
    scratches: [Option<FrameScratch>; READBACK_RING_DEPTH],
    next_slot: usize,
    in_flight: VecDeque<InFlightReadback>,
    padded_bytes_per_row: u32,

    // Cached static/dynamic scene textures and model geometry
    ui_text_bg: GpuTextureAsset,
    ui_text_bg_min_y: u32,
    ui_text_underline: GpuTextureAsset,
    ui_telop: GpuTextureAsset,
    ui_hologram: GpuTextureAsset,
    backgrounds: HashMap<String, GpuTextureAsset>,
    model_caches: HashMap<String, ModelGpuCache>,
    cached_body: CachedTextTexture,
    cached_speaker: CachedTextTexture,
    cached_telop: CachedTextTexture,
    cached_ui: CachedUiState,
}

const NVIDIA_PCI_VENDOR_ID: u32 = 0x10DE;

fn wgpu_backend_name(backend: wgpu::Backend) -> &'static str {
    match backend {
        wgpu::Backend::Vulkan => "vulkan",
        wgpu::Backend::Metal => "metal",
        wgpu::Backend::Dx12 => "dx12",
        wgpu::Backend::Gl => "gl",
        wgpu::Backend::BrowserWebGpu => "webgpu",
        wgpu::Backend::Noop => "noop",
    }
}

fn device_type_name(device_type: wgpu::DeviceType) -> &'static str {
    match device_type {
        wgpu::DeviceType::IntegratedGpu => "integratedGpu",
        wgpu::DeviceType::DiscreteGpu => "discreteGpu",
        wgpu::DeviceType::VirtualGpu => "virtualGpu",
        wgpu::DeviceType::Cpu => "cpu",
        wgpu::DeviceType::Other => "other",
    }
}

fn map_adapter_to_render_backend(info: &wgpu::AdapterInfo) -> RenderBackend {
    if info.device_type == wgpu::DeviceType::Cpu {
        return RenderBackend::Cpu;
    }
    match info.backend {
        wgpu::Backend::Metal => RenderBackend::Metal,
        wgpu::Backend::Vulkan => RenderBackend::Vulkan,
        wgpu::Backend::Dx12 => RenderBackend::Dx12,
        wgpu::Backend::Gl => RenderBackend::Gl,
        wgpu::Backend::BrowserWebGpu | wgpu::Backend::Noop => RenderBackend::Auto,
    }
}

/// Enumerates all available GPU and CPU rendering backends on the current device.
pub fn enumerate_render_backends() -> Vec<GpuBackendInfo> {
    let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapters: Vec<wgpu::Adapter> =
        pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    let mut results: Vec<GpuBackendInfo> = Vec::with_capacity(adapters.len() + 1);
    let mut added_cuda: bool = false;

    for adapter in &adapters {
        let info: wgpu::AdapterInfo = adapter.get_info();
        let backend: RenderBackend = map_adapter_to_render_backend(&info);
        let supports_compute: bool = adapter.limits().max_compute_workgroups_per_dimension > 0;
        let wgpu_backend: String = wgpu_backend_name(info.backend).to_string();
        let device_type: String = device_type_name(info.device_type).to_string();

        if !added_cuda
            && info.vendor == NVIDIA_PCI_VENDOR_ID
            && info.device_type != wgpu::DeviceType::Cpu
            && matches!(info.backend, wgpu::Backend::Vulkan | wgpu::Backend::Dx12)
        {
            added_cuda = true;
            results.push(GpuBackendInfo {
                backend: RenderBackend::Cuda,
                wgpu_backend: wgpu_backend.clone(),
                adapter_name: info.name.clone(),
                device_type: device_type.clone(),
                vendor_id: info.vendor,
                supports_compute,
                supports_hw_video_encoder: prefers_hardware_streaming_encoder_for_backend(
                    RenderBackend::Cuda,
                ),
            });
        }

        results.push(GpuBackendInfo {
            backend,
            wgpu_backend,
            adapter_name: info.name,
            device_type,
            vendor_id: info.vendor,
            supports_compute,
            supports_hw_video_encoder: prefers_hardware_streaming_encoder_for_backend(backend),
        });
    }

    results
}

fn select_adapter_for_backend(backend: RenderBackend) -> Result<wgpu::Adapter, RendererError> {
    match backend {
        RenderBackend::Auto => {
            let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::from_env().unwrap_or_else(wgpu::Backends::all),
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            }))
            .or_else(|_| {
                pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    compatible_surface: None,
                    force_fallback_adapter: true,
                    apply_limit_buckets: false,
                }))
            })
            .map_err(|err| RendererError::Gpu(format!("No WebGPU/wgpu adapter available: {err}")))
        }
        RenderBackend::Metal => request_specific_backend_adapter(wgpu::Backends::METAL, "Metal/MPS"),
        RenderBackend::Vulkan => request_specific_backend_adapter(wgpu::Backends::VULKAN, "Vulkan"),
        RenderBackend::Dx12 => request_specific_backend_adapter(wgpu::Backends::DX12, "DirectX 12"),
        RenderBackend::Gl => request_specific_backend_adapter(wgpu::Backends::GL, "OpenGL/GLES"),
        RenderBackend::Cuda => {
            let backends: wgpu::Backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
            let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapters: Vec<wgpu::Adapter> =
                pollster::block_on(instance.enumerate_adapters(backends));
            let nvidia_adapter: Option<wgpu::Adapter> = adapters
                .into_iter()
                .filter(|adapter| {
                    let info: wgpu::AdapterInfo = adapter.get_info();
                    info.vendor == NVIDIA_PCI_VENDOR_ID
                        && info.device_type != wgpu::DeviceType::Cpu
                })
                .max_by_key(|adapter| {
                    let info: wgpu::AdapterInfo = adapter.get_info();
                    let backend_rank: u8 = match info.backend {
                        wgpu::Backend::Vulkan => 2,
                        wgpu::Backend::Dx12 => 1,
                        _ => 0,
                    };
                    let discrete_rank: u8 =
                        u8::from(info.device_type == wgpu::DeviceType::DiscreteGpu);
                    (discrete_rank, backend_rank)
                });
            if let Some(adapter) = nvidia_adapter {
                return Ok(adapter);
            }
            Err(RendererError::Gpu(
                "No NVIDIA GPU adapter available for CUDA backend (requires Vulkan/DX12 NVIDIA driver)"
                    .to_string(),
            ))
        }
        RenderBackend::Cpu => {
            let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::all(),
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapters: Vec<wgpu::Adapter> =
                pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
            if let Some(cpu_adapter) = adapters
                .into_iter()
                .find(|adapter| adapter.get_info().device_type == wgpu::DeviceType::Cpu)
            {
                return Ok(cpu_adapter);
            }
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: None,
                force_fallback_adapter: true,
                apply_limit_buckets: false,
            }))
            .map_err(|err| {
                RendererError::Gpu(format!(
                    "No CPU/software WebGPU adapter available on this system: {err}"
                ))
            })
        }
    }
}

fn request_specific_backend_adapter(
    backends: wgpu::Backends,
    label: &str,
) -> Result<wgpu::Adapter, RendererError> {
    let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .map_err(|err| RendererError::Gpu(format!("No {label} GPU adapter available: {err}")))
}

impl GpuSceneRenderer {
    /// Creates a GPU scene renderer using the automatic backend selection policy.
    pub fn new(stage_width: u32, stage_height: u32) -> Result<Self, RendererError> {
        Self::new_with_backend(stage_width, stage_height, RenderBackend::Auto)
    }

    /// Creates a GPU scene renderer configured for a specific [`RenderBackend`].
    pub fn new_with_backend(
        stage_width: u32,
        stage_height: u32,
        backend: RenderBackend,
    ) -> Result<Self, RendererError> {
        let adapter: wgpu::Adapter = select_adapter_for_backend(backend)?;

        let adapter_limits: wgpu::Limits = adapter.limits();
        let supports_compute_filters: bool = adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .allowed_usages
            .contains(wgpu::TextureUsages::STORAGE_BINDING)
            && adapter_limits.max_compute_workgroups_per_dimension > 0;

        let mut required_limits: wgpu::Limits = if supports_compute_filters {
            wgpu::Limits::default().using_resolution(adapter_limits.clone())
        } else {
            wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter_limits.clone())
                .using_alignment(adapter_limits.clone())
        };
        required_limits.max_storage_buffers_per_shader_stage =
            adapter_limits.max_storage_buffers_per_shader_stage.min(8);

        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits,
            ..Default::default()
        }))
        .map_err(|err| RendererError::Gpu(format!("Failed to create wgpu device: {err}")))?;

        let uniform_stride: usize =
            (device.limits().min_uniform_buffer_offset_alignment as usize).max(256);
        let storage_align: usize =
            device.limits().min_storage_buffer_offset_alignment as usize;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("renderer_wgsl"),
            source: wgpu::ShaderSource::Wgsl(WGSL_SHADERS.into()),
        });

        let filters = FilterPipelines::new(&device, &shader, supports_compute_filters);

        let sampler_clamp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("clamp_linear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let sampler_mipmap = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("clamp_trilinear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });

        // Quad pipelines
        let quad_tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("quad_tex_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let white_img = PremulImage {
            width: 1,
            height: 1,
            data: vec![255, 255, 255, 255],
        };
        let white_tex = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &quad_tex_bgl,
            &sampler_clamp,
            &white_img,
            "white_1x1",
        );
        let quad_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("quad_layout"),
            bind_group_layouts: &[Some(&quad_tex_bgl)],
            immediate_size: 0,
        });
        let quad_vbuf_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<QuadVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 16,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32x4,
                },
            ],
        };
        let make_quad_pipe = |label: &str, blend: wgpu::BlendState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&quad_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("quad_vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(quad_vbuf_layout.clone())],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("quad_fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let quad_pipe_normal = make_quad_pipe("quad_normal", pixi_normal_blend());
        let quad_pipe_replace = make_quad_pipe("quad_replace", wgpu::BlendState::REPLACE);
        let quad_pipe_add = make_quad_pipe("quad_add", pixi_add_blend());
        let empty_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("empty_bgl"),
                entries: &[],
            });
        let empty_bg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("empty_bg"),
            layout: &empty_bgl,
            entries: &[],
        });
        let bloom_quad_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("bloom_quad_layout"),
                bind_group_layouts: &[
                    Some(&quad_tex_bgl),
                    Some(&empty_bgl),
                    Some(&empty_bgl),
                    Some(&quad_tex_bgl),
                ],
                immediate_size: 0,
            });
        let bloom_pipe_normal: wgpu::RenderPipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("bloom_quad_normal"),
                layout: Some(&bloom_quad_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("quad_vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(quad_vbuf_layout.clone())],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("bloom_quad_fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(pixi_normal_blend()),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        let quad_pipe_pointwise: Option<wgpu::RenderPipeline> =
            filters.compute.as_ref().map(|cs| {
                let layout: wgpu::PipelineLayout =
                    device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("quad_pointwise_layout"),
                        bind_group_layouts: &[Some(&quad_tex_bgl), Some(&cs.post_chain_bgl)],
                        immediate_size: 0,
                    });
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("quad_pointwise_normal"),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("quad_vs"),
                        compilation_options: Default::default(),
                        buffers: &[Some(quad_vbuf_layout.clone())],
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("quad_pointwise_fs"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            blend: Some(pixi_normal_blend()),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            });

        // Live2D pipelines
        let live2d_vbuf_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Live2dVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
            ],
        };
        let live2d_draw_vbuf_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Live2dVertex>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 8,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: 16,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Uint32,
                },
            ],
        };

        let live2d_mask_ubgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("live2d_mask_ubgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(
                        std::mem::size_of::<Live2dMaskUniformGpu>() as u64,
                    ),
                },
                count: None,
            }],
        });
        let live2d_mask_tbgl = quad_tex_bgl.clone();
        let live2d_mask_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d_mask_layout"),
            bind_group_layouts: &[Some(&live2d_mask_ubgl), Some(&live2d_mask_tbgl)],
            immediate_size: 0,
        });
        let make_mask_pipe = |label: &str, cull_mode: Option<wgpu::Face>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&live2d_mask_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("live2d_mask_vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(live2d_vbuf_layout.clone())],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("live2d_mask_fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(live2d_mask_setup_blend()),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let live2d_mask_pipe_cull = make_mask_pipe("live2d_mask_cull", Some(wgpu::Face::Back));
        let live2d_mask_pipe_nocull = make_mask_pipe("live2d_mask_nocull", None);

        let live2d_draw_ubgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("live2d_draw_ubgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let live2d_draw_tbgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("live2d_draw_tbgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let live2d_draw_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d_draw_layout"),
            bind_group_layouts: &[Some(&live2d_draw_ubgl), Some(&live2d_draw_tbgl)],
            immediate_size: 0,
        });
        let make_draw_pipe =
            |label: &str, blend: wgpu::BlendState, cull_mode: Option<wgpu::Face>| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&live2d_draw_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("live2d_draw_vs"),
                        compilation_options: Default::default(),
                        buffers: &[Some(live2d_draw_vbuf_layout.clone())],
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        front_face: wgpu::FrontFace::Ccw,
                        cull_mode,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("live2d_draw_fs"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            blend: Some(blend),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
        let live2d_pipes = [
            [
                make_draw_pipe("l2d_norm_cull", pixi_normal_blend(), Some(wgpu::Face::Back)),
                make_draw_pipe("l2d_norm_nocull", pixi_normal_blend(), None),
            ],
            [
                make_draw_pipe(
                    "l2d_add_cull",
                    live2d_additive_blend(),
                    Some(wgpu::Face::Back),
                ),
                make_draw_pipe("l2d_add_nocull", live2d_additive_blend(), None),
            ],
            [
                make_draw_pipe(
                    "l2d_mult_cull",
                    live2d_multiplicative_blend(),
                    Some(wgpu::Face::Back),
                ),
                make_draw_pipe("l2d_mult_nocull", live2d_multiplicative_blend(), None),
            ],
        ];

        // Allocate render target pool and pre-cached quad/filter/compute bind groups
        let enable_compute: bool = filters.compute.is_some();
        let mut pool_textures: Vec<wgpu::Texture> = Vec::with_capacity(POOL_SIZE);
        let mut pool_views: Vec<wgpu::TextureView> = Vec::with_capacity(POOL_SIZE);
        let mut pool_quad_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(POOL_SIZE);
        let mut pool_filter_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(POOL_SIZE);
        let mut pool_cs_dst_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(POOL_SIZE);
        let mut pool_cs_orig_bgs: Vec<wgpu::BindGroup> = Vec::with_capacity(POOL_SIZE);
        for i in 0..POOL_SIZE {
            let rt = GpuTextureAsset::create_render_target(
                &device,
                &quad_tex_bgl,
                &sampler_clamp,
                stage_width,
                stage_height,
                enable_compute,
                &format!("rt_slot_{i}"),
            );
            pool_filter_bgs.push(filters.create_tex_bind_group(
                &device,
                &rt.view,
                &format!("rt_flt_bg_{i}"),
            ));
            if let Some(dst_bg) =
                filters.create_cs_dst_bind_group(&device, &rt.view, &format!("rt_cs_dst_{i}"))
            {
                pool_cs_dst_bgs.push(dst_bg);
            }
            if let Some(orig_bg) =
                filters.create_cs_orig_bind_group(&device, &rt.view, &format!("rt_cs_orig_{i}"))
            {
                pool_cs_orig_bgs.push(orig_bg);
            }
            pool_quad_bgs.push(rt.quad_bg);
            pool_views.push(rt.view);
            pool_textures.push(rt.texture);
        }

        let half_pool: Option<ScaledPoolBuffers> = if enable_compute {
            Some(ScaledPoolBuffers::new(
                &device,
                &quad_tex_bgl,
                &sampler_clamp,
                &filters,
                (stage_width / 2).max(1),
                (stage_height / 2).max(1),
                2,
                "rt_half",
            ))
        } else {
            None
        };
        let quarter_pool: Option<ScaledPoolBuffers> = if enable_compute {
            Some(ScaledPoolBuffers::new(
                &device,
                &quad_tex_bgl,
                &sampler_clamp,
                &filters,
                (stage_width / 4).max(1),
                (stage_height / 4).max(1),
                4,
                "rt_quarter",
            ))
        } else {
            None
        };

        let beam_glow_aux: Option<GpuTextureAsset> = quarter_pool.as_ref().map(|qp| {
            GpuTextureAsset::create_render_target(
                &device,
                &quad_tex_bgl,
                &sampler_clamp,
                qp.width,
                qp.height,
                false,
                "beam_glow_aux",
            )
        });

        let mask_atlas = GpuTextureAsset::create_render_target(
            &device,
            &quad_tex_bgl,
            &sampler_clamp,
            MASK_ATLAS_SIZE,
            MASK_ATLAS_SIZE,
            false,
            "live2d_mask_atlas",
        );

        let padded_bytes_per_row: u32 =
            align_to(stage_width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback_size: u64 = (padded_bytes_per_row as u64) * (stage_height as u64);
        let make_readback = |label: &str, byte_size: u64| -> wgpu::Buffer {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: byte_size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let readback_bufs: Option<[wgpu::Buffer; READBACK_RING_DEPTH]> = None;
        let yuv_resources: Option<GpuYuvPackResources> =
            filters.compute.as_ref().map(|cs| {
                let y_words: u32 = (stage_width * stage_height) / 4;
                let uv_bytes: u32 = (stage_width / 2) * (stage_height / 2);
                let uv_words: u32 = uv_bytes.div_ceil(4);
                let yuv_byte_len: u64 = ((y_words + 2 * uv_words) as u64) * 4;
                let gpu_buf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("gpu_yuv_pack_buf"),
                    size: yuv_byte_len,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                let yuv_u: YuvConvertUniformGpu = YuvConvertUniformGpu {
                    width: stage_width,
                    height: stage_height,
                    y_words,
                    uv_words,
                };
                let uniform_buf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("gpu_yuv_pack_ubuf"),
                    size: std::mem::size_of::<YuvConvertUniformGpu>() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                queue.write_buffer(&uniform_buf, 0, bytemuck::bytes_of(&yuv_u));
                let pack_bg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("gpu_yuv_pack_bg"),
                    layout: &cs.yuv_pack_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: gpu_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: uniform_buf.as_entire_binding(),
                        },
                    ],
                });
                let yuv_readback_bufs: [wgpu::Buffer; READBACK_RING_DEPTH] =
                    std::array::from_fn(|i| {
                        make_readback(&format!("frame_yuv_readback_buf_{i}"), yuv_byte_len)
                    });
                let fused_aux_none: wgpu::BindGroup = filters
                    .create_fused_aux_bind_group(
                        &device,
                        &pool_views[SLOT_STAGE_ROOT],
                        &pool_views[SLOT_UI_RT],
                        "fused_aux_none",
                    )
                    .expect("compute checked");
                let fused_aux_half: Option<wgpu::BindGroup> = half_pool.as_ref().and_then(|hp| {
                    filters.create_fused_aux_bind_group(
                        &device,
                        &hp._views[2],
                        &pool_views[SLOT_UI_RT],
                        "fused_aux_half",
                    )
                });
                let fused_aux_quarter: Option<wgpu::BindGroup> =
                    quarter_pool.as_ref().and_then(|qp| {
                        filters.create_fused_aux_bind_group(
                            &device,
                            &qp._views[2],
                            &pool_views[SLOT_UI_RT],
                            "fused_aux_quarter",
                        )
                    });
                GpuYuvPackResources {
                    y_words,
                    uv_words,
                    yuv_byte_len,
                    gpu_buf,
                    _uniform_buf: uniform_buf,
                    pack_bg,
                    fused_aux_none,
                    fused_aux_half,
                    fused_aux_quarter,
                    readback_bufs: yuv_readback_bufs,
                }
            });

        let scratches: [Option<FrameScratch>; READBACK_RING_DEPTH] = std::array::from_fn(|_| {
            Some(FrameScratch::new(
                &device,
                &filters,
                &live2d_mask_ubgl,
                &live2d_draw_ubgl,
                uniform_stride,
                storage_align,
            ))
        });

        let ui_bitmaps = BuiltinUiBitmaps::render_for_stage(stage_width, stage_height)?;
        let bg_w: usize = ui_bitmaps.text_background.width as usize;
        let bg_h: usize = ui_bitmaps.text_background.height as usize;
        let first_nz_row: usize = (0..bg_h)
            .find(|&row| {
                let start: usize = row * bg_w * 4;
                let end: usize = start + bg_w * 4;
                ui_bitmaps.text_background.data[start..end]
                    .chunks_exact(4)
                    .any(|px| px[3] > 0)
            })
            .unwrap_or(bg_h);
        let ui_text_bg_min_y: u32 = (((first_nz_row as u64) * (stage_height as u64))
            / (bg_h.max(1) as u64))
            .saturating_sub(2)
            .min(stage_height as u64) as u32;
        let ui_text_bg = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &quad_tex_bgl,
            &sampler_clamp,
            &ui_bitmaps.text_background,
            "ui_txt_bg",
        );
        let ui_text_underline = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &quad_tex_bgl,
            &sampler_clamp,
            &ui_bitmaps.text_underline,
            "ui_underline",
        );
        let ui_telop = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &quad_tex_bgl,
            &sampler_clamp,
            &ui_bitmaps.telop,
            "ui_telop",
        );
        let ui_hologram = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &quad_tex_bgl,
            &sampler_clamp,
            &ui_bitmaps.hologram,
            "ui_hologram",
        );

        Ok(Self {
            device,
            queue,
            stage_width,
            stage_height,
            uniform_stride,
            filters,
            quad_tex_bgl,
            quad_pipe_normal,
            quad_pipe_replace,
            quad_pipe_add,
            quad_pipe_pointwise,
            bloom_pipe_normal,
            empty_bg,
            beam_glow_aux,
            sampler_clamp,
            sampler_mipmap,
            white_tex,
            live2d_mask_ubgl,
            live2d_mask_tbgl,
            live2d_mask_pipe_cull,
            live2d_mask_pipe_nocull,
            live2d_draw_ubgl,
            live2d_draw_tbgl,
            live2d_pipes,
            pool_textures,
            pool_views,
            pool_quad_bgs,
            pool_filter_bgs,
            pool_cs_dst_bgs,
            pool_cs_orig_bgs,
            half_pool,
            quarter_pool,
            mask_atlas,
            readback_bufs,
            readback_byte_size: readback_size,
            yuv_resources,
            scratches,
            next_slot: 0,
            in_flight: VecDeque::with_capacity(READBACK_RING_DEPTH),
            padded_bytes_per_row,
            ui_text_bg,
            ui_text_bg_min_y,
            ui_text_underline,
            ui_telop,
            ui_hologram,
            backgrounds: HashMap::new(),
            model_caches: HashMap::new(),
            cached_body: CachedTextTexture::default(),
            cached_speaker: CachedTextTexture::default(),
            cached_telop: CachedTextTexture::default(),
            cached_ui: CachedUiState::default(),
        })
    }

    pub fn register_background_from_file(
        &mut self,
        key: &str,
        path: &Path,
    ) -> Result<(), RendererError> {
        if self.backgrounds.contains_key(key) {
            return Ok(());
        }
        let pre: PrecomputedTextureMips = precompute_background_mips(path)?;
        self.register_background_precomputed(key, &pre);
        Ok(())
    }

    pub(crate) fn register_background_precomputed(
        &mut self,
        key: &str,
        pre: &PrecomputedTextureMips,
    ) {
        if self.backgrounds.contains_key(key) {
            return;
        }
        let tex: GpuTextureAsset = GpuTextureAsset::from_precomputed_mips(
            &self.device,
            &self.queue,
            &self.quad_tex_bgl,
            &self.sampler_mipmap,
            pre,
            &format!("bg_{key}"),
        );
        self.backgrounds.insert(key.to_string(), tex);
    }

    pub fn register_live2d_model(&mut self, key: &str, model: &Live2DModelInstance) {
        if self.model_caches.contains_key(key) {
            return;
        }
        let pre_textures: Vec<PrecomputedTextureMips> = precompute_model_texture_mips(model);
        self.register_live2d_model_precomputed(key, model, &pre_textures);
    }

    pub(crate) fn register_live2d_model_precomputed(
        &mut self,
        key: &str,
        model: &Live2DModelInstance,
        pre_textures: &[PrecomputedTextureMips],
    ) {
        if self.model_caches.contains_key(key) {
            return;
        }
        let textures: Vec<GpuTextureAsset> = pre_textures
            .iter()
            .enumerate()
            .map(|(i, pre)| {
                GpuTextureAsset::from_precomputed_mips(
                    &self.device,
                    &self.queue,
                    &self.quad_tex_bgl,
                    &self.sampler_mipmap,
                    pre,
                    &format!("l2d_{key}_{i}"),
                )
            })
            .collect();

        let meshes = model.meshes();
        let mut total_verts: usize = 0;
        let mut all_indices: Vec<u16> = Vec::new();
        let mut mesh_ranges: Vec<(i32, u32, u32)> = Vec::with_capacity(meshes.len());
        for mesh in meshes {
            let base_v: i32 = total_verts as i32;
            total_verts += mesh.vertices().len();
            let idx_start: u32 = all_indices.len() as u32;
            all_indices.extend_from_slice(mesh.indices());
            let idx_count: u32 = mesh.indices().len() as u32;
            mesh_ranges.push((base_v, idx_start, idx_count));
        }

        let idx_byte_len: usize = align_to((all_indices.len().max(2) * 2) as u32, 4) as usize;
        let ibuf: wgpu::Buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("l2d_ibo"),
            size: idx_byte_len as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !all_indices.is_empty() {
            let raw_idx: &[u8] = bytemuck::cast_slice(&all_indices);
            let mut padded_idx: Vec<u8> = raw_idx.to_vec();
            while padded_idx.len() % 4 != 0 {
                padded_idx.push(0);
            }
            self.queue.write_buffer(&ibuf, 0, &padded_idx);
        }

        let mask_tbgs: Vec<wgpu::BindGroup> = textures
            .iter()
            .map(|t| {
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("l2d_mask_tbg"),
                    layout: &self.live2d_mask_tbgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&t.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&self.sampler_clamp),
                        },
                    ],
                })
            })
            .collect();

        let draw_tbgs: Vec<wgpu::BindGroup> = textures
            .iter()
            .map(|t| {
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("l2d_draw_tbg"),
                    layout: &self.live2d_draw_tbgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&t.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&self.mask_atlas.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&self.sampler_mipmap),
                        },
                    ],
                })
            })
            .collect();

        self.model_caches.insert(
            key.to_string(),
            ModelGpuCache {
                textures,
                ibuf,
                mesh_ranges,
                total_verts,
                mask_tbgs,
                draw_tbgs,
            },
        );
    }

    /// Returns whether GPU compute BT.709 YUV420p packing is active on this adapter.
    pub fn supports_gpu_yuv(&self) -> bool {
        self.yuv_resources.is_some()
    }

    /// Renders one complete composited frame synchronously and returns tight RGBA8 bytes.
    pub fn render_frame(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
    ) -> Result<Vec<u8>, RendererError> {
        let mut rgba: Vec<u8> = Vec::new();
        self.render_frame_into(input, text_renderer, &mut rgba)?;
        Ok(rgba)
    }

    #[cfg(test)]
    pub(crate) fn render_frame_with_force_render_filters(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
        force_render_filters: bool,
    ) -> Result<Vec<u8>, RendererError> {
        self.flush_all_pending_discard()?;
        self.submit_frame_internal(input, text_renderer, ReadbackKind::Rgba, force_render_filters)?;
        let mut rgba_out: Vec<u8> = Vec::new();
        let _ = self.finish_pending_frame_into(&mut rgba_out)?;
        Ok(rgba_out)
    }

    /// Renders one complete composited frame synchronously into `rgba_out`.
    pub fn render_frame_into(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
        rgba_out: &mut Vec<u8>,
    ) -> Result<(), RendererError> {
        self.flush_all_pending_discard()?;
        self.submit_frame_internal(input, text_renderer, ReadbackKind::Rgba, false)?;
        let _ = self.finish_pending_frame_into(rgba_out)?;
        Ok(())
    }

    fn flush_all_pending_discard(&mut self) -> Result<(), RendererError> {
        let mut discarded_rgba: Vec<u8> = Vec::new();
        let mut discarded_yuv: YuvFrame = YuvFrame {
            width: self.stage_width as usize,
            height: self.stage_height as usize,
            y: Vec::new(),
            u: Vec::new(),
            v: Vec::new(),
        };
        while let Some(pending) = self.in_flight.pop_front() {
            match pending.kind {
                ReadbackKind::Rgba => self.drain_readback_rgba_into(pending, &mut discarded_rgba)?,
                ReadbackKind::Yuv => self.drain_readback_yuv_into(pending, &mut discarded_yuv)?,
            }
        }
        Ok(())
    }

    /// Submits `input` on the next readback ring slot and, once all `READBACK_RING_DEPTH` slots
    /// are busy, drains the oldest completed RGBA8 frame into `prev_rgba_out` (returning `Ok(true)`).
    pub fn submit_and_drain_previous_into(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
        prev_rgba_out: &mut Vec<u8>,
    ) -> Result<bool, RendererError> {
        let mut drained: bool = false;
        if self.in_flight.len() >= READBACK_RING_DEPTH {
            if let Some(oldest) = self.in_flight.pop_front() {
                self.drain_readback_rgba_into(oldest, prev_rgba_out)?;
                drained = true;
            }
        }
        self.submit_frame_internal(input, text_renderer, ReadbackKind::Rgba, false)?;
        Ok(drained)
    }

    /// Submits `input` on the next readback ring slot (producing GPU-packed YUV420p when supported)
    /// and drains the oldest completed frame into `prev_yuv_out` once the ring is full.
    pub fn submit_and_drain_previous_yuv_into(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
        prev_yuv_out: &mut YuvFrame,
    ) -> Result<bool, RendererError> {
        let mut drained: bool = false;
        if self.in_flight.len() >= READBACK_RING_DEPTH {
            if let Some(oldest) = self.in_flight.pop_front() {
                self.drain_readback_yuv_into(oldest, prev_yuv_out)?;
                drained = true;
            }
        }
        let kind: ReadbackKind = if self.yuv_resources.is_some() {
            ReadbackKind::Yuv
        } else {
            ReadbackKind::Rgba
        };
        self.submit_frame_internal(input, text_renderer, kind, false)?;
        Ok(drained)
    }

    /// Completes the oldest in-flight pipelined RGBA8 frame into `rgba_out`, returning `Ok(false)` when empty.
    pub fn finish_pending_frame_into(
        &mut self,
        rgba_out: &mut Vec<u8>,
    ) -> Result<bool, RendererError> {
        let Some(pending) = self.in_flight.pop_front() else {
            return Ok(false);
        };
        self.drain_readback_rgba_into(pending, rgba_out)?;
        Ok(true)
    }

    /// Completes the oldest in-flight pipelined YUV420p frame into `yuv_out`, returning `Ok(false)` when empty.
    pub fn finish_pending_yuv_into(
        &mut self,
        yuv_out: &mut YuvFrame,
    ) -> Result<bool, RendererError> {
        let Some(pending) = self.in_flight.pop_front() else {
            return Ok(false);
        };
        self.drain_readback_yuv_into(pending, yuv_out)?;
        Ok(true)
    }

    fn wait_for_mapping(
        &self,
        pending: &InFlightReadback,
    ) -> Result<(), RendererError> {
        let _ = self.device.poll(wgpu::PollType::Wait {
            submission_index: Some(pending.submission_index.clone()),
            timeout: None,
        });
        let map_res: Result<(), wgpu::BufferAsyncError> = match pending.rx.try_recv() {
            Ok(r) => r,
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
                pending
                    .rx
                    .recv()
                    .map_err(|_| RendererError::Gpu("GPU readback channel closed".to_string()))?
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err(RendererError::Gpu("GPU readback channel closed".to_string()));
            }
        };
        map_res.map_err(|err| RendererError::Gpu(format!("GPU buffer map failed: {err}")))
    }

    fn drain_readback_rgba_into(
        &self,
        pending: InFlightReadback,
        rgba_out: &mut Vec<u8>,
    ) -> Result<(), RendererError> {
        self.wait_for_mapping(&pending)?;
        let buf: &wgpu::Buffer = &self
            .readback_bufs
            .as_ref()
            .expect("RGBA readback buffers initialized")[pending.slot];
        let slice = buf.slice(..);
        let mapped = slice
            .get_mapped_range()
            .map_err(|err| RendererError::Gpu(format!("GPU buffer map range failed: {err}")))?;
        let row_bytes: usize = (self.stage_width * 4) as usize;
        let stride: usize = self.padded_bytes_per_row as usize;
        let height: usize = self.stage_height as usize;
        let total_bytes: usize = row_bytes * height;
        rgba_out.resize(total_bytes, 0);
        if stride == row_bytes {
            rgba_out.copy_from_slice(&mapped[..total_bytes]);
        } else {
            for row in 0..height {
                let src_start: usize = row * stride;
                let dst_start: usize = row * row_bytes;
                rgba_out[dst_start..dst_start + row_bytes]
                    .copy_from_slice(&mapped[src_start..src_start + row_bytes]);
            }
        }
        drop(mapped);
        buf.unmap();
        Ok(())
    }

    fn drain_readback_yuv_into(
        &self,
        pending: InFlightReadback,
        yuv_out: &mut YuvFrame,
    ) -> Result<(), RendererError> {
        let w: usize = self.stage_width as usize;
        let h: usize = self.stage_height as usize;
        let cw: usize = w / 2;
        let ch: usize = h / 2;
        yuv_out.width = w;
        yuv_out.height = h;

        if pending.kind == ReadbackKind::Rgba {
            let mut rgba: Vec<u8> = Vec::new();
            self.drain_readback_rgba_into(pending, &mut rgba)?;
            crate::renderer::encoder::rgba_to_yuv420p_bt709(
                &rgba,
                w,
                h,
                &mut yuv_out.y,
                &mut yuv_out.u,
                &mut yuv_out.v,
            );
            return Ok(());
        }

        let yuv_res: &GpuYuvPackResources = self.yuv_resources.as_ref().ok_or_else(|| {
            RendererError::Gpu("GPU YUV resources missing for YUV readback".to_string())
        })?;
        self.wait_for_mapping(&pending)?;
        let buf: &wgpu::Buffer = &yuv_res.readback_bufs[pending.slot];
        let slice = buf.slice(..);
        let mapped = slice
            .get_mapped_range()
            .map_err(|err| RendererError::Gpu(format!("GPU YUV buffer map range failed: {err}")))?;

        let y_bytes: usize = w * h;
        let uv_bytes: usize = cw * ch;
        let u_off: usize = (yuv_res.y_words as usize) * 4;
        let v_off: usize = u_off + (yuv_res.uv_words as usize) * 4;

        yuv_out.y.resize(y_bytes, 16);
        yuv_out.u.resize(uv_bytes, 128);
        yuv_out.v.resize(uv_bytes, 128);
        yuv_out.y.copy_from_slice(&mapped[..y_bytes]);
        yuv_out.u.copy_from_slice(&mapped[u_off..u_off + uv_bytes]);
        yuv_out.v.copy_from_slice(&mapped[v_off..v_off + uv_bytes]);

        drop(mapped);
        buf.unmap();
        Ok(())
    }

    fn submit_frame_internal(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
        readback_kind: ReadbackKind,
        force_render_filters: bool,
    ) -> Result<(), RendererError> {
        let sw: f32 = self.stage_width as f32;
        let sh: f32 = self.stage_height as f32;
        let slot: usize = self.next_slot;

        // Opaque fade short-circuit: solid fade covers the entire stage, so skip models, UI & filters.
        let is_opaque_fade: bool = input.fade_visible && input.fade_alpha >= 1.0 - 1e-5;
        if is_opaque_fade {
            let mut encoder: wgpu::CommandEncoder =
                self.device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("frame_opaque_fade_encoder"),
                    });
            let a: f64 = input.fade_alpha.clamp(0.0, 1.0) as f64;
            let clear_col: wgpu::Color = wgpu::Color {
                r: (input.fade_color[0] as f64) * a,
                g: (input.fade_color[1] as f64) * a,
                b: (input.fade_color[2] as f64) * a,
                a,
            };
            self.clear_rt(&mut encoder, SLOT_FINAL_OUTPUT, clear_col);
            self.enqueue_readback(encoder, slot, readback_kind, false);
            return Ok(());
        }

        // Pre-update dynamic UI text textures cleanly outside active command encoder borrows.
        if input.dialogue_visible && input.dialogue_body_alpha > 0.0 {
            self.ensure_text_texture(text_renderer, TextSlot::Body, input.dialogue_body_text)?;
        }
        if input.dialogue_visible && input.dialogue_speaker_alpha > 0.0 {
            self.ensure_text_texture(
                text_renderer,
                TextSlot::Speaker,
                input.dialogue_speaker_text,
            )?;
        }
        if input.telop_visible && input.telop_alpha > 0.0 {
            self.ensure_text_texture(text_renderer, TextSlot::Telop, input.telop_text)?;
        }

        // Compute upper bounds for persistent per-slot buffers before recording passes.
        let mut req_l2d_verts: usize = 0;
        let mut req_l2d_indices: usize = 0;
        let mut req_draw_slots: usize = 0;
        let mut req_quad_verts: usize = 96;
        let mut req_filter_slots: usize = FilterPipelines::estimate_passes(input.stage_filters)
            + FilterPipelines::estimate_passes(input.screen_filters)
            + 8;
        for model_in in input.models {
            if !model_in.model.stage.visible || model_in.model.stage.alpha <= 0.0 {
                continue;
            }
            if let Some(cache) = self.model_caches.get(&model_in.model.key) {
                req_l2d_verts += cache.total_verts;
                req_l2d_indices += cache
                    .mesh_ranges
                    .last()
                    .map(|r| (r.1 + r.2) as usize)
                    .unwrap_or(0);
                req_draw_slots += cache.mesh_ranges.len();
            }
            req_quad_verts += model_in.particles.len() * 3 + model_in.hologram_beams.len() * 24 + 12;
            req_filter_slots += FilterPipelines::estimate_passes(model_in.parent_filters) + 1;
            for beam in model_in.hologram_beams {
                req_filter_slots += FilterPipelines::estimate_passes(&beam.filters);
            }
        }
        let req_mask_slots: usize = req_draw_slots.saturating_mul(2).max(512);
        let req_post_chain_slots: usize = req_filter_slots + input.models.len() + 4;

        let mut scratch: FrameScratch = self
            .scratches[slot]
            .take()
            .ok_or_else(|| RendererError::Gpu("Frame scratch missing for slot".to_string()))?;
        scratch.prepare(
            &self.device,
            &self.filters,
            &self.live2d_mask_ubgl,
            &self.live2d_draw_ubgl,
            req_quad_verts,
            req_l2d_verts,
            req_l2d_indices,
            req_mask_slots,
            req_draw_slots,
            req_filter_slots,
            req_post_chain_slots,
        );

        let stage_has_filters: bool = has_effective_filters(input.stage_filters);
        let screen_has_filters: bool = has_effective_filters(input.screen_filters);
        let telop_active: bool = input.telop_visible && input.telop_alpha > 0.0;
        let has_dialogue_layer: bool = input.dialogue_visible
            && (input.dialogue_bg_alpha > 0.0
                || input.dialogue_underline_alpha > 0.0
                || (input.dialogue_body_alpha > 0.0 && self.cached_body.surface.is_some())
                || (input.dialogue_speaker_alpha > 0.0 && self.cached_speaker.surface.is_some()));
        let has_ui_overlay: bool = has_dialogue_layer || telop_active;

        let mut encoder: wgpu::CommandEncoder =
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("frame_encoder"),
                });
        let (ui_min_y, ui_max_y): (u32, u32) = if has_ui_overlay {
            self.ensure_ui_rt(&mut encoder, &mut scratch, input, telop_active)
        } else {
            (0, 0)
        };

        let record_result: Result<(), RendererError> = (|| {
            // 1+2. Render Background + all Live2D models + child VFX + parent filters + inline UI
            // (when `!stage_has_filters`) into `SLOT_STAGE_ROOT` using cached `SLOT_UI_RT`.
            let inline_ui: Vec<(&wgpu::BindGroup, u32, u32)> =
                if !stage_has_filters && has_ui_overlay {
                    let ui_verts: [QuadVertex; 4] = if ui_max_y > ui_min_y {
                        let reg: FilterRegion = FilterRegion {
                            x: 0,
                            y: ui_min_y,
                            w: self.stage_width,
                            h: ui_max_y - ui_min_y,
                        };
                        translated_stage_quad_verts(reg, (0, ui_min_y), sw, sh, [1.0; 4])
                    } else {
                        full_ndc_quad([1.0; 4])
                    };
                    let (us, ue) = Self::push_quad_tris(&mut scratch.quad_verts, &ui_verts);
                    vec![(&self.pool_quad_bgs[SLOT_UI_RT], us, ue)]
                } else {
                    Vec::new()
                };
            self.render_scene_root_batched(
                &mut encoder,
                &mut scratch,
                input,
                &inline_ui,
                force_render_filters,
            )?;

            let half_level: Option<ScaledPoolLevel<'_>> =
                self.half_pool.as_ref().map(ScaledPoolBuffers::as_level);
            let quarter_level: Option<ScaledPoolLevel<'_>> =
                self.quarter_pool.as_ref().map(ScaledPoolBuffers::as_level);
            let full_region: FilterRegion = FilterRegion::full(self.stage_width, self.stage_height);

            let can_use_fused_yuv: bool = matches!(readback_kind, ReadbackKind::Yuv)
                && self.yuv_resources.is_some()
                && !force_render_filters
                && self.stage_width >= 8
                && self.stage_height >= 2
                && self.stage_width % 8 == 0
                && self.stage_height % 2 == 0
                && scratch.chain_scratch.is_some();

            // 3+4+5. Apply Stage filters, overlay UI only when Stage filters were active, and Screen filters.
            let run_full_chain = |enc: &mut wgpu::CommandEncoder,
                                  sc: &mut FrameScratch,
                                  src_slot: usize,
                                  filters: &[GpuFilterSpec],
                                  defer_yuv: bool|
             -> FilterChainOutput {
                if let Some(cs_scratch) = sc.chain_scratch.as_mut() {
                    self.filters.apply_chain_advanced(
                        enc,
                        &self.pool_views,
                        &self.pool_filter_bgs,
                        &self.pool_cs_dst_bgs,
                        &self.pool_cs_orig_bgs,
                        half_level.as_ref(),
                        quarter_level.as_ref(),
                        &mut sc.filter_scratch,
                        cs_scratch,
                        src_slot,
                        SCRATCH_START,
                        self.stage_width,
                        self.stage_height,
                        full_region,
                        filters,
                        defer_yuv,
                        force_render_filters,
                    )
                } else {
                    let s: usize = self.filters.apply_chain(
                        enc,
                        &self.pool_views,
                        &self.pool_filter_bgs,
                        &self.pool_cs_dst_bgs,
                        &self.pool_cs_orig_bgs,
                        &mut sc.filter_scratch,
                        src_slot,
                        SCRATCH_START,
                        self.stage_width,
                        self.stage_height,
                        full_region,
                        filters,
                        force_render_filters,
                    );
                    FilterChainOutput {
                        slot: s,
                        deferred_bloom: None,
                        trailing_pointwise_start: filters.len(),
                    }
                }
            };

            let mut combined_filters: Vec<GpuFilterSpec> = Vec::new();
            let mut post_ui_active: bool = false;
            let mut post_stage_op_count: usize = 0;
            let (final_chain_out, trailing_filters): (FilterChainOutput, &[GpuFilterSpec]) =
                if !stage_has_filters {
                    let out: FilterChainOutput = run_full_chain(
                        &mut encoder,
                        &mut scratch,
                        SLOT_STAGE_ROOT,
                        input.screen_filters,
                        can_use_fused_yuv,
                    );
                    let start: usize = out.trailing_pointwise_start;
                    (out, &input.screen_filters[start..])
                } else if !has_ui_overlay {
                    if !screen_has_filters {
                        let out: FilterChainOutput = run_full_chain(
                            &mut encoder,
                            &mut scratch,
                            SLOT_STAGE_ROOT,
                            input.stage_filters,
                            can_use_fused_yuv,
                        );
                        let start: usize = out.trailing_pointwise_start;
                        (out, &input.stage_filters[start..])
                    } else {
                        combined_filters
                            .reserve(input.stage_filters.len() + input.screen_filters.len());
                        combined_filters.extend_from_slice(input.stage_filters);
                        combined_filters.extend_from_slice(input.screen_filters);
                        let out: FilterChainOutput = run_full_chain(
                            &mut encoder,
                            &mut scratch,
                            SLOT_STAGE_ROOT,
                            &combined_filters,
                            can_use_fused_yuv,
                        );
                        let start: usize = out.trailing_pointwise_start;
                        (out, &combined_filters[start..])
                    }
                } else {
                    let screen_all_pw: bool =
                        input.screen_filters.iter().all(is_pointwise_filter);
                    let screen_pw_count: usize = input
                        .screen_filters
                        .iter()
                        .filter(|f| !matches!(f, GpuFilterSpec::Alpha(a) if (*a - 1.0).abs() <= 1e-6))
                        .count();
                    let mut stage_tail_pw: usize = 0;
                    let mut si: usize = input.stage_filters.len();
                    while si > 0
                        && is_pointwise_filter(&input.stage_filters[si - 1])
                        && stage_tail_pw < MAX_FUSED_POINTWISE_OPS
                    {
                        si -= 1;
                        if !matches!(input.stage_filters[si], GpuFilterSpec::Alpha(a) if (a - 1.0).abs() <= 1e-6)
                        {
                            stage_tail_pw += 1;
                        }
                    }
                    let fuse_stage_ui_screen: bool = can_use_fused_yuv
                        && screen_all_pw
                        && (stage_tail_pw + screen_pw_count + 1) <= MAX_FUSED_POINTWISE_OPS;

                    if fuse_stage_ui_screen {
                        let stage_out: FilterChainOutput = run_full_chain(
                            &mut encoder,
                            &mut scratch,
                            SLOT_STAGE_ROOT,
                            input.stage_filters,
                            true,
                        );
                        let stage_tail: &[GpuFilterSpec] =
                            &input.stage_filters[stage_out.trailing_pointwise_start..];
                        post_stage_op_count = stage_tail
                            .iter()
                            .filter(|f| !matches!(f, GpuFilterSpec::Alpha(a) if (*a - 1.0).abs() <= 1e-6))
                            .count();
                        combined_filters.reserve(stage_tail.len() + input.screen_filters.len());
                        combined_filters.extend_from_slice(stage_tail);
                        combined_filters.extend_from_slice(input.screen_filters);
                        post_ui_active = true;
                        (stage_out, &combined_filters[..])
                    } else {
                        let stage_filtered_slot: usize = run_full_chain(
                            &mut encoder,
                            &mut scratch,
                            SLOT_STAGE_ROOT,
                            input.stage_filters,
                            false,
                        )
                        .slot;

                        let ui_verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
                        let (us, ue) = Self::push_quad_tris(&mut scratch.quad_verts, &ui_verts);
                        self.draw_batched_quad_pass(
                            &mut encoder,
                            &scratch,
                            stage_filtered_slot,
                            None,
                            &[(&self.pool_quad_bgs[SLOT_UI_RT], us, ue)],
                        );

                        let screen_out: FilterChainOutput = run_full_chain(
                            &mut encoder,
                            &mut scratch,
                            stage_filtered_slot,
                            input.screen_filters,
                            can_use_fused_yuv,
                        );
                        let start: usize = screen_out.trailing_pointwise_start;
                        (screen_out, &input.screen_filters[start..])
                    }
                };

            // 6+7. Fuse trailing Bloom + Stage pointwise + Cached UI overlay + Screen pointwise +
            // backdrop clear + fade + BT.709 YUV420p directly in a single compute dispatch.
            let bg: [f32; 4] = input.background_clear;
            let mut fused_yuv_dispatched: bool = false;
            if can_use_fused_yuv {
                if let (Some(yuv), Some(cs_scratch)) =
                    (self.yuv_resources.as_ref(), scratch.chain_scratch.as_mut())
                {
                    let mut ops: [PointwiseOpGpu; MAX_FUSED_POINTWISE_OPS] = Default::default();
                    let mut op_count: usize = 0;
                    let mut stage_emitted: usize = 0;
                    let mut ui_inserted: bool = !post_ui_active;
                    for spec in trailing_filters {
                        if !ui_inserted && stage_emitted == post_stage_op_count {
                            if op_count < MAX_FUSED_POINTWISE_OPS {
                                ops[op_count] = PointwiseOpGpu {
                                    kind: 6,
                                    p0: [ui_min_y as f32, ui_max_y as f32, 0.0, 0.0],
                                    ..Default::default()
                                };
                                op_count += 1;
                            }
                            ui_inserted = true;
                        }
                        if op_count >= MAX_FUSED_POINTWISE_OPS {
                            break;
                        }
                        if let GpuFilterSpec::Alpha(a) = spec {
                            if (*a - 1.0).abs() <= 1e-6 {
                                continue;
                            }
                        }
                        if let Some(encoded) =
                            encode_pointwise_op(spec, self.stage_width, self.stage_height)
                        {
                            ops[op_count] = encoded;
                            op_count += 1;
                            stage_emitted += 1;
                        }
                    }
                    if !ui_inserted && op_count < MAX_FUSED_POINTWISE_OPS {
                        ops[op_count] = PointwiseOpGpu {
                            kind: 6,
                            p0: [ui_min_y as f32, ui_max_y as f32, 0.0, 0.0],
                            ..Default::default()
                        };
                        op_count += 1;
                    }
                    let (has_bloom_glow, bloom_uv_scale, bloom_uv_max, aux_bg): (
                        u32,
                        [f32; 2],
                        [f32; 2],
                        &wgpu::BindGroup,
                    ) = match final_chain_out.deferred_bloom {
                        Some(bloom) => {
                            let bg_ref: &wgpu::BindGroup = if bloom.use_quarter {
                                yuv.fused_aux_quarter.as_ref().expect("quarter_pool")
                            } else {
                                yuv.fused_aux_half.as_ref().expect("half_pool")
                            };
                            (bloom.mode, bloom.uv_scale, bloom.uv_max, bg_ref)
                        }
                        None => (0u32, [0.0; 2], [1.0; 2], &yuv.fused_aux_none),
                    };
                    let fade_alpha: f32 = if input.fade_visible && input.fade_alpha > 0.0 {
                        input.fade_alpha.clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let post_u: PostChainUniformGpu = PostChainUniformGpu {
                        width: self.stage_width,
                        height: self.stage_height,
                        y_words: yuv.y_words,
                        uv_words: yuv.uv_words,
                        dst_offset_x: 0,
                        dst_offset_y: 0,
                        dispatch_w: self.stage_width,
                        dispatch_h: self.stage_height,
                        op_count: op_count as u32,
                        apply_backdrop: 1,
                        has_bloom_glow,
                        skip_transparent: 0,
                        backdrop_clear: [bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]],
                        fade_color_premul: [
                            input.fade_color[0] * fade_alpha,
                            input.fade_color[1] * fade_alpha,
                            input.fade_color[2] * fade_alpha,
                            fade_alpha,
                        ],
                        bloom_uv_scale,
                        bloom_uv_max,
                        stage_inv_dims: [1.0 / sw, 1.0 / sh],
                        uv_px_offset: [0.0, 0.0],
                        fade_alpha,
                        _pad_tail: [0; 3],
                        ops,
                    };
                    fused_yuv_dispatched = self.filters.encode_fused_yuv420p_pass(
                        &mut encoder,
                        &self.pool_filter_bgs[final_chain_out.slot],
                        &yuv.pack_bg,
                        aux_bg,
                        cs_scratch,
                        &post_u,
                    );
                }
            }

            if !fused_yuv_dispatched {
                let clear_bg: wgpu::Color = wgpu::Color {
                    r: (bg[0] * bg[3]) as f64,
                    g: (bg[1] * bg[3]) as f64,
                    b: (bg[2] * bg[3]) as f64,
                    a: bg[3] as f64,
                };
                let mut final_batches: Vec<(&wgpu::BindGroup, u32, u32)> = Vec::with_capacity(2);
                let pres_verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
                let (p_start, p_end) = Self::push_quad_tris(&mut scratch.quad_verts, &pres_verts);
                final_batches.push((&self.pool_quad_bgs[final_chain_out.slot], p_start, p_end));
                if input.fade_visible && input.fade_alpha > 0.0 {
                    let a: f32 = input.fade_alpha;
                    let fade_col: [f32; 4] = [
                        input.fade_color[0] * a,
                        input.fade_color[1] * a,
                        input.fade_color[2] * a,
                        a,
                    ];
                    let fade_verts: [QuadVertex; 4] = full_ndc_quad(fade_col);
                    let (f_start, f_end) =
                        Self::push_quad_tris(&mut scratch.quad_verts, &fade_verts);
                    final_batches.push((&self.white_tex.quad_bg, f_start, f_end));
                }
                self.draw_batched_quad_pass(
                    &mut encoder,
                    &scratch,
                    SLOT_FINAL_OUTPUT,
                    Some(clear_bg),
                    &final_batches,
                );
            }

            scratch.flush(&self.queue);
            self.enqueue_readback(encoder, slot, readback_kind, fused_yuv_dispatched);
            Ok(())
        })();

        self.scratches[slot] = Some(scratch);
        record_result
    }

    fn enqueue_readback(
        &mut self,
        mut encoder: wgpu::CommandEncoder,
        slot: usize,
        readback_kind: ReadbackKind,
        yuv_already_packed: bool,
    ) {
        let target_buf: &wgpu::Buffer = match (readback_kind, self.yuv_resources.as_ref()) {
            (ReadbackKind::Yuv, Some(yuv)) => {
                if !yuv_already_packed {
                    self.filters.encode_yuv420p_pass(
                        &mut encoder,
                        &self.pool_filter_bgs[SLOT_FINAL_OUTPUT],
                        &yuv.pack_bg,
                        yuv.y_words,
                        yuv.uv_words,
                    );
                }
                encoder.copy_buffer_to_buffer(
                    &yuv.gpu_buf,
                    0,
                    &yuv.readback_bufs[slot],
                    0,
                    yuv.yuv_byte_len,
                );
                &yuv.readback_bufs[slot]
            }
            _ => {
                let readback_byte_size: u64 = self.readback_byte_size;
                let device: &wgpu::Device = &self.device;
                let readback_bufs: &[wgpu::Buffer; READBACK_RING_DEPTH] =
                    self.readback_bufs.get_or_insert_with(|| {
                        std::array::from_fn(|i| {
                            device.create_buffer(&wgpu::BufferDescriptor {
                                label: Some(&format!("frame_readback_buf_{i}")),
                                size: readback_byte_size,
                                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                                mapped_at_creation: false,
                            })
                        })
                    });
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.pool_textures[SLOT_FINAL_OUTPUT],
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &readback_bufs[slot],
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(self.padded_bytes_per_row),
                            rows_per_image: Some(self.stage_height),
                        },
                    },
                    wgpu::Extent3d {
                        width: self.stage_width,
                        height: self.stage_height,
                        depth_or_array_layers: 1,
                    },
                );
                &readback_bufs[slot]
            }
        };

        let submission_index: wgpu::SubmissionIndex = self.queue.submit(Some(encoder.finish()));
        let slice = target_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let actual_kind: ReadbackKind = if matches!(readback_kind, ReadbackKind::Yuv)
            && self.yuv_resources.is_some()
        {
            ReadbackKind::Yuv
        } else {
            ReadbackKind::Rgba
        };
        self.next_slot = (slot + 1) % READBACK_RING_DEPTH;
        self.in_flight.push_back(InFlightReadback {
            slot,
            kind: actual_kind,
            submission_index,
            rx,
        });
    }

    fn apply_region_filter_chain_with_offset(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        input_slot: usize,
        region: FilterRegion,
        uv_px_offset: [f32; 2],
        filters: &[GpuFilterSpec],
        allow_defer_trailing: bool,
        preferred_out_slot: Option<usize>,
        force_render_filters: bool,
    ) -> FilterChainOutput {
        if let Some(cs_scratch) = scratch.chain_scratch.as_mut() {
            let half_level: Option<ScaledPoolLevel<'_>> =
                self.half_pool.as_ref().map(ScaledPoolBuffers::as_level);
            let quarter_level: Option<ScaledPoolLevel<'_>> =
                self.quarter_pool.as_ref().map(ScaledPoolBuffers::as_level);
            self.filters.apply_chain_advanced_with_offset(
                encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                half_level.as_ref(),
                quarter_level.as_ref(),
                &mut scratch.filter_scratch,
                cs_scratch,
                input_slot,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                region,
                uv_px_offset,
                filters,
                allow_defer_trailing,
                preferred_out_slot,
                force_render_filters,
            )
        } else {
            let slot: usize = self.filters.apply_chain(
                encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                &mut scratch.filter_scratch,
                input_slot,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                region,
                filters,
                force_render_filters,
            );
            FilterChainOutput {
                slot,
                trailing_pointwise_start: filters.len(),
                deferred_bloom: None,
            }
        }
    }

    fn copy_pool_region(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        src_slot: usize,
        dst_slot: usize,
        dst_x: u32,
        dst_y: u32,
        w: u32,
        h: u32,
    ) {
        if src_slot == dst_slot || w == 0 || h == 0 {
            return;
        }
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.pool_textures[src_slot],
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: dst_x,
                    y: dst_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.pool_textures[dst_slot],
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: dst_x,
                    y: dst_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
    }

    fn render_telop_rt(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        input: &GpuRenderFrameInput<'_>,
    ) {
        let sw: f32 = self.stage_width as f32;
        let sh: f32 = self.stage_height as f32;
        let mut telop_batches: Vec<(&wgpu::BindGroup, u32, u32)> = Vec::with_capacity(2);
        let tw: f32 = self.ui_telop.width as f32;
        let th: f32 = self.ui_telop.height as f32;
        let bg_verts: [QuadVertex; 4] = stage_quad_verts(
            sw * 0.5 - tw * 0.5 + input.telop_x_offset,
            sh * 0.5 - th * 0.5,
            tw,
            th,
            sw,
            sh,
            [1.0; 4],
        );
        let (v_start, v_end) = Self::push_quad_tris(&mut scratch.quad_verts, &bg_verts);
        telop_batches.push((&self.ui_telop.quad_bg, v_start, v_end));
        if let Some((tex, ox, oy)) = &self.cached_telop.surface {
            let t_verts: [QuadVertex; 4] = stage_quad_verts(
                sw * 0.5 - 10.0 + input.telop_x_offset + ox,
                sh * 0.5 + sh / 300.0 + oy,
                tex.width as f32,
                tex.height as f32,
                sw,
                sh,
                [1.0; 4],
            );
            let (ts, te) = Self::push_quad_tris(&mut scratch.quad_verts, &t_verts);
            telop_batches.push((&tex.quad_bg, ts, te));
        }
        self.draw_batched_quad_pass(
            encoder,
            scratch,
            SLOT_TELOP_RT,
            Some(wgpu::Color::TRANSPARENT),
            &telop_batches,
        );
    }

    fn ensure_ui_rt(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        input: &GpuRenderFrameInput<'_>,
        telop_active: bool,
    ) -> (u32, u32) {
        let sw: f32 = self.stage_width as f32;
        let sh: f32 = self.stage_height as f32;
        let mut min_y: u32 = self.stage_height;
        let mut max_y: u32 = 0;

        if input.dialogue_visible {
            if input.dialogue_bg_alpha > 0.0 {
                min_y = min_y.min(self.ui_text_bg_min_y);
                max_y = max_y.max(self.stage_height);
            }
            if input.dialogue_underline_alpha > 0.0 {
                let uy: u32 = (sh / 1.3).floor().max(0.0) as u32;
                let uh: u32 = self.ui_text_underline.height;
                min_y = min_y.min(uy);
                max_y = max_y.max((uy + uh + 2).min(self.stage_height));
            }
            if input.dialogue_body_alpha > 0.0 {
                if let Some((tex, _, oy)) = &self.cached_body.surface {
                    let y0: u32 = (sh / 1.27 + oy).floor().max(0.0) as u32;
                    min_y = min_y.min(y0);
                    max_y = max_y.max((y0 + tex.height + 2).min(self.stage_height));
                }
            }
            if input.dialogue_speaker_alpha > 0.0 {
                if let Some((tex, _, oy)) = &self.cached_speaker.surface {
                    let y0: u32 = (sh / 1.3 - sw / 42.0 + oy).floor().max(0.0) as u32;
                    min_y = min_y.min(y0);
                    max_y = max_y.max((y0 + tex.height + 2).min(self.stage_height));
                }
            }
        }
        if telop_active {
            let th: f32 = self.ui_telop.height as f32;
            let ty0: u32 = (sh * 0.5 - th * 0.5).floor().max(0.0) as u32;
            let ty1: u32 = ((ty0 as f32) + th).ceil().min(sh) as u32;
            min_y = min_y.min(ty0);
            max_y = max_y.max(ty1);
        }
        if max_y <= min_y {
            min_y = 0;
            max_y = self.stage_height;
        }

        let key: CachedUiState = CachedUiState {
            valid: true,
            dialogue_visible: input.dialogue_visible,
            dialogue_bg_alpha: input.dialogue_bg_alpha.to_bits(),
            dialogue_underline_alpha: input.dialogue_underline_alpha.to_bits(),
            dialogue_body_alpha: if input.dialogue_visible {
                input.dialogue_body_alpha.to_bits()
            } else {
                0
            },
            dialogue_speaker_alpha: if input.dialogue_visible {
                input.dialogue_speaker_alpha.to_bits()
            } else {
                0
            },
            body_text: if input.dialogue_visible && input.dialogue_body_alpha > 0.0 {
                self.cached_body.source_text.clone()
            } else {
                String::new()
            },
            speaker_text: if input.dialogue_visible && input.dialogue_speaker_alpha > 0.0 {
                self.cached_speaker.source_text.clone()
            } else {
                String::new()
            },
            telop_active,
            telop_alpha: if telop_active {
                input.telop_alpha.to_bits()
            } else {
                0
            },
            telop_x_offset: if telop_active {
                input.telop_x_offset.to_bits()
            } else {
                0
            },
            telop_text: if telop_active {
                self.cached_telop.source_text.clone()
            } else {
                String::new()
            },
            min_y,
            max_y,
        };

        if self.cached_ui != key {
            if telop_active {
                self.render_telop_rt(encoder, scratch, input);
            }
            let pres_batches: Vec<(&wgpu::BindGroup, u32, u32)> =
                self.push_presentation_batches(scratch, input, telop_active);
            self.draw_batched_quad_pass(
                encoder,
                scratch,
                SLOT_UI_RT,
                Some(wgpu::Color::TRANSPARENT),
                &pres_batches,
            );
            self.cached_ui = key;
        }
        (min_y, max_y)
    }

    fn push_presentation_batches<'a>(
        &'a self,
        scratch: &mut FrameScratch,
        input: &GpuRenderFrameInput<'_>,
        telop_active: bool,
    ) -> Vec<(&'a wgpu::BindGroup, u32, u32)> {
        let sw: f32 = self.stage_width as f32;
        let sh: f32 = self.stage_height as f32;
        let mut pres_batches: Vec<(&'a wgpu::BindGroup, u32, u32)> = Vec::with_capacity(5);
        if input.dialogue_visible {
            if input.dialogue_bg_alpha > 0.0 {
                let a: f32 = input.dialogue_bg_alpha;
                let verts: [QuadVertex; 4] = stage_quad_verts(0.0, 0.0, sw, sh, sw, sh, [a; 4]);
                let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                pres_batches.push((&self.ui_text_bg.quad_bg, vs, ve));
            }
            if input.dialogue_underline_alpha > 0.0 {
                let a: f32 = input.dialogue_underline_alpha;
                let uw: f32 = self.ui_text_underline.width as f32;
                let uh: f32 = self.ui_text_underline.height as f32;
                let ux: f32 = sw / 10.0;
                let uy: f32 = sh / 1.3;
                let verts: [QuadVertex; 4] = stage_quad_verts(ux, uy, uw, uh, sw, sh, [a; 4]);
                let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                pres_batches.push((&self.ui_text_underline.quad_bg, vs, ve));
            }
            if input.dialogue_body_alpha > 0.0 {
                if let Some((tex, ox, oy)) = &self.cached_body.surface {
                    let a: f32 = input.dialogue_body_alpha;
                    let verts: [QuadVertex; 4] = stage_quad_verts(
                        sw / 8.0 + ox,
                        sh / 1.27 + oy,
                        tex.width as f32,
                        tex.height as f32,
                        sw,
                        sh,
                        [a; 4],
                    );
                    let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                    pres_batches.push((&tex.quad_bg, vs, ve));
                }
            }
            if input.dialogue_speaker_alpha > 0.0 {
                if let Some((tex, ox, oy)) = &self.cached_speaker.surface {
                    let a: f32 = input.dialogue_speaker_alpha;
                    let verts: [QuadVertex; 4] = stage_quad_verts(
                        sw / 9.0 + ox,
                        sh / 1.3 - sw / 42.0 + oy,
                        tex.width as f32,
                        tex.height as f32,
                        sw,
                        sh,
                        [a; 4],
                    );
                    let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                    pres_batches.push((&tex.quad_bg, vs, ve));
                }
            }
        }
        if telop_active {
            let alpha_verts: [QuadVertex; 4] = full_ndc_quad([input.telop_alpha; 4]);
            let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &alpha_verts);
            pres_batches.push((&self.pool_quad_bgs[SLOT_TELOP_RT], vs, ve));
        }
        pres_batches
    }

    fn draw_l2d_batches<'a>(
        &'a self,
        rpass: &mut wgpu::RenderPass<'a>,
        scratch: &'a FrameScratch,
        cache: &'a ModelGpuCache,
        batch_start: usize,
        batch_end: usize,
    ) {
        if batch_start >= batch_end {
            return;
        }
        rpass.set_vertex_buffer(0, scratch.l2d_vbuf.slice(..));
        rpass.set_index_buffer(scratch.l2d_ibuf.slice(..), wgpu::IndexFormat::Uint32);
        rpass.set_bind_group(0, &scratch.l2d_draw_sbg, &[]);
        let mut prev_pipe: Option<(usize, usize)> = None;
        let mut prev_tex: Option<usize> = None;
        for batch in &scratch.draw_batches[batch_start..batch_end] {
            if prev_pipe != Some((batch.blend_idx, batch.cull_idx)) {
                rpass.set_pipeline(&self.live2d_pipes[batch.blend_idx][batch.cull_idx]);
                prev_pipe = Some((batch.blend_idx, batch.cull_idx));
            }
            if prev_tex != Some(batch.tex_idx) {
                rpass.set_bind_group(1, &cache.draw_tbgs[batch.tex_idx], &[]);
                prev_tex = Some(batch.tex_idx);
            }
            rpass.draw_indexed(batch.idx_start..batch.idx_start + batch.idx_count, 0, 0..1);
        }
    }

    /// Renders Background + all Live2D models + child VFX + parent filters onto `SLOT_STAGE_ROOT`,
    /// coalescing masks (4-quadrant atlas), hologram beams (`SLOT_BEAM_RT`), offscreen models
    /// (`SLOT_MODEL_RT`), and UI overlays (when `!stage_has_filters`) into minimal Clear-only TBDR passes.
    #[allow(clippy::too_many_arguments)]
    fn render_scene_root_batched<'a, 'b>(
        &'a self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        input: &'b GpuRenderFrameInput<'b>,
        inline_ui: &[(&'a wgpu::BindGroup, u32, u32)],
        force_render_filters: bool,
    ) -> Result<(), RendererError> {
        struct PreparedBeam<'b> {
            spec: &'b HologramBeamRenderData,
            raw_verts: Vec<QuadVertex>,
            src_region: FilterRegion,
            dst_x: u32,
            dst_y: u32,
            bv_start: u32,
            bv_end: u32,
            out_slot: usize,
            bloom_glow: Option<(usize, [f32; 2])>,
            alias_of: Option<(usize, usize)>,
        }

        struct PreparedModel<'a, 'b> {
            model_in: &'b GpuRenderModelInput<'b>,
            cache: &'a ModelGpuCache,
            model_v_base: i32,
            mask_byte_base: usize,
            mask_call_start: usize,
            mask_call_end: usize,
            param_start: usize,
            param_end: usize,
            batch_start: usize,
            batch_end: usize,
            particle_range: Option<(u32, u32)>,
            particle_stage_range: Option<(u32, u32)>,
            draw_region: Option<FilterRegion>,
            model_region: Option<FilterRegion>,
            beams: Vec<PreparedBeam<'b>>,
            needs_offscreen: bool,
            filter_slot: usize,
            stage_comp_range: Option<(u32, u32)>,
            stage_pw_dyn_off: Option<u32>,
        }

        let sw: f32 = self.stage_width as f32;
        let sh: f32 = self.stage_height as f32;

        let clear_verts: [QuadVertex; 4] = stage_quad_verts(0.0, 0.0, sw, sh, sw, sh, [0.0; 4]);
        let (clear_vs, clear_ve): (u32, u32) =
            Self::push_quad_tris(&mut scratch.quad_verts, &clear_verts);

        // 0. Build background quad vertices up front (drawn inside the initial Clear/DontCare pass of SLOT_STAGE_ROOT).
        let (bg_batch, bg_covers_stage): (Option<(&wgpu::BindGroup, u32, u32)>, bool) =
            if let Some(bg) = input.background_key.and_then(|k| self.backgrounds.get(k)) {
                let scale: f32 = if (bg.width as f32 / bg.height.max(1) as f32) > (sw / sh) {
                    sh / bg.height.max(1) as f32
                } else {
                    sw / bg.width.max(1) as f32
                };
                let draw_w: f32 = bg.width as f32 * scale;
                let draw_h: f32 = bg.height as f32 * scale;
                let x: f32 = (sw - draw_w) * 0.5;
                let y: f32 = (sh - draw_h) * 0.5;
                let covers: bool =
                    x <= 0.001 && y <= 0.001 && (x + draw_w) >= sw - 0.001 && (y + draw_h) >= sh - 0.001;
                let verts: [QuadVertex; 4] =
                    stage_quad_verts(x, y, draw_w, draw_h, sw, sh, [1.0; 4]);
                let (v_start, v_end) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                (Some((&bg.quad_bg, v_start, v_end)), covers)
            } else {
                (None, false)
            };

        // 1. Collect per-model geometry, masks, particles, beams, and tight bounds into FrameScratch.
        scratch.mask_calls.clear();
        scratch.draw_batches.clear();
        let mut prepared: Vec<PreparedModel<'a, 'b>> = Vec::with_capacity(input.models.len());

        for model_in in input.models {
            if !model_in.model.stage.visible || model_in.model.stage.alpha <= 0.0 {
                continue;
            }
            let model = model_in.model;
            let cache: &ModelGpuCache = self.model_caches.get(&model.key).ok_or_else(|| {
                RendererError::MissingAsset(format!(
                    "Live2D GPU textures not registered for '{}'",
                    model.key
                ))
            })?;
            let meshes = model.meshes();
            let (infos, plan) = model.build_clipping_plan()?;
            if cache.total_verts == 0 || cache.mesh_ranges.is_empty() {
                continue;
            }
            let mesh_ranges: &[(i32, u32, u32)] = &cache.mesh_ranges;

            scratch.drawable_ctx.clear();
            scratch.drawable_ctx.resize(meshes.len(), None);
            for (ctx_idx, ctx) in plan.contexts().iter().enumerate() {
                for &d_idx in ctx.drawable_indices() {
                    if d_idx < scratch.drawable_ctx.len() {
                        scratch.drawable_ctx[d_idx] = Some(ctx_idx);
                    }
                }
            }

            let model_v_base: i32 = scratch.l2d_verts.len() as i32;
            let mask_byte_base: usize = scratch.l2d_mask_raw.len();
            let mask_call_start: usize = scratch.mask_calls.len();
            if !plan.contexts().is_empty() {
                for ctx in plan.contexts() {
                    let Some(layout) = ctx.layout() else { continue };
                    let Some(clip_mat) = ctx.matrix_for_mask() else {
                        continue;
                    };
                    let b = layout.bounds();
                    let u_rect: [f32; 4] = [
                        b.x() * 2.0 - 1.0,
                        b.y() * 2.0 - 1.0,
                        (b.x() + b.width()) * 2.0 - 1.0,
                        (b.y() + b.height()) * 2.0 - 1.0,
                    ];
                    let ch_flag: [f32; 4] = layout.channel_flag();
                    for &clip_idx_i32 in ctx.masks() {
                        if clip_idx_i32 < 0 {
                            continue;
                        }
                        let m_idx: usize = clip_idx_i32 as usize;
                        if m_idx >= meshes.len() || m_idx >= mesh_ranges.len() {
                            continue;
                        }
                        let tex_i: i32 = meshes[m_idx].texture_index();
                        if tex_i < 0 || (tex_i as usize) >= cache.textures.len() {
                            continue;
                        }
                        if mesh_ranges[m_idx].2 == 0 {
                            continue;
                        }
                        let u: Live2dMaskUniformGpu = Live2dMaskUniformGpu {
                            clip_matrix: *clip_mat.as_slice(),
                            base_color: u_rect,
                            channel_flag: ch_flag,
                        };
                        let off: usize = scratch.l2d_mask_raw.len();
                        scratch.l2d_mask_raw.resize(off + self.uniform_stride, 0);
                        scratch.l2d_mask_raw[off..off + std::mem::size_of::<Live2dMaskUniformGpu>()]
                            .copy_from_slice(bytemuck::bytes_of(&u));
                        scratch.mask_calls.push((
                            m_idx,
                            (meshes[m_idx].drawable_flags() & 0x04) != 0,
                            tex_i as usize,
                        ));
                    }
                }
            }
            let mask_call_end: usize = scratch.mask_calls.len();

            let draw_order: Vec<usize> = draw_order_indices(&infos);
            let mvp: [f32; 16] = model.mvp_ndc_for_stage(sw, sh);
            scratch.mesh_slot_map.clear();
            scratch.mesh_slot_map.resize(meshes.len(), u32::MAX);
            let param_start: usize = scratch.l2d_draw_vs_params.len();
            let batch_start: usize = scratch.draw_batches.len();
            let mut has_non_normal_blend: bool = false;

            for &d_idx in &draw_order {
                if d_idx >= meshes.len() || d_idx >= infos.len() || d_idx >= mesh_ranges.len() {
                    continue;
                }
                let info = &infos[d_idx];
                if !info.is_visible() {
                    continue;
                }
                let tex_i: i32 = info.texture_index();
                if tex_i < 0 || (tex_i as usize) >= cache.textures.len() {
                    continue;
                }
                let (base_v, _, _) = mesh_ranges[d_idx];
                let mesh = &meshes[d_idx];
                let m_indices: &[u16] = mesh.indices();
                if m_indices.is_empty() {
                    continue;
                }

                let (clip_matrix, channel_flag, mask_mode) =
                    if let Some(ctx_i) = scratch.drawable_ctx[d_idx] {
                        let ctx = &plan.contexts()[ctx_i];
                        let cm = ctx
                            .matrix_for_draw()
                            .map(|m| *m.as_slice())
                            .unwrap_or_else(identity_mat4);
                        let cf = ctx.layout().map(|l| l.channel_flag()).unwrap_or([0.0; 4]);
                        let mm = if ctx.inverted() { 2u32 } else { 1u32 };
                        (cm, cf, mm)
                    } else {
                        (identity_mat4(), [0.0; 4], 0u32)
                    };

                let draw_slot: u32 = scratch.l2d_draw_vs_params.len() as u32;
                let mc = mesh.multiply_color();
                let sc = mesh.screen_color();
                scratch.l2d_draw_vs_params.push(Live2dDrawVsParamsGpu {
                    mvp,
                    clip_matrix,
                });
                scratch.l2d_draw_fs_params.push(Live2dDrawFsParamsGpu {
                    base_color: [1.0, 1.0, 1.0, info.opacity()],
                    multiply_color: [mc[0], mc[1], mc[2], 1.0],
                    screen_color: [sc[0], sc[1], sc[2], 1.0],
                    channel_flag,
                    mask_mode,
                    _pad: [0; 3],
                });
                scratch.mesh_slot_map[d_idx] = draw_slot;

                let blend_idx: usize = match mesh.blend_mode() {
                    Moc3DrawableBlendMode::Normal => 0,
                    Moc3DrawableBlendMode::Additive => {
                        has_non_normal_blend = true;
                        1
                    }
                    Moc3DrawableBlendMode::Multiplicative => {
                        has_non_normal_blend = true;
                        2
                    }
                };
                let cull_idx: usize = usize::from((mesh.drawable_flags() & 0x04) != 0);
                let tex_idx: usize = tex_i as usize;

                let v_offset: u32 = (model_v_base + base_v) as u32;
                let idx_start: u32 = scratch.l2d_indices.len() as u32;
                scratch
                    .l2d_indices
                    .extend(m_indices.iter().map(|&idx| v_offset + idx as u32));
                let added_count: u32 = m_indices.len() as u32;

                if scratch.draw_batches.len() > batch_start {
                    if let Some(last) = scratch.draw_batches.last_mut() {
                        if last.blend_idx == blend_idx
                            && last.cull_idx == cull_idx
                            && last.tex_idx == tex_idx
                        {
                            last.idx_count += added_count;
                            continue;
                        }
                    }
                }
                scratch.draw_batches.push(Live2dDrawBatch {
                    blend_idx,
                    cull_idx,
                    tex_idx,
                    idx_start,
                    idx_count: added_count,
                });
            }
            let param_end: usize = scratch.l2d_draw_vs_params.len();
            let batch_end: usize = scratch.draw_batches.len();

            let mut min_sx: f32 = f32::INFINITY;
            let mut min_sy: f32 = f32::INFINITY;
            let mut max_sx: f32 = f32::NEG_INFINITY;
            let mut max_sy: f32 = f32::NEG_INFINITY;
            for (m_idx, mesh) in meshes.iter().enumerate() {
                let draw_slot: u32 = scratch.mesh_slot_map[m_idx];
                let visible: bool = draw_slot != u32::MAX;
                let draw_id: u32 = if visible { draw_slot } else { 0 };
                for v in mesh.vertices() {
                    let p = v.position();
                    scratch.l2d_verts.push(Live2dVertex {
                        pos: p,
                        uv: v.uv(),
                        draw_id,
                    });
                    if visible {
                        let clip_w: f32 = mvp[3] * p[0] + mvp[7] * p[1] + mvp[15];
                        if clip_w.abs() > 1e-6 {
                            let ndc_x: f32 = (mvp[0] * p[0] + mvp[4] * p[1] + mvp[12]) / clip_w;
                            let ndc_y: f32 = (mvp[1] * p[0] + mvp[5] * p[1] + mvp[13]) / clip_w;
                            let sx: f32 = (ndc_x * 0.5 + 0.5) * sw;
                            let sy: f32 = (0.5 - ndc_y * 0.5) * sh;
                            min_sx = min_sx.min(sx);
                            min_sy = min_sy.min(sy);
                            max_sx = max_sx.max(sx);
                            max_sy = max_sy.max(sy);
                        }
                    }
                }
            }

            let particles_to_stage: bool = !force_render_filters
                && model_in.parent_filters.is_empty()
                && model_in.hologram_beams.is_empty();
            let (particle_range, particle_stage_range): (Option<(u32, u32)>, Option<(u32, u32)>) =
                if !model_in.particles.is_empty() {
                    let mut tri_verts: Vec<QuadVertex> =
                        build_triangle_particle_verts(model, model_in.particles, sw, sh);
                    if tri_verts.is_empty() {
                        (None, None)
                    } else if particles_to_stage {
                        let sa: f32 = model.stage.alpha;
                        if (sa - 1.0).abs() > 1e-5 {
                            for v in &mut tri_verts {
                                v.color = [
                                    v.color[0] * sa,
                                    v.color[1] * sa,
                                    v.color[2] * sa,
                                    v.color[3] * sa,
                                ];
                            }
                        }
                        let p_start: u32 = scratch.quad_verts.len() as u32;
                        scratch.quad_verts.extend_from_slice(&tri_verts);
                        let p_end: u32 = scratch.quad_verts.len() as u32;
                        (None, Some((p_start, p_end)))
                    } else {
                        for v in &tri_verts {
                            let sx: f32 = (v.pos[0] * 0.5 + 0.5) * sw;
                            let sy: f32 = (0.5 - v.pos[1] * 0.5) * sh;
                            min_sx = min_sx.min(sx);
                            min_sy = min_sy.min(sy);
                            max_sx = max_sx.max(sx);
                            max_sy = max_sy.max(sy);
                        }
                        let p_start: u32 = scratch.quad_verts.len() as u32;
                        scratch.quad_verts.extend_from_slice(&tri_verts);
                        let p_end: u32 = scratch.quad_verts.len() as u32;
                        (Some((p_start, p_end)), None)
                    }
                } else {
                    (None, None)
                };

            let draw_region: Option<FilterRegion> = region_from_screen_bounds(
                min_sx,
                min_sy,
                max_sx,
                max_sy,
                4.0,
                self.stage_width,
                self.stage_height,
            );

            let mut beams: Vec<PreparedBeam<'b>> = Vec::with_capacity(model_in.hologram_beams.len());
            for beam in model_in.hologram_beams {
                let mut raw_verts: Vec<QuadVertex> = Vec::with_capacity(12);
                raw_verts.extend_from_slice(&build_hologram_trapezoid_verts(
                    model,
                    beam.large_scale,
                    beam.large_alpha,
                    sw,
                    sh,
                ));
                raw_verts.extend_from_slice(&build_hologram_trapezoid_verts(
                    model,
                    beam.small_scale,
                    beam.small_alpha,
                    sw,
                    sh,
                ));
                let mut bmin_x: f32 = f32::INFINITY;
                let mut bmin_y: f32 = f32::INFINITY;
                let mut bmax_x: f32 = f32::NEG_INFINITY;
                let mut bmax_y: f32 = f32::NEG_INFINITY;
                for v in &raw_verts {
                    let sx: f32 = (v.pos[0] * 0.5 + 0.5) * sw;
                    let sy: f32 = (0.5 - v.pos[1] * 0.5) * sh;
                    bmin_x = bmin_x.min(sx);
                    bmin_y = bmin_y.min(sy);
                    bmax_x = bmax_x.max(sx);
                    bmax_y = bmax_y.max(sy);
                }
                let beam_pad: f32 = filter_region_padding(&beam.filters, self.stage_width);
                let Some(beam_region) = region_from_screen_bounds(
                    bmin_x,
                    bmin_y,
                    bmax_x,
                    bmax_y,
                    beam_pad,
                    self.stage_width,
                    self.stage_height,
                ) else {
                    continue;
                };
                min_sx = min_sx.min(beam_region.x as f32);
                min_sy = min_sy.min(beam_region.y as f32);
                max_sx = max_sx.max((beam_region.x + beam_region.w) as f32);
                max_sy = max_sy.max((beam_region.y + beam_region.h) as f32);
                beams.push(PreparedBeam {
                    spec: beam,
                    raw_verts,
                    src_region: beam_region,
                    dst_x: beam_region.x,
                    dst_y: beam_region.y,
                    bv_start: 0,
                    bv_end: 0,
                    out_slot: SLOT_BEAM_RT,
                    bloom_glow: None,
                    alias_of: None,
                });
            }

            let needs_offscreen: bool = !model_in.parent_filters.is_empty()
                || !beams.is_empty()
                || particle_range.is_some()
                || (model.stage.alpha - 1.0).abs() > 1e-5
                || has_non_normal_blend;

            let model_region: Option<FilterRegion> = if needs_offscreen {
                let model_pad: f32 =
                    filter_region_padding(model_in.parent_filters, self.stage_width);
                region_from_screen_bounds(
                    min_sx,
                    min_sy,
                    max_sx,
                    max_sy,
                    model_pad,
                    self.stage_width,
                    self.stage_height,
                )
            } else {
                draw_region
            };

            if batch_start == batch_end
                && particle_range.is_none()
                && particle_stage_range.is_none()
                && beams.is_empty()
            {
                continue;
            }
            if model_region.is_none() && particle_stage_range.is_none() {
                continue;
            }

            prepared.push(PreparedModel {
                model_in,
                cache,
                model_v_base,
                mask_byte_base,
                mask_call_start,
                mask_call_end,
                param_start,
                param_end,
                batch_start,
                batch_end,
                particle_range,
                particle_stage_range,
                draw_region,
                model_region,
                beams,
                needs_offscreen,
                filter_slot: SLOT_MODEL_RT,
                stage_comp_range: None,
                stage_pw_dyn_off: None,
            });
        }

        if prepared.is_empty() {
            let mut clear_batches: Vec<(&wgpu::BindGroup, u32, u32)> =
                Vec::with_capacity(1 + inline_ui.len());
            if let Some(bg) = bg_batch {
                clear_batches.push(bg);
            }
            clear_batches.extend_from_slice(inline_ui);
            self.draw_batched_quad_pass(
                encoder,
                scratch,
                SLOT_STAGE_ROOT,
                Some(wgpu::Color::TRANSPARENT),
                &clear_batches,
            );
            return Ok(());
        }

        // 2. Deduplicate identical beams and render all unique HologramBeams in 1-2 packed passes.
        let mut beam_items: Vec<(usize, FilterRegion)> = Vec::new();
        let mut beam_refs: Vec<(usize, usize)> = Vec::new();
        for m_idx in 0..prepared.len() {
            for b_idx in 0..prepared[m_idx].beams.len() {
                let mut dup: Option<(usize, usize)> = None;
                let cur_raw: &[u8] =
                    bytemuck::cast_slice::<QuadVertex, u8>(&prepared[m_idx].beams[b_idx].raw_verts);
                for &(pm_idx, pb_idx) in &beam_refs {
                    let prev: &PreparedBeam<'b> = &prepared[pm_idx].beams[pb_idx];
                    if cur_raw == bytemuck::cast_slice::<QuadVertex, u8>(&prev.raw_verts)
                        && prepared[m_idx].beams[b_idx].spec.filters == prev.spec.filters
                    {
                        dup = Some((pm_idx, pb_idx));
                        break;
                    }
                }
                if let Some(src) = dup {
                    prepared[m_idx].beams[b_idx].alias_of = Some(src);
                } else {
                    let global_id: usize = beam_refs.len();
                    beam_refs.push((m_idx, b_idx));
                    beam_items.push((global_id, prepared[m_idx].beams[b_idx].src_region));
                }
            }
        }
        let beam_batches: Vec<Vec<(usize, u32, u32)>> =
            shelf_pack_regions(&beam_items, self.stage_width, self.stage_height, 16);
        let pre_baked_beams: bool = beam_batches.len() <= 2;
        if pre_baked_beams {
            let can_defer_beam_bloom: bool = !force_render_filters
                && self.quarter_pool.is_some()
                && self.beam_glow_aux.is_some()
                && scratch.chain_scratch.is_some()
                && prepared
                    .iter()
                    .all(|pm| pm.model_in.parent_filters.iter().all(is_pointwise_filter));
            let num_bb: usize = beam_batches.len();
            for (bb_idx, batch) in beam_batches.iter().enumerate() {
                let preserve_across_bb: bool = bb_idx + 1 < num_bb;
                for &(gid, dst_x, dst_y) in batch {
                    let (m_idx, b_idx) = beam_refs[gid];
                    let b: &mut PreparedBeam<'b> = &mut prepared[m_idx].beams[b_idx];
                    b.dst_x = dst_x;
                    b.dst_y = dst_y;
                    let dx_ndc: f32 = 2.0 * (dst_x as f32 - b.src_region.x as f32) / sw;
                    let dy_ndc: f32 = -2.0 * (dst_y as f32 - b.src_region.y as f32) / sh;
                    let bv_start: u32 = scratch.quad_verts.len() as u32;
                    for mut v in b.raw_verts.iter().copied() {
                        v.pos[0] += dx_ndc;
                        v.pos[1] += dy_ndc;
                        scratch.quad_verts.push(v);
                    }
                    b.bv_start = bv_start;
                    b.bv_end = scratch.quad_verts.len() as u32;
                }
                {
                    let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("hologram_beams_batched_pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &self.pool_views[SLOT_BEAM_RT],
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::DontCare(unsafe {
                                    wgpu::LoadOpDontCare::enabled()
                                }),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    rpass.set_pipeline(&self.quad_pipe_replace);
                    rpass.set_bind_group(0, &self.white_tex.quad_bg, &[]);
                    rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                    for &(gid, dst_x, dst_y) in batch {
                        let (m_idx, b_idx) = beam_refs[gid];
                        let b: &PreparedBeam<'b> = &prepared[m_idx].beams[b_idx];
                        rpass.set_scissor_rect(dst_x, dst_y, b.src_region.w, b.src_region.h);
                        rpass.draw(clear_vs..clear_ve, 0..1);
                    }
                    rpass.set_pipeline(&self.quad_pipe_normal);
                    rpass.set_bind_group(0, &self.ui_hologram.quad_bg, &[]);
                    for &(gid, dst_x, dst_y) in batch {
                        let (m_idx, b_idx) = beam_refs[gid];
                        let b: &PreparedBeam<'b> = &prepared[m_idx].beams[b_idx];
                        rpass.set_scissor_rect(dst_x, dst_y, b.src_region.w, b.src_region.h);
                        rpass.draw(b.bv_start..b.bv_end, 0..1);
                    }
                }
                let batch_len: usize = batch.len();
                for (in_batch_idx, &(gid, dst_x, dst_y)) in batch.iter().enumerate() {
                    let (m_idx, b_idx) = beam_refs[gid];
                    let src_reg: FilterRegion = prepared[m_idx].beams[b_idx].src_region;
                    let beam_filters: &[GpuFilterSpec] = &prepared[m_idx].beams[b_idx].spec.filters;
                    let packed_reg: FilterRegion = FilterRegion {
                        x: dst_x,
                        y: dst_y,
                        w: src_reg.w,
                        h: src_reg.h,
                    };
                    let uv_off: [f32; 2] = [
                        src_reg.x as f32 - dst_x as f32,
                        src_reg.y as f32 - dst_y as f32,
                    ];
                    let defer_bloom: bool = can_defer_beam_bloom
                        && (batch_len == 1 || (!preserve_across_bb && batch_len == 2))
                        && matches!(beam_filters.last(), Some(GpuFilterSpec::Bloom(_)));
                    let chain_out: FilterChainOutput = self.apply_region_filter_chain_with_offset(
                        encoder,
                        scratch,
                        SLOT_BEAM_RT,
                        packed_reg,
                        uv_off,
                        beam_filters,
                        defer_bloom,
                        if preserve_across_bb {
                            Some(SLOT_FINAL_OUTPUT)
                        } else {
                            None
                        },
                        force_render_filters,
                    );
                    let out_slot: usize = chain_out.slot;
                    let mut beam_bloom_glow: Option<(usize, [f32; 2])> = None;
                    if let Some(bloom) = chain_out.deferred_bloom {
                        if bloom.use_quarter && bloom.mode == 1 {
                            let copy_to_aux: bool =
                                preserve_across_bb || (batch_len == 2 && in_batch_idx == 0);
                            if copy_to_aux {
                                let qp: &ScaledPoolBuffers =
                                    self.quarter_pool.as_ref().expect("quarter_pool");
                                let aux: &GpuTextureAsset =
                                    self.beam_glow_aux.as_ref().expect("beam_glow_aux");
                                let dst_w: u32 =
                                    src_reg.w.div_ceil(qp.scale_factor).min(qp.width).max(1);
                                let dst_h: u32 =
                                    src_reg.h.div_ceil(qp.scale_factor).min(qp.height).max(1);
                                encoder.copy_texture_to_texture(
                                    wgpu::TexelCopyTextureInfo {
                                        texture: &qp._textures[bloom.scaled_slot],
                                        mip_level: 0,
                                        origin: wgpu::Origin3d::ZERO,
                                        aspect: wgpu::TextureAspect::All,
                                    },
                                    wgpu::TexelCopyTextureInfo {
                                        texture: &aux.texture,
                                        mip_level: 0,
                                        origin: wgpu::Origin3d::ZERO,
                                        aspect: wgpu::TextureAspect::All,
                                    },
                                    wgpu::Extent3d {
                                        width: dst_w,
                                        height: dst_h,
                                        depth_or_array_layers: 1,
                                    },
                                );
                                beam_bloom_glow = Some((1, bloom.uv_max));
                            } else {
                                beam_bloom_glow = Some((0, bloom.uv_max));
                            }
                        }
                    }
                    prepared[m_idx].beams[b_idx].bloom_glow = beam_bloom_glow;
                    if preserve_across_bb {
                        if out_slot != SLOT_FINAL_OUTPUT {
                            self.copy_pool_region(
                                encoder,
                                out_slot,
                                SLOT_FINAL_OUTPUT,
                                dst_x,
                                dst_y,
                                src_reg.w,
                                src_reg.h,
                            );
                        }
                        prepared[m_idx].beams[b_idx].out_slot = SLOT_FINAL_OUTPUT;
                    } else if batch_len == 1 {
                        prepared[m_idx].beams[b_idx].out_slot = out_slot;
                    } else {
                        if out_slot != SLOT_BEAM_RT {
                            self.copy_pool_region(
                                encoder,
                                out_slot,
                                SLOT_BEAM_RT,
                                dst_x,
                                dst_y,
                                src_reg.w,
                                src_reg.h,
                            );
                        }
                        prepared[m_idx].beams[b_idx].out_slot = SLOT_BEAM_RT;
                    }
                }
            }
            for m_idx in 0..prepared.len() {
                for b_idx in 0..prepared[m_idx].beams.len() {
                    if let Some((src_m, src_b)) = prepared[m_idx].beams[b_idx].alias_of {
                        let (dst_x, dst_y, out_slot, bloom_glow): (
                            u32,
                            u32,
                            usize,
                            Option<(usize, [f32; 2])>,
                        ) = {
                            let src: &PreparedBeam<'b> = &prepared[src_m].beams[src_b];
                            (src.dst_x, src.dst_y, src.out_slot, src.bloom_glow)
                        };
                        let cur: &mut PreparedBeam<'b> = &mut prepared[m_idx].beams[b_idx];
                        cur.dst_x = dst_x;
                        cur.dst_y = dst_y;
                        cur.out_slot = out_slot;
                        cur.bloom_glow = bloom_glow;
                    }
                }
            }
        }

        // 3. Process models in chunks of up to 4 mask-using models so each chunk's masks fit in 1 Clear pass.
        let mut stage_cleared: bool = false;
        let mut m_cursor: usize = 0;
        let half_mask: f32 = (MASK_ATLAS_SIZE / 2) as f32;

        while m_cursor < prepared.len() {
            let chunk_start: usize = m_cursor;
            let mut mask_models: Vec<(usize, usize)> = Vec::with_capacity(4);
            while m_cursor < prepared.len() {
                if prepared[m_cursor].mask_call_end > prepared[m_cursor].mask_call_start {
                    if mask_models.len() == 4 {
                        break;
                    }
                    let q: usize = mask_models.len();
                    mask_models.push((m_cursor, q));
                }
                m_cursor += 1;
            }
            let chunk_end: usize = m_cursor;
            let is_last_chunk: bool = chunk_end == prepared.len();

            let mask_count: usize = mask_models.len();
            if mask_count > 0 {
                if mask_count > 1 {
                    for &(m_idx, q) in &mask_models {
                        let pm: &PreparedModel<'a, 'b> = &prepared[m_idx];
                        for p in &mut scratch.l2d_draw_vs_params[pm.param_start..pm.param_end] {
                            p.clip_matrix = quadrant_clip_matrix(&p.clip_matrix, q, mask_count);
                        }
                    }
                }
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("l2d_mask_batched_pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.mask_atlas.view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                rpass.set_vertex_buffer(0, scratch.l2d_vbuf.slice(..));
                let mut prev_double_sided: Option<bool> = None;
                for &(m_idx, q) in &mask_models {
                    let pm: &PreparedModel<'a, 'b> = &prepared[m_idx];
                    if mask_count == 1 {
                        let full: f32 = MASK_ATLAS_SIZE as f32;
                        rpass.set_viewport(0.0, 0.0, full, full, 0.0, 1.0);
                        rpass.set_scissor_rect(0, 0, MASK_ATLAS_SIZE, MASK_ATLAS_SIZE);
                    } else {
                        let qx_px: u32 = ((q & 1) as u32) * (MASK_ATLAS_SIZE / 2);
                        let qy_px: u32 = ((q >> 1) as u32) * (MASK_ATLAS_SIZE / 2);
                        rpass.set_viewport(
                            qx_px as f32,
                            qy_px as f32,
                            half_mask,
                            half_mask,
                            0.0,
                            1.0,
                        );
                        rpass.set_scissor_rect(
                            qx_px,
                            qy_px,
                            MASK_ATLAS_SIZE / 2,
                            MASK_ATLAS_SIZE / 2,
                        );
                    }
                    rpass.set_index_buffer(pm.cache.ibuf.slice(..), wgpu::IndexFormat::Uint16);
                    let mut prev_tex: Option<usize> = None;
                    for (slot_idx, &(mesh_idx, double_sided, tex_i)) in scratch.mask_calls
                        [pm.mask_call_start..pm.mask_call_end]
                        .iter()
                        .enumerate()
                    {
                        if prev_double_sided != Some(double_sided) {
                            let pipe = if double_sided {
                                &self.live2d_mask_pipe_nocull
                            } else {
                                &self.live2d_mask_pipe_cull
                            };
                            rpass.set_pipeline(pipe);
                            prev_double_sided = Some(double_sided);
                        }
                        let (base_v, idx_start, idx_count) = pm.cache.mesh_ranges[mesh_idx];
                        let dyn_off: u32 =
                            (pm.mask_byte_base + slot_idx * self.uniform_stride) as u32;
                        rpass.set_bind_group(0, &scratch.l2d_mask_ubg, &[dyn_off]);
                        if prev_tex != Some(tex_i) {
                            rpass.set_bind_group(1, &pm.cache.mask_tbgs[tex_i], &[]);
                            prev_tex = Some(tex_i);
                        }
                        rpass.draw_indexed(
                            idx_start..idx_start + idx_count,
                            pm.model_v_base + base_v,
                            0..1,
                        );
                    }
                }
            }

            // 3b. Shelf-pack offscreen models in this chunk into SLOT_MODEL_RT batch(es).
            let mut off_items: Vec<(usize, FilterRegion)> = Vec::new();
            for m_idx in chunk_start..chunk_end {
                if prepared[m_idx].needs_offscreen {
                    if let Some(reg) = prepared[m_idx].model_region {
                        off_items.push((m_idx, reg));
                    }
                }
            }
            let model_batches: Vec<Vec<(usize, u32, u32)>> =
                shelf_pack_regions(&off_items, self.stage_width, self.stage_height, 16);

            let total_model_batches: usize = model_batches.len().max(1);
            let mut z_cursor: usize = chunk_start;
            let coalesce_stage_pass: bool = total_model_batches <= 2;

            for ob_idx in 0..total_model_batches {
                let batch_models: &[(usize, u32, u32)] = model_batches
                    .get(ob_idx)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let model_rt_slot: usize = if coalesce_stage_pass && ob_idx == 1 {
                    SLOT_MODEL_RT_ALT
                } else {
                    SLOT_MODEL_RT
                };

                if !pre_baked_beams && !batch_models.is_empty() {
                    let mut fallback_beam_idx: usize = 0;
                    for &(m_idx, _, _) in batch_models {
                        let beam_len: usize = prepared[m_idx].beams.len();
                        for b_idx in 0..beam_len {
                            if let Some((src_m, src_b)) = prepared[m_idx].beams[b_idx].alias_of {
                                let (dx, dy, os): (u32, u32, usize) = {
                                    let s: &PreparedBeam<'b> = &prepared[src_m].beams[src_b];
                                    (s.dst_x, s.dst_y, s.out_slot)
                                };
                                let cur: &mut PreparedBeam<'b> = &mut prepared[m_idx].beams[b_idx];
                                cur.dst_x = dx;
                                cur.dst_y = dy;
                                cur.out_slot = os;
                                continue;
                            }
                            let src_reg: FilterRegion = prepared[m_idx].beams[b_idx].src_region;
                            let bv_start: u32 = scratch.quad_verts.len() as u32;
                            scratch
                                .quad_verts
                                .extend_from_slice(&prepared[m_idx].beams[b_idx].raw_verts);
                            let bv_end: u32 = scratch.quad_verts.len() as u32;
                            {
                                let mut rpass =
                                    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                                        label: Some("hologram_beam_fallback_pass"),
                                        color_attachments: &[Some(
                                            wgpu::RenderPassColorAttachment {
                                                view: &self.pool_views[SLOT_BEAM_RT],
                                                depth_slice: None,
                                                resolve_target: None,
                                                ops: wgpu::Operations {
                                                    load: wgpu::LoadOp::Clear(
                                                        wgpu::Color::TRANSPARENT,
                                                    ),
                                                    store: wgpu::StoreOp::Store,
                                                },
                                            },
                                        )],
                                        depth_stencil_attachment: None,
                                        timestamp_writes: None,
                                        occlusion_query_set: None,
                                        multiview_mask: None,
                                    });
                                rpass.set_pipeline(&self.quad_pipe_normal);
                                rpass.set_bind_group(0, &self.ui_hologram.quad_bg, &[]);
                                rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                rpass.set_scissor_rect(
                                    src_reg.x,
                                    src_reg.y,
                                    src_reg.w,
                                    src_reg.h,
                                );
                                rpass.draw(bv_start..bv_end, 0..1);
                            }
                            let beam_filters: &[GpuFilterSpec] =
                                &prepared[m_idx].beams[b_idx].spec.filters;
                            let out_slot: usize = self
                                .apply_region_filter_chain_with_offset(
                                    encoder,
                                    scratch,
                                    SLOT_BEAM_RT,
                                    src_reg,
                                    [0.0, 0.0],
                                    beam_filters,
                                    false,
                                    None,
                                    force_render_filters,
                                )
                                .slot;
                            let final_slot: usize = if fallback_beam_idx == 0 {
                                if out_slot != SLOT_FINAL_OUTPUT {
                                    self.copy_pool_region(
                                        encoder,
                                        out_slot,
                                        SLOT_FINAL_OUTPUT,
                                        src_reg.x,
                                        src_reg.y,
                                        src_reg.w,
                                        src_reg.h,
                                    );
                                }
                                SLOT_FINAL_OUTPUT
                            } else {
                                out_slot
                            };
                            fallback_beam_idx += 1;
                            prepared[m_idx].beams[b_idx].dst_x = src_reg.x;
                            prepared[m_idx].beams[b_idx].dst_y = src_reg.y;
                            prepared[m_idx].beams[b_idx].out_slot = final_slot;
                        }
                    }
                }

                if !batch_models.is_empty() {
                    let mut beam_draw_ranges: Vec<(usize, Option<(usize, [f32; 2])>, u32, u32)> =
                        Vec::new();
                    let qp_dims: (f32, f32) = self
                        .quarter_pool
                        .as_ref()
                        .map(|qp| (qp.width as f32, qp.height as f32))
                        .unwrap_or((1.0, 1.0));
                    for &(m_idx, dst_x, dst_y) in batch_models {
                        let pm: &mut PreparedModel<'a, 'b> = &mut prepared[m_idx];
                        let model_reg: FilterRegion = pm.model_region.expect("model_region");
                        let dx: f32 = dst_x as f32 - model_reg.x as f32;
                        let dy: f32 = dst_y as f32 - model_reg.y as f32;

                        if dx != 0.0 || dy != 0.0 {
                            for p in &mut scratch.l2d_draw_vs_params[pm.param_start..pm.param_end] {
                                p.mvp = translate_mvp(&p.mvp, dx, dy, sw, sh);
                            }
                            if let Some((p_start, p_end)) = pm.particle_range {
                                let dx_ndc: f32 = 2.0 * dx / sw;
                                let dy_ndc: f32 = -2.0 * dy / sh;
                                for v in &mut scratch.quad_verts[p_start as usize..p_end as usize] {
                                    v.pos[0] += dx_ndc;
                                    v.pos[1] += dy_ndc;
                                }
                            }
                        }

                        for b in &pm.beams {
                            let target_reg: FilterRegion = FilterRegion {
                                x: ((b.src_region.x as i32) - (model_reg.x as i32)
                                    + (dst_x as i32))
                                    .max(0) as u32,
                                y: ((b.src_region.y as i32) - (model_reg.y as i32)
                                    + (dst_y as i32))
                                    .max(0) as u32,
                                w: b.src_region.w,
                                h: b.src_region.h,
                            };
                            let mut verts: [QuadVertex; 4] = translated_stage_quad_verts(
                                target_reg,
                                (b.dst_x, b.dst_y),
                                sw,
                                sh,
                                [1.0; 4],
                            );
                            if let Some((_, uv_max)) = b.bloom_glow {
                                let gx1: f32 = (b.src_region.w as f32) / (4.0 * qp_dims.0);
                                let gy1: f32 = (b.src_region.h as f32) / (4.0 * qp_dims.1);
                                verts[0].color = [0.0, 0.0, uv_max[0], uv_max[1]];
                                verts[1].color = [gx1, 0.0, uv_max[0], uv_max[1]];
                                verts[2].color = [gx1, gy1, uv_max[0], uv_max[1]];
                                verts[3].color = [0.0, gy1, uv_max[0], uv_max[1]];
                            }
                            let (bs, be) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                            beam_draw_ranges.push((b.out_slot, b.bloom_glow, bs, be));
                        }
                    }

                    {
                        let mut beam_cursor: usize = 0;
                        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("l2d_models_batched_pass"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &self.pool_views[model_rt_slot],
                                depth_slice: None,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::DontCare(unsafe {
                                        wgpu::LoadOpDontCare::enabled()
                                    }),
                                    store: wgpu::StoreOp::Store,
                                },
                            })],
                            depth_stencil_attachment: None,
                            timestamp_writes: None,
                            occlusion_query_set: None,
                            multiview_mask: None,
                        });
                        rpass.set_pipeline(&self.quad_pipe_replace);
                        rpass.set_bind_group(0, &self.white_tex.quad_bg, &[]);
                        rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                        for &(m_idx, dst_x, dst_y) in batch_models {
                            let model_reg: FilterRegion =
                                prepared[m_idx].model_region.expect("model_region");
                            rpass.set_scissor_rect(dst_x, dst_y, model_reg.w, model_reg.h);
                            rpass.draw(clear_vs..clear_ve, 0..1);
                        }
                        for &(m_idx, dst_x, dst_y) in batch_models {
                            let pm: &PreparedModel<'a, 'b> = &prepared[m_idx];
                            let model_reg: FilterRegion = pm.model_region.expect("model_region");
                            rpass.set_scissor_rect(dst_x, dst_y, model_reg.w, model_reg.h);
                            self.draw_l2d_batches(
                                &mut rpass,
                                scratch,
                                pm.cache,
                                pm.batch_start,
                                pm.batch_end,
                            );
                            if let Some((p_start, p_end)) = pm.particle_range {
                                rpass.set_pipeline(&self.quad_pipe_add);
                                rpass.set_bind_group(0, &self.white_tex.quad_bg, &[]);
                                rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                rpass.draw(p_start..p_end, 0..1);
                            }
                            for _ in 0..pm.beams.len() {
                                let (out_slot, bloom_glow, bs, be) = beam_draw_ranges[beam_cursor];
                                beam_cursor += 1;
                                if let Some((glow_idx, _)) = bloom_glow {
                                    rpass.set_pipeline(&self.bloom_pipe_normal);
                                    rpass.set_bind_group(0, &self.pool_quad_bgs[out_slot], &[]);
                                    rpass.set_bind_group(1, &self.empty_bg, &[]);
                                    rpass.set_bind_group(2, &self.empty_bg, &[]);
                                    let glow_bg: &wgpu::BindGroup = if glow_idx == 1 {
                                        &self.beam_glow_aux.as_ref().expect("beam_glow_aux").quad_bg
                                    } else {
                                        &self.quarter_pool.as_ref().expect("quarter_pool").quad_bgs[2]
                                    };
                                    rpass.set_bind_group(3, glow_bg, &[]);
                                } else {
                                    rpass.set_pipeline(&self.quad_pipe_normal);
                                    rpass.set_bind_group(0, &self.pool_quad_bgs[out_slot], &[]);
                                }
                                rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                rpass.draw(bs..be, 0..1);
                            }
                        }
                    }

                    let can_inline_pw: bool =
                        !force_render_filters && self.quad_pipe_pointwise.is_some();
                    let filtered_count: usize = batch_models
                        .iter()
                        .filter(|&&(m_idx, _, _)| {
                            let pf: &[GpuFilterSpec] = prepared[m_idx].model_in.parent_filters;
                            !pf.is_empty()
                                && !(can_inline_pw
                                    && pf.iter().all(is_pointwise_filter)
                                    && pf.len() < MAX_FUSED_POINTWISE_OPS)
                        })
                        .count();
                    let preserve_batch_across: bool =
                        coalesce_stage_pass && total_model_batches == 2 && ob_idx == 0;
                    for &(m_idx, dst_x, dst_y) in batch_models {
                        let pm: &PreparedModel<'a, 'b> = &prepared[m_idx];
                        let model_reg: FilterRegion = pm.model_region.expect("model_region");
                        let pf: &[GpuFilterSpec] = pm.model_in.parent_filters;
                        let inline_pw: bool = can_inline_pw
                            && !pf.is_empty()
                            && pf.iter().all(is_pointwise_filter)
                            && pf.len() < MAX_FUSED_POINTWISE_OPS
                            && scratch.chain_scratch.is_some();
                        let alpha: f32 = if pf.is_empty() {
                            let stage_alpha: f32 = pm.model_in.model.stage.alpha;
                            prepared[m_idx].filter_slot = model_rt_slot;
                            stage_alpha
                        } else if inline_pw {
                            let mut ops: [PointwiseOpGpu; MAX_FUSED_POINTWISE_OPS] =
                                Default::default();
                            let mut op_count: usize = 0;
                            let sa: f32 = pm.model_in.model.stage.alpha;
                            if (sa - 1.0).abs() > 1e-5 {
                                if let Some(enc) = encode_pointwise_op(
                                    &GpuFilterSpec::Alpha(sa),
                                    self.stage_width,
                                    self.stage_height,
                                ) {
                                    ops[op_count] = enc;
                                    op_count += 1;
                                }
                            }
                            for spec in pf {
                                if op_count >= MAX_FUSED_POINTWISE_OPS {
                                    break;
                                }
                                if let GpuFilterSpec::Alpha(a) = spec {
                                    if (*a - 1.0).abs() <= 1e-6 {
                                        continue;
                                    }
                                }
                                if let Some(enc) =
                                    encode_pointwise_op(spec, self.stage_width, self.stage_height)
                                {
                                    ops[op_count] = enc;
                                    op_count += 1;
                                }
                            }
                            if op_count > 0 {
                                let skip_transparent: u32 = ops_preserve_transparent(&ops, op_count);
                                let post_u: PostChainUniformGpu = PostChainUniformGpu {
                                    width: self.stage_width,
                                    height: self.stage_height,
                                    y_words: 0,
                                    uv_words: 0,
                                    dst_offset_x: model_reg.x,
                                    dst_offset_y: model_reg.y,
                                    dispatch_w: model_reg.w,
                                    dispatch_h: model_reg.h,
                                    op_count: op_count as u32,
                                    apply_backdrop: 0,
                                    has_bloom_glow: 0,
                                    skip_transparent,
                                    backdrop_clear: [0.0; 4],
                                    fade_color_premul: [0.0; 4],
                                    bloom_uv_scale: [0.0; 2],
                                    bloom_uv_max: [1.0; 2],
                                    stage_inv_dims: [1.0 / sw, 1.0 / sh],
                                    uv_px_offset: [0.0, 0.0],
                                    fade_alpha: 0.0,
                                    _pad_tail: [0; 3],
                                    ops,
                                };
                                let dyn_off: u32 = scratch
                                    .chain_scratch
                                    .as_mut()
                                    .expect("chain_scratch")
                                    .push(&post_u);
                                prepared[m_idx].stage_pw_dyn_off = Some(dyn_off);
                            }
                            prepared[m_idx].filter_slot = model_rt_slot;
                            1.0
                        } else {
                            let mut mf: Vec<GpuFilterSpec> =
                                std::mem::take(&mut scratch.model_filters);
                            mf.clear();
                            if (pm.model_in.model.stage.alpha - 1.0).abs() > 1e-5 {
                                mf.push(GpuFilterSpec::Alpha(pm.model_in.model.stage.alpha));
                            }
                            mf.extend_from_slice(pf);
                            let packed_reg: FilterRegion = FilterRegion {
                                x: dst_x,
                                y: dst_y,
                                w: model_reg.w,
                                h: model_reg.h,
                            };
                            let uv_off: [f32; 2] = [
                                model_reg.x as f32 - dst_x as f32,
                                model_reg.y as f32 - dst_y as f32,
                            ];
                            let out_slot: usize = self
                                .apply_region_filter_chain_with_offset(
                                    encoder,
                                    scratch,
                                    model_rt_slot,
                                    packed_reg,
                                    uv_off,
                                    &mf,
                                    false,
                                    None,
                                    force_render_filters,
                                )
                                .slot;
                            scratch.model_filters = mf;
                            if filtered_count == 1 && !preserve_batch_across {
                                prepared[m_idx].filter_slot = out_slot;
                            } else {
                                if out_slot != model_rt_slot {
                                    self.copy_pool_region(
                                        encoder,
                                        out_slot,
                                        model_rt_slot,
                                        dst_x,
                                        dst_y,
                                        model_reg.w,
                                        model_reg.h,
                                    );
                                }
                                prepared[m_idx].filter_slot = model_rt_slot;
                            }
                            1.0
                        };
                        let comp_verts: [QuadVertex; 4] = translated_stage_quad_verts(
                            model_reg,
                            (dst_x, dst_y),
                            sw,
                            sh,
                            [alpha; 4],
                        );
                        let (cs, ce) = Self::push_quad_tris(&mut scratch.quad_verts, &comp_verts);
                        prepared[m_idx].stage_comp_range = Some((cs, ce));
                    }
                }

                if coalesce_stage_pass && ob_idx + 1 < total_model_batches {
                    continue;
                }

                let next_z_end: usize = if coalesce_stage_pass || ob_idx + 1 >= total_model_batches {
                    chunk_end
                } else {
                    model_batches[ob_idx + 1][0].0
                };
                let is_final_stage_pass: bool =
                    is_last_chunk && ob_idx + 1 >= total_model_batches;

                let (load_op, do_bg_draw): (wgpu::LoadOp<wgpu::Color>, bool) = if !stage_cleared {
                    stage_cleared = true;
                    if bg_covers_stage {
                        (
                            wgpu::LoadOp::DontCare(unsafe { wgpu::LoadOpDontCare::enabled() }),
                            true,
                        )
                    } else {
                        (wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), true)
                    }
                } else {
                    (wgpu::LoadOp::Load, false)
                };

                {
                    let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("stage_root_batched_pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &self.pool_views[SLOT_STAGE_ROOT],
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: load_op,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });

                    let mut quad_mode: u8 = 0; // 0=none, 1=normal, 2=pointwise, 3=add
                    let mut last_quad_slot: Option<usize> = None;

                    if do_bg_draw {
                        if let Some((bg_b, vs, ve)) = bg_batch {
                            rpass.set_scissor_rect(0, 0, self.stage_width, self.stage_height);
                            if bg_covers_stage {
                                rpass.set_pipeline(&self.quad_pipe_replace);
                            } else {
                                rpass.set_pipeline(&self.quad_pipe_normal);
                                quad_mode = 1;
                            }
                            rpass.set_bind_group(0, bg_b, &[]);
                            rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                            rpass.draw(vs..ve, 0..1);
                        }
                    }

                    for m_idx in z_cursor..next_z_end {
                        let pm: &PreparedModel<'a, 'b> = &prepared[m_idx];
                        if !pm.needs_offscreen {
                            if let Some(scissor) = pm.draw_region {
                                rpass.set_scissor_rect(scissor.x, scissor.y, scissor.w, scissor.h);
                                self.draw_l2d_batches(
                                    &mut rpass,
                                    scratch,
                                    pm.cache,
                                    pm.batch_start,
                                    pm.batch_end,
                                );
                                quad_mode = 0;
                                last_quad_slot = None;
                            }
                        } else if let Some((cs, ce)) = pm.stage_comp_range {
                            rpass.set_scissor_rect(0, 0, self.stage_width, self.stage_height);
                            if let Some(dyn_off) = pm.stage_pw_dyn_off {
                                if let (Some(pw_pipe), Some(cs_scratch)) = (
                                    self.quad_pipe_pointwise.as_ref(),
                                    scratch.chain_scratch.as_ref(),
                                ) {
                                    if quad_mode != 2 {
                                        rpass.set_pipeline(pw_pipe);
                                        rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                        quad_mode = 2;
                                    }
                                    if last_quad_slot != Some(pm.filter_slot) {
                                        rpass.set_bind_group(
                                            0,
                                            &self.pool_quad_bgs[pm.filter_slot],
                                            &[],
                                        );
                                        last_quad_slot = Some(pm.filter_slot);
                                    }
                                    rpass.set_bind_group(1, &cs_scratch.s_bg, &[dyn_off]);
                                    rpass.draw(cs..ce, 0..1);
                                }
                            } else {
                                if quad_mode != 1 {
                                    rpass.set_pipeline(&self.quad_pipe_normal);
                                    rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                    quad_mode = 1;
                                }
                                if last_quad_slot != Some(pm.filter_slot) {
                                    rpass.set_bind_group(
                                        0,
                                        &self.pool_quad_bgs[pm.filter_slot],
                                        &[],
                                    );
                                    last_quad_slot = Some(pm.filter_slot);
                                }
                                rpass.draw(cs..ce, 0..1);
                            }
                        }
                        if let Some((ps, pe)) = pm.particle_stage_range {
                            rpass.set_scissor_rect(0, 0, self.stage_width, self.stage_height);
                            if quad_mode != 3 {
                                rpass.set_pipeline(&self.quad_pipe_add);
                                rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                                quad_mode = 3;
                            }
                            rpass.set_bind_group(0, &self.white_tex.quad_bg, &[]);
                            last_quad_slot = None;
                            rpass.draw(ps..pe, 0..1);
                        }
                    }

                    if is_final_stage_pass && !inline_ui.is_empty() {
                        rpass.set_scissor_rect(0, 0, self.stage_width, self.stage_height);
                        if quad_mode != 1 {
                            rpass.set_pipeline(&self.quad_pipe_normal);
                            rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                        }
                        for &(bg, vs, ve) in inline_ui {
                            rpass.set_bind_group(0, bg, &[]);
                            rpass.draw(vs..ve, 0..1);
                        }
                    }
                }
                z_cursor = next_z_end;
            }
        }

        Ok(())
    }

    fn ensure_text_texture(
        &mut self,
        text_renderer: &mut StoryTextRenderer,
        slot: TextSlot,
        text: &str,
    ) -> Result<(), RendererError> {
        let already_cached = match slot {
            TextSlot::Body => {
                self.cached_body.source_text == text
                    && (text.is_empty() || self.cached_body.surface.is_some())
            }
            TextSlot::Speaker => {
                self.cached_speaker.source_text == text
                    && (text.is_empty() || self.cached_speaker.surface.is_some())
            }
            TextSlot::Telop => {
                self.cached_telop.source_text == text
                    && (text.is_empty() || self.cached_telop.surface.is_some())
            }
        };
        if already_cached {
            return Ok(());
        }

        let style = match slot {
            TextSlot::Body => {
                StoryTextRenderer::dialogue_body_style(self.stage_width, self.stage_height)
            }
            TextSlot::Speaker => StoryTextRenderer::speaker_style(self.stage_height),
            TextSlot::Telop => StoryTextRenderer::telop_style(self.stage_height),
        };
        let rendered: Option<RenderedTextSurface> = text_renderer.render_text(text, style)?;
        let gpu_surface = rendered.map(|s| {
            let tex = GpuTextureAsset::from_premul(
                &self.device,
                &self.queue,
                &self.quad_tex_bgl,
                &self.sampler_clamp,
                &s.image,
                "ui_text",
            );
            (tex, s.offset_x, s.offset_y)
        });
        let target = match slot {
            TextSlot::Body => &mut self.cached_body,
            TextSlot::Speaker => &mut self.cached_speaker,
            TextSlot::Telop => &mut self.cached_telop,
        };
        target.source_text = text.to_string();
        target.surface = gpu_surface;
        Ok(())
    }

    fn push_quad_tris(
        quad_verts: &mut Vec<QuadVertex>,
        verts: &[QuadVertex; 4],
    ) -> (u32, u32) {
        let v_start: u32 = quad_verts.len() as u32;
        quad_verts.extend_from_slice(&[verts[0], verts[1], verts[2], verts[0], verts[2], verts[3]]);
        let v_end: u32 = quad_verts.len() as u32;
        (v_start, v_end)
    }

    fn draw_batched_quad_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &FrameScratch,
        dst_slot: usize,
        clear_color: Option<wgpu::Color>,
        batches: &[(&wgpu::BindGroup, u32, u32)],
    ) {
        let load: wgpu::LoadOp<wgpu::Color> = match clear_color {
            Some(c) => wgpu::LoadOp::Clear(c),
            None => wgpu::LoadOp::Load,
        };
        let mut rpass: wgpu::RenderPass<'_> =
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("quad_batch_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pool_views[dst_slot],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        if batches.is_empty() {
            return;
        }
        rpass.set_pipeline(&self.quad_pipe_normal);
        rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
        for &(tex_bg, v_start, v_end) in batches {
            if v_end > v_start {
                rpass.set_bind_group(0, tex_bg, &[]);
                rpass.draw(v_start..v_end, 0..1);
            }
        }
    }

    fn clear_rt(&self, encoder: &mut wgpu::CommandEncoder, slot: usize, color: wgpu::Color) {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear_rt"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.pool_views[slot],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }
}

#[derive(Clone, Copy)]
enum TextSlot {
    Body,
    Speaker,
    Telop,
}

fn align_to(value: u32, align: u32) -> u32 {
    if align == 0 {
        return value;
    }
    ((value + align - 1) / align) * align
}

fn identity_mat4() -> [f32; 16] {
    [
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]
}

fn stage_to_ndc(sx: f32, sy: f32, sw: f32, sh: f32) -> [f32; 2] {
    [(sx / sw) * 2.0 - 1.0, 1.0 - (sy / sh) * 2.0]
}

fn stage_quad_verts(
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    sw: f32,
    sh: f32,
    color: [f32; 4],
) -> [QuadVertex; 4] {
    [
        QuadVertex {
            pos: stage_to_ndc(x, y, sw, sh),
            uv: [0.0, 0.0],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x + w, y, sw, sh),
            uv: [1.0, 0.0],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x + w, y + h, sw, sh),
            uv: [1.0, 1.0],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x, y + h, sw, sh),
            uv: [0.0, 1.0],
            color,
        },
    ]
}

fn translated_stage_quad_verts(
    dst_rect: FilterRegion,
    src_origin: (u32, u32),
    sw: f32,
    sh: f32,
    color: [f32; 4],
) -> [QuadVertex; 4] {
    let x0: f32 = dst_rect.x as f32;
    let y0: f32 = dst_rect.y as f32;
    let x1: f32 = (dst_rect.x + dst_rect.w) as f32;
    let y1: f32 = (dst_rect.y + dst_rect.h) as f32;
    let u0: f32 = src_origin.0 as f32 / sw;
    let v0: f32 = src_origin.1 as f32 / sh;
    let u1: f32 = (src_origin.0 + dst_rect.w) as f32 / sw;
    let v1: f32 = (src_origin.1 + dst_rect.h) as f32 / sh;
    [
        QuadVertex {
            pos: stage_to_ndc(x0, y0, sw, sh),
            uv: [u0, v0],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x1, y0, sw, sh),
            uv: [u1, v0],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x1, y1, sw, sh),
            uv: [u1, v1],
            color,
        },
        QuadVertex {
            pos: stage_to_ndc(x0, y1, sw, sh),
            uv: [u0, v1],
            color,
        },
    ]
}

fn translate_mvp(mvp: &[f32; 16], dx: f32, dy: f32, sw: f32, sh: f32) -> [f32; 16] {
    if dx == 0.0 && dy == 0.0 {
        return *mvp;
    }
    let tx: f32 = 2.0 * dx / sw;
    let ty: f32 = -2.0 * dy / sh;
    let mut out: [f32; 16] = *mvp;
    for col in 0..4 {
        let w: f32 = out[col * 4 + 3];
        out[col * 4] += tx * w;
        out[col * 4 + 1] += ty * w;
    }
    out
}

fn quadrant_clip_matrix(clip: &[f32; 16], quadrant: usize, count: usize) -> [f32; 16] {
    if count <= 1 {
        return *clip;
    }
    let q: usize = quadrant % 4;
    let qx: f32 = ((q & 1) as f32) * 0.5;
    let qy: f32 = ((q >> 1) as f32) * 0.5;
    let mut out: [f32; 16] = *clip;
    for col in 0..4 {
        let w: f32 = out[col * 4 + 3];
        out[col * 4] = 0.5 * out[col * 4] + qx * w;
        out[col * 4 + 1] = 0.5 * out[col * 4 + 1] + qy * w;
    }
    out
}

fn shelf_pack_regions(
    items: &[(usize, FilterRegion)],
    atlas_w: u32,
    atlas_h: u32,
    pad: u32,
) -> Vec<Vec<(usize, u32, u32)>> {
    let mut batches: Vec<Vec<(usize, u32, u32)>> = Vec::new();
    let mut cur_batch: Vec<(usize, u32, u32)> = Vec::new();
    let mut cur_x: u32 = 0;
    let mut cur_y: u32 = 0;
    let mut row_h: u32 = 0;

    for &(id, region) in items {
        let w: u32 = region.w.min(atlas_w);
        let h: u32 = region.h.min(atlas_h);
        if cur_x > 0 && cur_x + pad + w > atlas_w {
            cur_y = cur_y.saturating_add(row_h).saturating_add(pad);
            cur_x = 0;
            row_h = 0;
        }
        if cur_y + h > atlas_h {
            if !cur_batch.is_empty() {
                batches.push(cur_batch);
                cur_batch = Vec::new();
            }
            cur_x = 0;
            cur_y = 0;
            row_h = 0;
        }
        let dst_x: u32 = if cur_x == 0 { 0 } else { cur_x + pad };
        let dst_y: u32 = cur_y;
        cur_batch.push((id, dst_x, dst_y));
        cur_x = dst_x + w;
        row_h = row_h.max(h);
    }
    if !cur_batch.is_empty() {
        batches.push(cur_batch);
    }
    batches
}

fn filter_region_padding(filters: &[GpuFilterSpec], _stage_width: u32) -> f32 {
    let mut pad: f32 = 16.0;
    for spec in filters {
        match spec {
            GpuFilterSpec::Blur(p) => {
                let half_k: f32 = ((p.kernel_size / 2) as f32).max(1.0);
                pad = pad.max(p.strength.abs() * half_k * 2.0 + 16.0);
            }
            GpuFilterSpec::Bloom(p) => {
                let half_k: f32 = ((p.kernel_size / 2) as f32).max(1.0);
                let s: f32 = p.strength_x.abs().max(p.strength_y.abs());
                pad = pad.max(s * half_k * 2.0 + 16.0);
            }
            _ => {}
        }
    }
    pad
}

fn region_from_screen_bounds(
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
    pad: f32,
    stage_width: u32,
    stage_height: u32,
) -> Option<FilterRegion> {
    if !min_x.is_finite()
        || !min_y.is_finite()
        || !max_x.is_finite()
        || !max_y.is_finite()
        || max_x < min_x
        || max_y < min_y
    {
        return None;
    }
    let sw: f32 = stage_width as f32;
    let sh: f32 = stage_height as f32;
    let rx0: u32 = (min_x - pad).floor().clamp(0.0, sw) as u32;
    let ry0: u32 = (min_y - pad).floor().clamp(0.0, sh) as u32;
    let rx1: u32 = (max_x + pad).ceil().clamp(0.0, sw) as u32;
    let ry1: u32 = (max_y + pad).ceil().clamp(0.0, sh) as u32;
    if rx1 <= rx0 || ry1 <= ry0 {
        return None;
    }
    Some(FilterRegion {
        x: rx0,
        y: ry0,
        w: rx1 - rx0,
        h: ry1 - ry0,
    })
}

fn full_ndc_quad(color: [f32; 4]) -> [QuadVertex; 4] {
    [
        QuadVertex {
            pos: [-1.0, 1.0],
            uv: [0.0, 0.0],
            color,
        },
        QuadVertex {
            pos: [1.0, 1.0],
            uv: [1.0, 0.0],
            color,
        },
        QuadVertex {
            pos: [1.0, -1.0],
            uv: [1.0, 1.0],
            color,
        },
        QuadVertex {
            pos: [-1.0, -1.0],
            uv: [0.0, 1.0],
            color,
        },
    ]
}

fn canvas_to_ndc(model: &Live2DModelInstance, cx: f32, cy: f32, sw: f32, sh: f32) -> [f32; 2] {
    let orig_w = model.original_width();
    let orig_h = model.original_height();
    let sx = model.stage.pos_x + (cx - model.stage.anchor_x * orig_w) * model.stage.scale;
    let sy = model.stage.pos_y + (cy - model.stage.anchor_y * orig_h) * model.stage.scale;
    stage_to_ndc(sx, sy, sw, sh)
}

fn build_hologram_trapezoid_verts(
    model: &Live2DModelInstance,
    beam_scale: f32,
    alpha: f32,
    sw: f32,
    sh: f32,
) -> [QuadVertex; 6] {
    let w = 3000.0f32;
    let h = 4500.0f32;
    let pivot_x = w * 0.5;
    let pivot_y = h / 1.7;
    let origin_cx = model.original_width() * 0.5;
    let origin_cy = model.original_height() * model.stage.anchor_y;
    let col = [alpha, alpha, alpha, alpha];

    let xform = |lx: f32, ly: f32, u: f32, v: f32| {
        let cx = origin_cx + (lx - pivot_x) * beam_scale;
        let cy = origin_cy + (ly - pivot_y) * beam_scale;
        QuadVertex {
            pos: canvas_to_ndc(model, cx, cy, sw, sh),
            uv: [u, v],
            color: col,
        }
    };

    let p0 = xform(w / 3.0, h, 1.0 / 3.0, 1.0);
    let p1 = xform(0.0, 0.0, 0.0, 0.0);
    let p2 = xform(w, 0.0, 1.0, 0.0);
    let p3 = xform((2.0 * w) / 3.0, h, 2.0 / 3.0, 1.0);
    [p0, p1, p2, p0, p2, p3]
}

fn build_triangle_particle_verts(
    model: &Live2DModelInstance,
    particles: &[&TriangleParticle],
    sw: f32,
    sh: f32,
) -> Vec<QuadVertex> {
    let mut out = Vec::new();
    for p in particles {
        if p.alpha <= 0.0 {
            continue;
        }
        let col = [
            p.color_rgb[0] * p.alpha,
            p.color_rgb[1] * p.alpha,
            p.color_rgb[2] * p.alpha,
            p.alpha,
        ];
        let (sin_r, cos_r) = p.rotation.sin_cos();
        let half = p.size * 0.5;
        let local = [[-half, half], [half, half], [0.0, -half]];
        let pts: Vec<[f32; 2]> = local
            .iter()
            .map(|&[lx, ly]| [p.x + lx * cos_r - ly * sin_r, p.y + lx * sin_r + ly * cos_r])
            .collect();

        if p.filled {
            for pt in pts {
                out.push(QuadVertex {
                    pos: canvas_to_ndc(model, pt[0], pt[1], sw, sh),
                    uv: [0.5, 0.5],
                    color: col,
                });
            }
        } else {
            let half_stroke = 5.0f32;
            for i in 0..3 {
                let a = pts[i];
                let b = pts[(i + 1) % 3];
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                let len = (dx * dx + dy * dy).sqrt().max(1e-5);
                let nx = (-dy / len) * half_stroke;
                let ny = (dx / len) * half_stroke;
                let dir_x = (dx / len) * half_stroke * 0.5;
                let dir_y = (dy / len) * half_stroke * 0.5;

                let q = [
                    [a[0] - nx - dir_x, a[1] - ny - dir_y],
                    [a[0] + nx - dir_x, a[1] + ny - dir_y],
                    [b[0] + nx + dir_x, b[1] + ny + dir_y],
                    [b[0] - nx + dir_x, b[1] - ny + dir_y],
                ];
                let ndc: Vec<[f32; 2]> = q
                    .iter()
                    .map(|pt| canvas_to_ndc(model, pt[0], pt[1], sw, sh))
                    .collect();
                for &idx in &[0usize, 1, 2, 0, 2, 3] {
                    out.push(QuadVertex {
                        pos: ndc[idx],
                        uv: [0.5, 0.5],
                        color: col,
                    });
                }
            }
        }
    }
    let _ = FRAC_PI_2;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::encoder::rgba_to_yuv420p_bt709;
    use crate::renderer::story::PlaybackFontConfig;
    use crate::renderer::vfx::{
        AdjustmentFilterParams, BloomFilterParams, BlurFilterParams, ColorOverlayFilterParams,
        CrtFilterParams, OldFilmFilterParams,
    };
    use std::path::PathBuf;

    fn load_test_ichika() -> Live2DModelInstance {
        let model_path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../tests/models/01ichika_normal_3.0_f_t04/01ichika_normal_3.0_f_t04.model3.json",
        );
        let mut model: Live2DModelInstance =
            Live2DModelInstance::load("ichika", &model_path, 42).expect("load model");
        let scale: f32 = (720.0 / model.original_height()) * 2.1;
        model.stage.pos_x = 640.0;
        model.stage.pos_y = 720.0 * 0.8;
        model.stage.scale = scale;
        model.stage.anchor_x = 0.5;
        model.stage.anchor_y = 0.5;
        model.stage.alpha = 0.85;
        model.stage.visible = true;
        model.accumulate_delta_ms(16.0);
        model.commit_frame_update();
        model
    }

    #[test]
    fn gpu_renders_live2d_model_with_dialogue_and_filters() {
        let mut model: Live2DModelInstance = load_test_ichika();
        model.stage.alpha = 1.0;

        let mut gpu: GpuSceneRenderer = GpuSceneRenderer::new(1280, 720).expect("init headless wgpu");
        gpu.register_live2d_model("ichika", &model);
        let mut text_renderer: StoryTextRenderer =
            StoryTextRenderer::new(&PlaybackFontConfig::Default, None).expect("font");

        let frame: Vec<u8> = gpu
            .render_frame(
                &GpuRenderFrameInput {
                    background_key: None,
                    models: &[GpuRenderModelInput {
                        model: &model,
                        parent_filters: &[],
                        particles: &[],
                        hologram_beams: &[],
                    }],
                    stage_filters: &[],
                    screen_filters: &[],
                    dialogue_visible: true,
                    dialogue_bg_alpha: 1.0,
                    dialogue_underline_alpha: 1.0,
                    dialogue_body_text: "测试纯 Rust GPU 渲染一歌模型与对话文本！",
                    dialogue_body_alpha: 1.0,
                    dialogue_speaker_text: "星乃一歌",
                    dialogue_speaker_alpha: 1.0,
                    telop_visible: false,
                    telop_text: "",
                    telop_alpha: 0.0,
                    telop_x_offset: 0.0,
                    fade_visible: false,
                    fade_color: [0.0; 4],
                    fade_alpha: 0.0,
                    background_clear: [0.0, 0.0, 0.0, 1.0],
                },
                &mut text_renderer,
            )
            .expect("render frame");

        assert_eq!(frame.len(), 1280 * 720 * 4);
        let non_black_pixels: usize = frame
            .chunks_exact(4)
            .filter(|px| px[0] > 4 || px[1] > 4 || px[2] > 4)
            .count();
        assert!(
            non_black_pixels > 50_000,
            "Expected significant rendered model & UI coverage, got {non_black_pixels}"
        );
    }

    #[test]
    fn pipelined_ring_buffer_matches_sync_render() {
        let model: Live2DModelInstance = load_test_ichika();
        let mut gpu: GpuSceneRenderer = GpuSceneRenderer::new(1280, 720).expect("init headless wgpu");
        gpu.register_live2d_model("ichika", &model);
        let mut text_renderer: StoryTextRenderer =
            StoryTextRenderer::new(&PlaybackFontConfig::Default, None).expect("font");

        let input_a = GpuRenderFrameInput {
            background_key: None,
            models: &[GpuRenderModelInput {
                model: &model,
                parent_filters: &[],
                particles: &[],
                hologram_beams: &[],
            }],
            stage_filters: &[],
            screen_filters: &[],
            dialogue_visible: true,
            dialogue_bg_alpha: 1.0,
            dialogue_underline_alpha: 1.0,
            dialogue_body_text: "测试环形缓冲渲染一致性 A",
            dialogue_body_alpha: 1.0,
            dialogue_speaker_text: "星乃一歌",
            dialogue_speaker_alpha: 1.0,
            telop_visible: false,
            telop_text: "",
            telop_alpha: 0.0,
            telop_x_offset: 0.0,
            fade_visible: false,
            fade_color: [0.0; 4],
            fade_alpha: 0.0,
            background_clear: [0.0, 0.0, 0.0, 1.0],
        };
        let input_b = GpuRenderFrameInput {
            dialogue_body_text: "测试环形缓冲渲染一致性 B",
            fade_visible: true,
            fade_color: [0.1, 0.2, 0.3, 1.0],
            fade_alpha: 0.25,
            ..input_a
        };

        let sync_a: Vec<u8> = gpu.render_frame(&input_a, &mut text_renderer).expect("sync a");
        let sync_b: Vec<u8> = gpu.render_frame(&input_b, &mut text_renderer).expect("sync b");

        // Submit 6 alternating frames across READBACK_RING_DEPTH = 4 slots to verify FIFO wraparound.
        let mut ring_outputs: Vec<Vec<u8>> = Vec::with_capacity(6);
        let mut scratch_out: Vec<u8> = Vec::new();
        for idx in 0..6 {
            let inp = if idx % 2 == 0 { &input_a } else { &input_b };
            if gpu
                .submit_and_drain_previous_into(inp, &mut text_renderer, &mut scratch_out)
                .expect("submit ring frame")
            {
                ring_outputs.push(scratch_out.clone());
            }
        }
        while gpu
            .finish_pending_frame_into(&mut scratch_out)
            .expect("drain tail")
        {
            ring_outputs.push(scratch_out.clone());
        }

        assert_eq!(ring_outputs.len(), 6);
        for (idx, frame) in ring_outputs.iter().enumerate() {
            let expected: &[u8] = if idx % 2 == 0 { &sync_a } else { &sync_b };
            assert_eq!(frame.as_slice(), expected, "frame {idx} diverged from sync");
        }
    }

    #[test]
    fn compute_filters_and_yuv420p_match_reference() {
        let model: Live2DModelInstance = load_test_ichika();
        let mut gpu: GpuSceneRenderer = GpuSceneRenderer::new(640, 360).expect("init headless wgpu");
        gpu.register_live2d_model("ichika", &model);
        let mut text_renderer: StoryTextRenderer =
            StoryTextRenderer::new(&PlaybackFontConfig::Default, None).expect("font");

        let filters: [GpuFilterSpec; 6] = [
            GpuFilterSpec::Adjustment(AdjustmentFilterParams {
                gamma: 1.0,
                contrast: 1.1,
                saturation: 0.9,
                brightness: 1.05,
                color: [0.95, 1.0, 1.05, 1.0],
            }),
            GpuFilterSpec::ColorOverlay(ColorOverlayFilterParams {
                color: [0.2, 0.4, 0.8],
                alpha: 0.15,
            }),
            GpuFilterSpec::Blur(BlurFilterParams {
                strength: 4.0,
                quality: 2,
                kernel_size: 5,
            }),
            GpuFilterSpec::Bloom(BloomFilterParams {
                strength_x: 8.0,
                strength_y: 8.0,
                quality: 4,
                kernel_size: 5,
            }),
            GpuFilterSpec::Crt(CrtFilterParams {
                curvature: 1.0,
                line_width: 1.0,
                line_contrast: 0.25,
                vertical_line: false,
                noise: 0.2,
                noise_size: 1.0,
                vignetting: 0.3,
                vignetting_alpha: 0.8,
                vignetting_blur: 0.3,
                seed: 0.37,
                time: 2.5,
            }),
            GpuFilterSpec::OldFilm(OldFilmFilterParams {
                sepia: 0.3,
                noise: 0.2,
                noise_size: 1.0,
                scratch: 0.4,
                scratch_density: 0.3,
                scratch_width: 1.0,
                vignetting: 0.3,
                vignetting_alpha: 0.8,
                vignetting_blur: 0.3,
                seed: 0.21,
            }),
        ];

        let input = GpuRenderFrameInput {
            background_key: None,
            models: &[GpuRenderModelInput {
                model: &model,
                parent_filters: &filters[..3],
                particles: &[],
                hologram_beams: &[],
            }],
            stage_filters: &filters[3..4],
            screen_filters: &filters[4..],
            dialogue_visible: true,
            dialogue_bg_alpha: 0.9,
            dialogue_underline_alpha: 0.9,
            dialogue_body_text: "Compute 滤镜数值一致性验证",
            dialogue_body_alpha: 1.0,
            dialogue_speaker_text: "一歌",
            dialogue_speaker_alpha: 1.0,
            telop_visible: true,
            telop_text: "序章",
            telop_alpha: 0.8,
            telop_x_offset: 0.0,
            fade_visible: false,
            fade_color: [0.0; 4],
            fade_alpha: 0.0,
            background_clear: [0.0, 0.0, 0.0, 1.0],
        };

        let compute_rgba: Vec<u8> = gpu
            .render_frame_with_force_render_filters(&input, &mut text_renderer, false)
            .expect("compute rgba");
        let render_rgba: Vec<u8> = gpu
            .render_frame_with_force_render_filters(&input, &mut text_renderer, true)
            .expect("render rgba");
        assert_eq!(compute_rgba.len(), render_rgba.len());

        let max_diff: u8 = compute_rgba
            .iter()
            .zip(render_rgba.iter())
            .map(|(&a, &b)| a.abs_diff(b))
            .max()
            .unwrap_or(0);
        // Fused float pointwise chains avoid intermediate 8-bit `rgba8unorm` quantization between
        // stacked pointwise filters (e.g. Adjustment+ColorOverlay, Crt+OldFilm), allowing up to 2/255.
        assert!(
            max_diff <= 2,
            "Compute filter path exceeded 2/255 channel tolerance vs fragment path: max_diff={max_diff}"
        );

        // Verify GPU YUV420p output matches CPU BT.709 reference on identical RGBA output.
        let mut gpu_yuv: YuvFrame = YuvFrame {
            width: 640,
            height: 360,
            y: Vec::new(),
            u: Vec::new(),
            v: Vec::new(),
        };
        assert!(!gpu
            .submit_and_drain_previous_yuv_into(&input, &mut text_renderer, &mut gpu_yuv)
            .expect("submit yuv"));
        assert!(gpu
            .finish_pending_yuv_into(&mut gpu_yuv)
            .expect("finish yuv"));

        let mut cpu_y: Vec<u8> = Vec::new();
        let mut cpu_u: Vec<u8> = Vec::new();
        let mut cpu_v: Vec<u8> = Vec::new();
        rgba_to_yuv420p_bt709(&compute_rgba, 640, 360, &mut cpu_y, &mut cpu_u, &mut cpu_v);
        let max_y_diff: u8 = gpu_yuv.y.iter().zip(cpu_y.iter()).map(|(&a, &b)| a.abs_diff(b)).max().unwrap_or(0);
        let max_u_diff: u8 = gpu_yuv.u.iter().zip(cpu_u.iter()).map(|(&a, &b)| a.abs_diff(b)).max().unwrap_or(0);
        let max_v_diff: u8 = gpu_yuv.v.iter().zip(cpu_v.iter()).map(|(&a, &b)| a.abs_diff(b)).max().unwrap_or(0);
        assert!(
            max_y_diff <= 1 && max_u_diff <= 1 && max_v_diff <= 1,
            "GPU YUV diverged beyond 1/255 rounding tolerance: y={max_y_diff}, u={max_u_diff}, v={max_v_diff}"
        );

        // Verify opaque fade short-circuit produces exact uniform color.
        let opaque_input = GpuRenderFrameInput {
            fade_visible: true,
            fade_color: [0.0, 0.0, 0.0, 1.0],
            fade_alpha: 1.0,
            ..input
        };
        let opaque_rgba: Vec<u8> = gpu
            .render_frame(&opaque_input, &mut text_renderer)
            .expect("opaque fade");
        assert!(opaque_rgba
            .chunks_exact(4)
            .all(|px| px == [0, 0, 0, 255]));
    }

    #[test]
    fn scaled_pyramid_hd_blur_bloom_preserves_psnr() {
        let model: Live2DModelInstance = load_test_ichika();
        let mut gpu: GpuSceneRenderer = GpuSceneRenderer::new(1280, 720).expect("init 720p wgpu");
        gpu.register_live2d_model("ichika", &model);
        let mut text_renderer: StoryTextRenderer =
            StoryTextRenderer::new(&PlaybackFontConfig::Default, None).expect("font");

        let model_blur: [GpuFilterSpec; 1] = [GpuFilterSpec::Blur(BlurFilterParams {
            strength: 8.0,
            quality: 3,
            kernel_size: 5,
        })];
        let screen_bloom: [GpuFilterSpec; 2] = [
            GpuFilterSpec::Bloom(BloomFilterParams {
                strength_x: 10.0,
                strength_y: 10.0,
                quality: 4,
                kernel_size: 5,
            }),
            GpuFilterSpec::ColorOverlay(ColorOverlayFilterParams {
                color: [0.1, 0.2, 0.4],
                alpha: 0.1,
            }),
        ];
        let input = GpuRenderFrameInput {
            background_key: None,
            models: &[GpuRenderModelInput {
                model: &model,
                parent_filters: &model_blur,
                particles: &[],
                hologram_beams: &[],
            }],
            stage_filters: &[],
            screen_filters: &screen_bloom,
            dialogue_visible: false,
            dialogue_bg_alpha: 0.0,
            dialogue_underline_alpha: 0.0,
            dialogue_body_text: "",
            dialogue_body_alpha: 0.0,
            dialogue_speaker_text: "",
            dialogue_speaker_alpha: 0.0,
            telop_visible: false,
            telop_text: "",
            telop_alpha: 0.0,
            telop_x_offset: 0.0,
            fade_visible: false,
            fade_color: [0.0; 4],
            fade_alpha: 0.0,
            background_clear: [0.0, 0.0, 0.0, 1.0],
        };

        let opt_rgba: Vec<u8> = gpu
            .render_frame_with_force_render_filters(&input, &mut text_renderer, false)
            .expect("opt rgba");
        let ref_rgba: Vec<u8> = gpu
            .render_frame_with_force_render_filters(&input, &mut text_renderer, true)
            .expect("ref rgba");

        let mut sse: f64 = 0.0;
        let mut count: f64 = 0.0;
        for (a, b) in opt_rgba.chunks_exact(4).zip(ref_rgba.chunks_exact(4)) {
            for c in 0..3 {
                let d: f64 = a[c] as f64 - b[c] as f64;
                sse += d * d;
                count += 1.0;
            }
        }
        let mse: f64 = sse / count;
        let psnr: f64 = if mse <= 1e-12 {
            99.0
        } else {
            10.0 * ((255.0_f64 * 255.0_f64) / mse).log10()
        };
        assert!(psnr >= 40.0, "Scaled pyramid PSNR too low: {psnr:.2} dB");

        // Also exercise deferred trailing Bloom + pointwise YUV path end-to-end.
        let mut yuv: YuvFrame = YuvFrame {
            width: 1280,
            height: 720,
            y: Vec::new(),
            u: Vec::new(),
            v: Vec::new(),
        };
        assert!(!gpu
            .submit_and_drain_previous_yuv_into(&input, &mut text_renderer, &mut yuv)
            .expect("submit 720p yuv"));
        assert!(gpu
            .finish_pending_yuv_into(&mut yuv)
            .expect("finish 720p yuv"));
        assert_eq!(yuv.y.len(), 1280 * 720);
        assert_eq!(yuv.u.len(), 640 * 360);
    }

    #[test]
    fn enumerate_and_select_render_backends() {
        let backends: Vec<GpuBackendInfo> = enumerate_render_backends();
        assert!(
            !backends.is_empty(),
            "expected at least one GPU/CPU wgpu adapter on host"
        );
        assert!(!prefers_hardware_streaming_encoder_for_backend(
            RenderBackend::Cpu
        ));

        let auto_renderer: GpuSceneRenderer =
            GpuSceneRenderer::new_with_backend(64, 64, RenderBackend::Auto)
                .expect("Auto backend must initialize");
        drop(auto_renderer);

        #[cfg(target_os = "macos")]
        {
            let metal_renderer: GpuSceneRenderer =
                GpuSceneRenderer::new_with_backend(64, 64, RenderBackend::Metal)
                    .expect("Metal/MPS backend must initialize on macOS");
            drop(metal_renderer);
            assert!(backends.iter().any(|b| b.backend == RenderBackend::Metal));
        }
    }
}
