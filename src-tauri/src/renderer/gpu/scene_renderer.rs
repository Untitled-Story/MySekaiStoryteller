use bytemuck::{Pod, Zeroable};
use mocari::moc3::Moc3DrawableBlendMode;
use mocari::render::common::draw_order_indices;
use rusty_h264_common::YuvFrame;
use std::collections::{HashMap, VecDeque};
use std::f32::consts::FRAC_PI_2;
use std::path::Path;

use crate::renderer::error::RendererError;
use crate::renderer::live2d::Live2DModelInstance;
use crate::renderer::svg_assets::{load_image_premul, BuiltinUiBitmaps, PremulImage};
use crate::renderer::text::{RenderedTextSurface, StoryTextRenderer};
use crate::renderer::vfx::{GpuFilterSpec, HologramBeamRenderData, TriangleParticle};

use super::filters::{
    live2d_additive_blend, live2d_mask_setup_blend, live2d_multiplicative_blend, pixi_add_blend,
    pixi_normal_blend, FilterPipelines, FilterUniformScratch, YuvConvertUniformGpu,
};

const WGSL_SHADERS: &str = include_str!("shaders.wgsl");
const MASK_ATLAS_SIZE: u32 = 1024;
const READBACK_RING_DEPTH: usize = 4;

const SLOT_STAGE_ROOT: usize = 0;
const SLOT_PRESENTATION_ROOT: usize = 1;
const SLOT_MODEL_RT: usize = 2;
const SLOT_BEAM_RT: usize = 3;
const SLOT_TELOP_RT: usize = 4;
const SLOT_FINAL_OUTPUT: usize = 5;
const SCRATCH_START: usize = 6;
const POOL_SIZE: usize = 11; // 6 named slots + 5 filter scratch slots

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
struct Live2dDrawUniformGpu {
    mvp: [f32; 16],
    clip_matrix: [f32; 16],
    base_color: [f32; 4],
    multiply_color: [f32; 4],
    screen_color: [f32; 4],
    channel_flag: [f32; 4],
    mask_mode: u32,
    _pad: [u32; 3],
}

pub struct GpuTextureAsset {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub quad_bg: wgpu::BindGroup,
    pub width: u32,
    pub height: u32,
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
        let width = img.width.max(1);
        let height = img.height.max(1);
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
            | wgpu::TextureUsages::COPY_SRC;
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

struct FrameScratch {
    quad_vbuf: wgpu::Buffer,
    quad_cap_verts: usize,
    quad_verts: Vec<QuadVertex>,

    l2d_vbuf: wgpu::Buffer,
    l2d_cap_verts: usize,
    l2d_verts: Vec<Live2dVertex>,

    l2d_mask_ubuf: wgpu::Buffer,
    l2d_mask_ubg: wgpu::BindGroup,
    l2d_mask_cap_slots: usize,
    l2d_mask_raw: Vec<u8>,

    l2d_draw_ubuf: wgpu::Buffer,
    l2d_draw_ubg: wgpu::BindGroup,
    l2d_draw_cap_slots: usize,
    l2d_draw_raw: Vec<u8>,

    filter_scratch: FilterUniformScratch,
    uniform_stride: usize,
}

impl FrameScratch {
    fn new(
        device: &wgpu::Device,
        filters: &FilterPipelines,
        live2d_mask_ubgl: &wgpu::BindGroupLayout,
        live2d_draw_ubgl: &wgpu::BindGroupLayout,
        uniform_stride: usize,
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

        let l2d_mask_cap_slots: usize = 512;
        let (l2d_mask_ubuf, l2d_mask_ubg) = Self::create_dynamic_ubuf(
            device,
            live2d_mask_ubgl,
            "scratch_l2d_mask_ubuf",
            l2d_mask_cap_slots * uniform_stride,
            std::mem::size_of::<Live2dMaskUniformGpu>() as u64,
        );

        let l2d_draw_cap_slots: usize = 4096;
        let (l2d_draw_ubuf, l2d_draw_ubg) = Self::create_dynamic_ubuf(
            device,
            live2d_draw_ubgl,
            "scratch_l2d_draw_ubuf",
            l2d_draw_cap_slots * uniform_stride,
            std::mem::size_of::<Live2dDrawUniformGpu>() as u64,
        );

        let filter_scratch: FilterUniformScratch =
            FilterUniformScratch::new(device, filters, uniform_stride, 256);

        Self {
            quad_vbuf,
            quad_cap_verts,
            quad_verts: Vec::with_capacity(quad_cap_verts),
            l2d_vbuf,
            l2d_cap_verts,
            l2d_verts: Vec::with_capacity(l2d_cap_verts),
            l2d_mask_ubuf,
            l2d_mask_ubg,
            l2d_mask_cap_slots,
            l2d_mask_raw: Vec::with_capacity(l2d_mask_cap_slots * uniform_stride),
            l2d_draw_ubuf,
            l2d_draw_ubg,
            l2d_draw_cap_slots,
            l2d_draw_raw: Vec::with_capacity(l2d_draw_cap_slots * uniform_stride),
            filter_scratch,
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

    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &mut self,
        device: &wgpu::Device,
        filters: &FilterPipelines,
        live2d_mask_ubgl: &wgpu::BindGroupLayout,
        live2d_draw_ubgl: &wgpu::BindGroupLayout,
        req_quad_verts: usize,
        req_l2d_verts: usize,
        req_mask_slots: usize,
        req_draw_slots: usize,
        req_filter_slots: usize,
    ) {
        self.quad_verts.clear();
        self.l2d_verts.clear();
        self.l2d_mask_raw.clear();
        self.l2d_draw_raw.clear();
        self.filter_scratch.prepare(device, filters, req_filter_slots);

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
            let (ubuf, ubg) = Self::create_dynamic_ubuf(
                device,
                live2d_draw_ubgl,
                "scratch_l2d_draw_ubuf",
                new_slots * self.uniform_stride,
                std::mem::size_of::<Live2dDrawUniformGpu>() as u64,
            );
            self.l2d_draw_ubuf = ubuf;
            self.l2d_draw_ubg = ubg;
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
        if !self.l2d_mask_raw.is_empty() {
            queue.write_buffer(&self.l2d_mask_ubuf, 0, &self.l2d_mask_raw);
        }
        if !self.l2d_draw_raw.is_empty() {
            queue.write_buffer(&self.l2d_draw_ubuf, 0, &self.l2d_draw_raw);
        }
        self.filter_scratch.flush(queue);
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
    readback_bufs: [wgpu::Buffer; READBACK_RING_DEPTH],
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
    quad_pipe_add: wgpu::RenderPipeline,
    sampler_clamp: wgpu::Sampler,
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
    mask_atlas: GpuTextureAsset,
    readback_bufs: [wgpu::Buffer; READBACK_RING_DEPTH],
    yuv_resources: Option<GpuYuvPackResources>,
    scratches: [Option<FrameScratch>; READBACK_RING_DEPTH],
    next_slot: usize,
    in_flight: VecDeque<InFlightReadback>,
    padded_bytes_per_row: u32,

    // Cached static/dynamic scene textures and model geometry
    ui_text_bg: GpuTextureAsset,
    ui_text_underline: GpuTextureAsset,
    ui_telop: GpuTextureAsset,
    ui_hologram: GpuTextureAsset,
    backgrounds: HashMap<String, GpuTextureAsset>,
    model_caches: HashMap<String, ModelGpuCache>,
    cached_body: CachedTextTexture,
    cached_speaker: CachedTextTexture,
    cached_telop: CachedTextTexture,
}

impl GpuSceneRenderer {
    pub fn new(stage_width: u32, stage_height: u32) -> Result<Self, RendererError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
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
        .map_err(|err| RendererError::Gpu(format!("No WebGPU/wgpu adapter available: {err}")))?;

        let supports_compute_filters: bool = adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .allowed_usages
            .contains(wgpu::TextureUsages::STORAGE_BINDING);

        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|err| {
                    RendererError::Gpu(format!("Failed to create wgpu device: {err}"))
                })?;

        let uniform_stride =
            (device.limits().min_uniform_buffer_offset_alignment as usize).max(256);

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
        let quad_pipe_add = make_quad_pipe("quad_add", pixi_add_blend());

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
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(
                        std::mem::size_of::<Live2dDrawUniformGpu>() as u64,
                    ),
                },
                count: None,
            }],
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
        let readback_bufs: [wgpu::Buffer; READBACK_RING_DEPTH] = std::array::from_fn(|i| {
            make_readback(&format!("frame_readback_buf_{i}"), readback_size)
        });
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
                let pack_bg: wgpu::BindGroup =
                    device.create_bind_group(&wgpu::BindGroupDescriptor {
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
                GpuYuvPackResources {
                    y_words,
                    uv_words,
                    yuv_byte_len,
                    gpu_buf,
                    _uniform_buf: uniform_buf,
                    pack_bg,
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
            ))
        });

        let ui_bitmaps = BuiltinUiBitmaps::render_for_stage(stage_width, stage_height)?;
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
            quad_pipe_add,
            sampler_clamp,
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
            mask_atlas,
            readback_bufs,
            yuv_resources,
            scratches,
            next_slot: 0,
            in_flight: VecDeque::with_capacity(READBACK_RING_DEPTH),
            padded_bytes_per_row,
            ui_text_bg,
            ui_text_underline,
            ui_telop,
            ui_hologram,
            backgrounds: HashMap::new(),
            model_caches: HashMap::new(),
            cached_body: CachedTextTexture::default(),
            cached_speaker: CachedTextTexture::default(),
            cached_telop: CachedTextTexture::default(),
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
        let img = load_image_premul(path)?;
        let tex = GpuTextureAsset::from_premul(
            &self.device,
            &self.queue,
            &self.quad_tex_bgl,
            &self.sampler_clamp,
            &img,
            &format!("bg_{key}"),
        );
        self.backgrounds.insert(key.to_string(), tex);
        Ok(())
    }

    pub fn register_live2d_model(&mut self, key: &str, model: &Live2DModelInstance) {
        if self.model_caches.contains_key(key) {
            return;
        }
        let mut textures: Vec<GpuTextureAsset> = Vec::with_capacity(model.textures().len());
        for (i, decoded) in model.textures().iter().enumerate() {
            let premul = PremulImage::from_straight_rgba(
                decoded.width(),
                decoded.height(),
                decoded.rgba().to_vec(),
            );
            textures.push(GpuTextureAsset::from_premul(
                &self.device,
                &self.queue,
                &self.quad_tex_bgl,
                &self.sampler_clamp,
                &premul,
                &format!("l2d_{key}_{i}"),
            ));
        }

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
                            resource: wgpu::BindingResource::Sampler(&self.sampler_clamp),
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
        let buf: &wgpu::Buffer = &self.readback_bufs[pending.slot];
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
            self.enqueue_readback(encoder, slot, readback_kind);
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
                req_draw_slots += cache.mesh_ranges.len();
            }
            req_quad_verts += model_in.particles.len() * 3 + model_in.hologram_beams.len() * 18 + 6;
            req_filter_slots += FilterPipelines::estimate_passes(model_in.parent_filters) + 1;
            for beam in model_in.hologram_beams {
                req_filter_slots += FilterPipelines::estimate_passes(&beam.filters);
            }
        }
        let req_mask_slots: usize = req_draw_slots.saturating_mul(2).max(512);

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
            req_mask_slots,
            req_draw_slots,
            req_filter_slots,
        );

        let record_result: Result<(), RendererError> = (|| {
            let mut encoder: wgpu::CommandEncoder =
                self.device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("frame_encoder"),
                    });

            // 1. Clear `stage_root` transparent and draw background (`background` layer) in a single pass.
            let stage_batches: [(&wgpu::BindGroup, u32, u32); 1];
            let stage_slice: &[(&wgpu::BindGroup, u32, u32)] =
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
                    let verts: [QuadVertex; 4] =
                        stage_quad_verts(x, y, draw_w, draw_h, sw, sh, [1.0; 4]);
                    let (v_start, v_end) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                    stage_batches = [(&bg.quad_bg, v_start, v_end)];
                    &stage_batches
                } else {
                    &[]
                };
            self.draw_batched_quad_pass(
                &mut encoder,
                &scratch,
                SLOT_STAGE_ROOT,
                Some(wgpu::Color::TRANSPARENT),
                stage_slice,
            );

            // 2. Render each visible Live2D model + child VFX + parent filters onto `stage_root`.
            for model_in in input.models {
                if !model_in.model.stage.visible || model_in.model.stage.alpha <= 0.0 {
                    continue;
                }
                self.render_single_model(
                    &mut encoder,
                    &mut scratch,
                    model_in,
                    force_render_filters,
                )?;
            }

            // 3. Apply Stage filters (`stageRoot.filters`).
            let stage_filtered_slot: usize = self.filters.apply_chain(
                &mut encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                &mut scratch.filter_scratch,
                SLOT_STAGE_ROOT,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                input.stage_filters,
                force_render_filters,
            );

            // 4a. Render Telop card onto `SLOT_TELOP_RT` in a single pass when visible.
            let telop_active: bool = input.telop_visible && input.telop_alpha > 0.0;
            if telop_active {
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
                    &mut encoder,
                    &scratch,
                    SLOT_TELOP_RT,
                    Some(wgpu::Color::TRANSPARENT),
                    &telop_batches,
                );
            }

            // 4b. Batch `stage_filtered_slot` + Dialogue UI + Telop into ONE `SLOT_PRESENTATION_ROOT` pass.
            let mut pres_batches: Vec<(&wgpu::BindGroup, u32, u32)> = Vec::with_capacity(6);
            if stage_filtered_slot != SLOT_PRESENTATION_ROOT {
                let verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
                let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                pres_batches.push((&self.pool_quad_bgs[stage_filtered_slot], vs, ve));
            }
            if input.dialogue_visible {
                if input.dialogue_bg_alpha > 0.0 {
                    let a: f32 = input.dialogue_bg_alpha;
                    let verts: [QuadVertex; 4] =
                        stage_quad_verts(0.0, 0.0, sw, sh, sw, sh, [a; 4]);
                    let (vs, ve) = Self::push_quad_tris(&mut scratch.quad_verts, &verts);
                    pres_batches.push((&self.ui_text_bg.quad_bg, vs, ve));
                }
                if input.dialogue_underline_alpha > 0.0 {
                    let a: f32 = input.dialogue_underline_alpha;
                    let uw: f32 = self.ui_text_underline.width as f32;
                    let uh: f32 = self.ui_text_underline.height as f32;
                    let ux: f32 = sw / 10.0;
                    let uy: f32 = sh / 1.3;
                    let verts: [QuadVertex; 4] =
                        stage_quad_verts(ux, uy, uw, uh, sw, sh, [a; 4]);
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
            self.draw_batched_quad_pass(
                &mut encoder,
                &scratch,
                SLOT_PRESENTATION_ROOT,
                Some(wgpu::Color::TRANSPARENT),
                &pres_batches,
            );

            // 5. Apply Screen filters (`presentationRoot.filters`).
            let screen_filtered_slot: usize = self.filters.apply_chain(
                &mut encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                &mut scratch.filter_scratch,
                SLOT_PRESENTATION_ROOT,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                input.screen_filters,
                force_render_filters,
            );

            // 6. Composite `presentation_root` over backdrop color + `fade_overlay` in ONE `final_output_rt` pass.
            let bg: [f32; 4] = input.background_clear;
            let clear_bg: wgpu::Color = wgpu::Color {
                r: (bg[0] * bg[3]) as f64,
                g: (bg[1] * bg[3]) as f64,
                b: (bg[2] * bg[3]) as f64,
                a: bg[3] as f64,
            };
            let mut final_batches: Vec<(&wgpu::BindGroup, u32, u32)> = Vec::with_capacity(2);
            let pres_verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
            let (p_start, p_end) = Self::push_quad_tris(&mut scratch.quad_verts, &pres_verts);
            final_batches.push((&self.pool_quad_bgs[screen_filtered_slot], p_start, p_end));
            if input.fade_visible && input.fade_alpha > 0.0 {
                let a: f32 = input.fade_alpha;
                let fade_col: [f32; 4] = [
                    input.fade_color[0] * a,
                    input.fade_color[1] * a,
                    input.fade_color[2] * a,
                    a,
                ];
                let fade_verts: [QuadVertex; 4] = full_ndc_quad(fade_col);
                let (f_start, f_end) = Self::push_quad_tris(&mut scratch.quad_verts, &fade_verts);
                final_batches.push((&self.white_tex.quad_bg, f_start, f_end));
            }
            self.draw_batched_quad_pass(
                &mut encoder,
                &scratch,
                SLOT_FINAL_OUTPUT,
                Some(clear_bg),
                &final_batches,
            );

            // 7. Pack YUV420p on GPU (when enabled) or copy RGBA8 to staging readback buffer and submit.
            scratch.flush(&self.queue);
            self.enqueue_readback(encoder, slot, readback_kind);
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
    ) {
        let target_buf: &wgpu::Buffer = match (readback_kind, self.yuv_resources.as_ref()) {
            (ReadbackKind::Yuv, Some(yuv)) => {
                self.filters.encode_yuv420p_pass(
                    &mut encoder,
                    &self.pool_filter_bgs[SLOT_FINAL_OUTPUT],
                    &yuv.pack_bg,
                    yuv.y_words,
                    yuv.uv_words,
                );
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
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.pool_textures[SLOT_FINAL_OUTPUT],
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &self.readback_bufs[slot],
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
                &self.readback_bufs[slot]
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

    fn render_single_model(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        model_in: &GpuRenderModelInput<'_>,
        force_render_filters: bool,
    ) -> Result<(), RendererError> {
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
            return Ok(());
        }

        // Stage deformed vertex coordinates into this slot's shared GPU vertex buffer.
        let model_v_base: i32 = scratch.l2d_verts.len() as i32;
        for mesh in meshes {
            for v in mesh.vertices() {
                scratch.l2d_verts.push(Live2dVertex {
                    pos: v.position(),
                    uv: v.uv(),
                });
            }
        }
        let mesh_ranges: &[(i32, u32, u32)] = &cache.mesh_ranges;

        // Build drawable -> clipping context index lookup table.
        let mut drawable_ctx: Vec<Option<usize>> = vec![None; meshes.len()];
        for (ctx_idx, ctx) in plan.contexts().iter().enumerate() {
            for &d_idx in ctx.drawable_indices() {
                if d_idx < drawable_ctx.len() {
                    drawable_ctx[d_idx] = Some(ctx_idx);
                }
            }
        }

        // 1. Mask pass (if any clipping contexts exist).
        if !plan.contexts().is_empty() {
            let mut mask_calls: Vec<(usize, bool, usize)> = Vec::new();
            let mask_u_base: usize = scratch.l2d_mask_raw.len();
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
                    mask_calls.push((
                        m_idx,
                        (meshes[m_idx].drawable_flags() & 0x04) != 0,
                        tex_i as usize,
                    ));
                }
            }

            if !mask_calls.is_empty() {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("l2d_mask_pass"),
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
                rpass.set_index_buffer(cache.ibuf.slice(..), wgpu::IndexFormat::Uint16);
                let mut prev_double_sided: Option<bool> = None;
                let mut prev_tex: Option<usize> = None;
                for (slot_idx, &(m_idx, double_sided, tex_i)) in mask_calls.iter().enumerate() {
                    if prev_double_sided != Some(double_sided) {
                        let pipe = if double_sided {
                            &self.live2d_mask_pipe_nocull
                        } else {
                            &self.live2d_mask_pipe_cull
                        };
                        rpass.set_pipeline(pipe);
                        prev_double_sided = Some(double_sided);
                    }
                    let (base_v, idx_start, idx_count) = mesh_ranges[m_idx];
                    let dyn_off: u32 = (mask_u_base + slot_idx * self.uniform_stride) as u32;
                    rpass.set_bind_group(0, &scratch.l2d_mask_ubg, &[dyn_off]);
                    if prev_tex != Some(tex_i) {
                        rpass.set_bind_group(1, &cache.mask_tbgs[tex_i], &[]);
                        prev_tex = Some(tex_i);
                    }
                    rpass.draw_indexed(idx_start..idx_start + idx_count, model_v_base + base_v, 0..1);
                }
            }
        }

        // 2+3. Clear `SLOT_MODEL_RT` + render Live2D meshes + add-blend `TriangleParticles` in ONE pass.
        let draw_order: Vec<usize> = draw_order_indices(&infos);
        let mvp: [f32; 16] =
            model.mvp_ndc_for_stage(self.stage_width as f32, self.stage_height as f32);

        struct DrawCallMeta {
            mesh_idx: usize,
            tex_idx: usize,
            blend_idx: usize,
            cull_idx: usize,
        }
        let mut draw_calls: Vec<DrawCallMeta> = Vec::with_capacity(draw_order.len());
        let draw_u_base: usize = scratch.l2d_draw_raw.len();

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
            if mesh_ranges[d_idx].2 == 0 {
                continue;
            }

            let mesh = &meshes[d_idx];
            let (clip_matrix, channel_flag, mask_mode) = if let Some(ctx_i) = drawable_ctx[d_idx] {
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

            let mc = mesh.multiply_color();
            let sc = mesh.screen_color();
            let u: Live2dDrawUniformGpu = Live2dDrawUniformGpu {
                mvp,
                clip_matrix,
                base_color: [1.0, 1.0, 1.0, info.opacity()],
                multiply_color: [mc[0], mc[1], mc[2], 1.0],
                screen_color: [sc[0], sc[1], sc[2], 1.0],
                channel_flag,
                mask_mode,
                _pad: [0; 3],
            };
            let off: usize = scratch.l2d_draw_raw.len();
            scratch.l2d_draw_raw.resize(off + self.uniform_stride, 0);
            scratch.l2d_draw_raw[off..off + std::mem::size_of::<Live2dDrawUniformGpu>()]
                .copy_from_slice(bytemuck::bytes_of(&u));

            let blend_idx: usize = match mesh.blend_mode() {
                Moc3DrawableBlendMode::Normal => 0,
                Moc3DrawableBlendMode::Additive => 1,
                Moc3DrawableBlendMode::Multiplicative => 2,
            };
            let cull_idx: usize = usize::from((mesh.drawable_flags() & 0x04) != 0);
            draw_calls.push(DrawCallMeta {
                mesh_idx: d_idx,
                tex_idx: tex_i as usize,
                blend_idx,
                cull_idx,
            });
        }

        let particle_range: Option<(u32, u32)> = if !model_in.particles.is_empty() {
            let tri_verts: Vec<QuadVertex> = build_triangle_particle_verts(
                model,
                model_in.particles,
                self.stage_width as f32,
                self.stage_height as f32,
            );
            if tri_verts.is_empty() {
                None
            } else {
                let p_start: u32 = scratch.quad_verts.len() as u32;
                scratch.quad_verts.extend_from_slice(&tri_verts);
                let p_end: u32 = scratch.quad_verts.len() as u32;
                Some((p_start, p_end))
            }
        } else {
            None
        };

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("l2d_model_and_particles_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pool_views[SLOT_MODEL_RT],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if !draw_calls.is_empty() {
                rpass.set_vertex_buffer(0, scratch.l2d_vbuf.slice(..));
                rpass.set_index_buffer(cache.ibuf.slice(..), wgpu::IndexFormat::Uint16);
                let mut prev_pipe: Option<(usize, usize)> = None;
                let mut prev_tex: Option<usize> = None;
                for (slot_idx, meta) in draw_calls.iter().enumerate() {
                    if prev_pipe != Some((meta.blend_idx, meta.cull_idx)) {
                        rpass.set_pipeline(&self.live2d_pipes[meta.blend_idx][meta.cull_idx]);
                        prev_pipe = Some((meta.blend_idx, meta.cull_idx));
                    }
                    let (base_v, idx_start, idx_count) = mesh_ranges[meta.mesh_idx];
                    let dyn_off: u32 = (draw_u_base + slot_idx * self.uniform_stride) as u32;
                    rpass.set_bind_group(0, &scratch.l2d_draw_ubg, &[dyn_off]);
                    if prev_tex != Some(meta.tex_idx) {
                        rpass.set_bind_group(1, &cache.draw_tbgs[meta.tex_idx], &[]);
                        prev_tex = Some(meta.tex_idx);
                    }
                    rpass.draw_indexed(idx_start..idx_start + idx_count, model_v_base + base_v, 0..1);
                }
            }
            if let Some((p_start, p_end)) = particle_range {
                rpass.set_pipeline(&self.quad_pipe_add);
                rpass.set_bind_group(0, &self.white_tex.quad_bg, &[]);
                rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
                rpass.draw(p_start..p_end, 0..1);
            }
        }

        // 4. Draw model child `HologramBeam` (`beam_rt` -> `[CRT, Adjustment, Bloom]` -> `SLOT_MODEL_RT`).
        for beam in model_in.hologram_beams {
            let mut beam_verts: Vec<QuadVertex> = Vec::with_capacity(12);
            beam_verts.extend_from_slice(&build_hologram_trapezoid_verts(
                model,
                beam.large_scale,
                beam.large_alpha,
                self.stage_width as f32,
                self.stage_height as f32,
            ));
            beam_verts.extend_from_slice(&build_hologram_trapezoid_verts(
                model,
                beam.small_scale,
                beam.small_alpha,
                self.stage_width as f32,
                self.stage_height as f32,
            ));
            self.draw_triangle_list(
                encoder,
                scratch,
                SLOT_BEAM_RT,
                &self.ui_hologram.quad_bg,
                &beam_verts,
                false,
                Some(wgpu::Color::TRANSPARENT),
            );

            let filtered_beam_slot: usize = self.filters.apply_chain(
                encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                &mut scratch.filter_scratch,
                SLOT_BEAM_RT,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                &beam.filters,
                force_render_filters,
            );
            let beam_comp_verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
            self.draw_quads(
                encoder,
                scratch,
                SLOT_MODEL_RT,
                &self.pool_quad_bgs[filtered_beam_slot],
                &beam_comp_verts,
                false,
                false,
            );
        }

        // 5. Composite onto `SLOT_STAGE_ROOT`, folding `AlphaFilter` into the composite quad when no
        // parent filters are attached to avoid an extra full-screen pass.
        if model_in.parent_filters.is_empty() {
            let comp_verts: [QuadVertex; 4] = full_ndc_quad([model.stage.alpha; 4]);
            self.draw_quads(
                encoder,
                scratch,
                SLOT_STAGE_ROOT,
                &self.pool_quad_bgs[SLOT_MODEL_RT],
                &comp_verts,
                false,
                false,
            );
        } else {
            let mut model_filters: Vec<GpuFilterSpec> =
                Vec::with_capacity(1 + model_in.parent_filters.len());
            model_filters.push(GpuFilterSpec::Alpha(model.stage.alpha));
            model_filters.extend_from_slice(model_in.parent_filters);

            let filtered_model_slot: usize = self.filters.apply_chain(
                encoder,
                &self.pool_views,
                &self.pool_filter_bgs,
                &self.pool_cs_dst_bgs,
                &self.pool_cs_orig_bgs,
                &mut scratch.filter_scratch,
                SLOT_MODEL_RT,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                &model_filters,
                force_render_filters,
            );
            let comp_verts: [QuadVertex; 4] = full_ndc_quad([1.0; 4]);
            self.draw_quads(
                encoder,
                scratch,
                SLOT_STAGE_ROOT,
                &self.pool_quad_bgs[filtered_model_slot],
                &comp_verts,
                false,
                false,
            );
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

    fn draw_quads(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        dst_slot: usize,
        tex_bg: &wgpu::BindGroup,
        verts: &[QuadVertex; 4],
        additive: bool,
        clear_first: bool,
    ) {
        let tri: [QuadVertex; 6] = [verts[0], verts[1], verts[2], verts[0], verts[2], verts[3]];
        let clear_color: Option<wgpu::Color> = if clear_first {
            Some(wgpu::Color::TRANSPARENT)
        } else {
            None
        };
        self.draw_triangle_list(
            encoder,
            scratch,
            dst_slot,
            tex_bg,
            &tri,
            additive,
            clear_color,
        );
    }

    fn draw_triangle_list(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        scratch: &mut FrameScratch,
        dst_slot: usize,
        tex_bg: &wgpu::BindGroup,
        verts: &[QuadVertex],
        additive: bool,
        clear_color: Option<wgpu::Color>,
    ) {
        if verts.is_empty() {
            if let Some(c) = clear_color {
                self.clear_rt(encoder, dst_slot, c);
            }
            return;
        }
        let v_start: u32 = scratch.quad_verts.len() as u32;
        scratch.quad_verts.extend_from_slice(verts);
        let v_end: u32 = scratch.quad_verts.len() as u32;
        let load: wgpu::LoadOp<wgpu::Color> = match clear_color {
            Some(c) => wgpu::LoadOp::Clear(c),
            None => wgpu::LoadOp::Load,
        };

        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("tri_pass"),
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
        rpass.set_pipeline(if additive {
            &self.quad_pipe_add
        } else {
            &self.quad_pipe_normal
        });
        rpass.set_bind_group(0, tex_bg, &[]);
        rpass.set_vertex_buffer(0, scratch.quad_vbuf.slice(..));
        rpass.draw(v_start..v_end, 0..1);
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
        assert!(
            max_diff <= 1,
            "Compute filter path exceeded 1/255 channel tolerance vs fragment path: max_diff={max_diff}"
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
        assert_eq!(gpu_yuv.y, cpu_y, "GPU Y plane diverged from CPU BT.709");
        assert_eq!(gpu_yuv.u, cpu_u, "GPU U plane diverged from CPU BT.709");
        assert_eq!(gpu_yuv.v, cpu_v, "GPU V plane diverged from CPU BT.709");

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
}
