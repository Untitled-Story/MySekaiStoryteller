use bytemuck::{Pod, Zeroable};
use mocari::moc3::Moc3DrawableBlendMode;
use std::collections::HashMap;
use std::f32::consts::FRAC_PI_2;
use std::path::Path;

use crate::renderer::error::RendererError;
use crate::renderer::live2d::Live2DModelInstance;
use crate::renderer::svg_assets::{load_image_premul, BuiltinUiBitmaps, PremulImage};
use crate::renderer::text::{RenderedTextSurface, StoryTextRenderer};
use crate::renderer::vfx::{GpuFilterSpec, HologramBeamRenderData, TriangleParticle};

use super::filters::{
    live2d_additive_blend, live2d_mask_setup_blend, live2d_multiplicative_blend, pixi_add_blend,
    pixi_normal_blend, FilterPipelines,
};

const WGSL_SHADERS: &str = include_str!("shaders.wgsl");
const MASK_ATLAS_SIZE: u32 = 1024;

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
    pub width: u32,
    pub height: u32,
}

impl GpuTextureAsset {
    fn from_premul(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
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
        Self {
            texture,
            view,
            width,
            height,
        }
    }

    fn create_render_target(device: &wgpu::Device, width: u32, height: u32, label: &str) -> Self {
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
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

    // Render target pool & readback buffer
    pool_textures: Vec<wgpu::Texture>,
    pool_views: Vec<wgpu::TextureView>,
    mask_atlas: GpuTextureAsset,
    readback_buf: wgpu::Buffer,
    padded_bytes_per_row: u32,

    // Cached static/dynamic scene textures
    ui_text_bg: GpuTextureAsset,
    ui_text_underline: GpuTextureAsset,
    ui_telop: GpuTextureAsset,
    ui_hologram: GpuTextureAsset,
    backgrounds: HashMap<String, GpuTextureAsset>,
    model_textures: HashMap<String, Vec<GpuTextureAsset>>,
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

        let filters = FilterPipelines::new(&device, &shader);

        let sampler_clamp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("clamp_linear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let white_img = PremulImage {
            width: 1,
            height: 1,
            data: vec![255, 255, 255, 255],
        };
        let white_tex = GpuTextureAsset::from_premul(&device, &queue, &white_img, "white_1x1");

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

        // Allocate render target pool
        let mut pool_textures = Vec::with_capacity(POOL_SIZE);
        let mut pool_views = Vec::with_capacity(POOL_SIZE);
        for i in 0..POOL_SIZE {
            let rt = GpuTextureAsset::create_render_target(
                &device,
                stage_width,
                stage_height,
                &format!("rt_slot_{i}"),
            );
            pool_views.push(rt.view);
            pool_textures.push(rt.texture);
        }

        let mask_atlas = GpuTextureAsset::create_render_target(
            &device,
            MASK_ATLAS_SIZE,
            MASK_ATLAS_SIZE,
            "live2d_mask_atlas",
        );

        let padded_bytes_per_row = align_to(stage_width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame_readback_buf"),
            size: (padded_bytes_per_row as u64) * (stage_height as u64),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let ui_bitmaps = BuiltinUiBitmaps::render_for_stage(stage_width, stage_height)?;
        let ui_text_bg =
            GpuTextureAsset::from_premul(&device, &queue, &ui_bitmaps.text_background, "ui_txt_bg");
        let ui_text_underline = GpuTextureAsset::from_premul(
            &device,
            &queue,
            &ui_bitmaps.text_underline,
            "ui_underline",
        );
        let ui_telop = GpuTextureAsset::from_premul(&device, &queue, &ui_bitmaps.telop, "ui_telop");
        let ui_hologram =
            GpuTextureAsset::from_premul(&device, &queue, &ui_bitmaps.hologram, "ui_hologram");

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
            mask_atlas,
            readback_buf,
            padded_bytes_per_row,
            ui_text_bg,
            ui_text_underline,
            ui_telop,
            ui_hologram,
            backgrounds: HashMap::new(),
            model_textures: HashMap::new(),
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
        let tex =
            GpuTextureAsset::from_premul(&self.device, &self.queue, &img, &format!("bg_{key}"));
        self.backgrounds.insert(key.to_string(), tex);
        Ok(())
    }

    pub fn register_live2d_model(&mut self, key: &str, model: &Live2DModelInstance) {
        if self.model_textures.contains_key(key) {
            return;
        }
        let mut list = Vec::with_capacity(model.textures().len());
        for (i, decoded) in model.textures().iter().enumerate() {
            let premul = PremulImage::from_straight_rgba(
                decoded.width(),
                decoded.height(),
                decoded.rgba().to_vec(),
            );
            list.push(GpuTextureAsset::from_premul(
                &self.device,
                &self.queue,
                &premul,
                &format!("l2d_{key}_{i}"),
            ));
        }
        self.model_textures.insert(key.to_string(), list);
    }

    /// Renders one complete composited frame and returns tight `stage_width * stage_height * 4` RGBA8 bytes.
    pub fn render_frame(
        &mut self,
        input: &GpuRenderFrameInput<'_>,
        text_renderer: &mut StoryTextRenderer,
    ) -> Result<Vec<u8>, RendererError> {
        let sw = self.stage_width as f32;
        let sh = self.stage_height as f32;

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

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame_encoder"),
            });

        // 1. Clear `stage_root` transparent and draw background (`background` layer).
        self.clear_rt(&mut encoder, SLOT_STAGE_ROOT, wgpu::Color::TRANSPARENT);
        if let Some(bg_key) = input.background_key {
            if let Some(bg) = self.backgrounds.get(bg_key) {
                let scale = if (bg.width as f32 / bg.height.max(1) as f32) > (sw / sh) {
                    sh / bg.height.max(1) as f32
                } else {
                    sw / bg.width.max(1) as f32
                };
                let draw_w = bg.width as f32 * scale;
                let draw_h = bg.height as f32 * scale;
                let x = (sw - draw_w) * 0.5;
                let y = (sh - draw_h) * 0.5;
                let verts = stage_quad_verts(x, y, draw_w, draw_h, sw, sh, [1.0; 4]);
                self.draw_quads(
                    &mut encoder,
                    SLOT_STAGE_ROOT,
                    &bg.view,
                    &verts,
                    false,
                    false,
                );
            }
        }

        // 2. Render each visible Live2D model + child VFX + parent filters onto `stage_root`.
        for model_in in input.models {
            if !model_in.model.stage.visible || model_in.model.stage.alpha <= 0.0 {
                continue;
            }
            self.render_single_model(&mut encoder, model_in)?;
        }

        // 3. Apply Stage filters (`stageRoot.filters`) into `presentation_root`.
        let stage_filtered_slot = self.filters.apply_chain(
            &self.device,
            &self.queue,
            &mut encoder,
            &self.pool_views,
            SLOT_STAGE_ROOT,
            SCRATCH_START,
            self.stage_width,
            self.stage_height,
            input.stage_filters,
        );
        if stage_filtered_slot != SLOT_PRESENTATION_ROOT {
            let verts = full_ndc_quad([1.0; 4]);
            self.draw_quads(
                &mut encoder,
                SLOT_PRESENTATION_ROOT,
                &self.pool_views[stage_filtered_slot],
                &verts,
                false,
                true,
            );
        }

        // 4. Draw `ui` layer (Dialogue + Telop) into `presentation_root`.
        if input.dialogue_visible {
            if input.dialogue_bg_alpha > 0.0 {
                let a = input.dialogue_bg_alpha;
                let verts = stage_quad_verts(0.0, 0.0, sw, sh, sw, sh, [a; 4]);
                self.draw_quads(
                    &mut encoder,
                    SLOT_PRESENTATION_ROOT,
                    &self.ui_text_bg.view,
                    &verts,
                    false,
                    false,
                );
            }
            if input.dialogue_underline_alpha > 0.0 {
                let a = input.dialogue_underline_alpha;
                let uw = self.ui_text_underline.width as f32;
                let uh = self.ui_text_underline.height as f32;
                let ux = sw / 10.0;
                let uy = sh / 1.3;
                let verts = stage_quad_verts(ux, uy, uw, uh, sw, sh, [a; 4]);
                self.draw_quads(
                    &mut encoder,
                    SLOT_PRESENTATION_ROOT,
                    &self.ui_text_underline.view,
                    &verts,
                    false,
                    false,
                );
            }
            if input.dialogue_body_alpha > 0.0 {
                if let Some((tex, ox, oy)) = &self.cached_body.surface {
                    let a = input.dialogue_body_alpha;
                    let verts = stage_quad_verts(
                        sw / 8.0 + ox,
                        sh / 1.27 + oy,
                        tex.width as f32,
                        tex.height as f32,
                        sw,
                        sh,
                        [a; 4],
                    );
                    self.draw_quads(
                        &mut encoder,
                        SLOT_PRESENTATION_ROOT,
                        &tex.view,
                        &verts,
                        false,
                        false,
                    );
                }
            }
            if input.dialogue_speaker_alpha > 0.0 {
                if let Some((tex, ox, oy)) = &self.cached_speaker.surface {
                    let a = input.dialogue_speaker_alpha;
                    let verts = stage_quad_verts(
                        sw / 9.0 + ox,
                        sh / 1.3 - sw / 42.0 + oy,
                        tex.width as f32,
                        tex.height as f32,
                        sw,
                        sh,
                        [a; 4],
                    );
                    self.draw_quads(
                        &mut encoder,
                        SLOT_PRESENTATION_ROOT,
                        &tex.view,
                        &verts,
                        false,
                        false,
                    );
                }
            }
        }

        if input.telop_visible && input.telop_alpha > 0.0 {
            self.clear_rt(&mut encoder, SLOT_TELOP_RT, wgpu::Color::TRANSPARENT);
            let tw = self.ui_telop.width as f32;
            let th = self.ui_telop.height as f32;
            let bg_verts = stage_quad_verts(
                sw * 0.5 - tw * 0.5 + input.telop_x_offset,
                sh * 0.5 - th * 0.5,
                tw,
                th,
                sw,
                sh,
                [1.0; 4],
            );
            self.draw_quads(
                &mut encoder,
                SLOT_TELOP_RT,
                &self.ui_telop.view,
                &bg_verts,
                false,
                false,
            );
            if let Some((tex, ox, oy)) = &self.cached_telop.surface {
                let t_verts = stage_quad_verts(
                    sw * 0.5 - 10.0 + input.telop_x_offset + ox,
                    sh * 0.5 + sh / 300.0 + oy,
                    tex.width as f32,
                    tex.height as f32,
                    sw,
                    sh,
                    [1.0; 4],
                );
                self.draw_quads(
                    &mut encoder,
                    SLOT_TELOP_RT,
                    &tex.view,
                    &t_verts,
                    false,
                    false,
                );
            }
            let alpha_verts = full_ndc_quad([input.telop_alpha; 4]);
            self.draw_quads(
                &mut encoder,
                SLOT_PRESENTATION_ROOT,
                &self.pool_views[SLOT_TELOP_RT],
                &alpha_verts,
                false,
                false,
            );
        }

        // 5. Apply Screen filters (`presentationRoot.filters`).
        let screen_filtered_slot = self.filters.apply_chain(
            &self.device,
            &self.queue,
            &mut encoder,
            &self.pool_views,
            SLOT_PRESENTATION_ROOT,
            SCRATCH_START,
            self.stage_width,
            self.stage_height,
            input.screen_filters,
        );

        // 6. Composite `presentation_root` over backdrop color + `fade_overlay` into `final_output_rt`.
        let bg = input.background_clear;
        self.clear_rt(
            &mut encoder,
            SLOT_FINAL_OUTPUT,
            wgpu::Color {
                r: (bg[0] * bg[3]) as f64,
                g: (bg[1] * bg[3]) as f64,
                b: (bg[2] * bg[3]) as f64,
                a: bg[3] as f64,
            },
        );
        let pres_verts = full_ndc_quad([1.0; 4]);
        self.draw_quads(
            &mut encoder,
            SLOT_FINAL_OUTPUT,
            &self.pool_views[screen_filtered_slot],
            &pres_verts,
            false,
            false,
        );

        if input.fade_visible && input.fade_alpha > 0.0 {
            let a = input.fade_alpha;
            let fade_col = [
                input.fade_color[0] * a,
                input.fade_color[1] * a,
                input.fade_color[2] * a,
                a,
            ];
            let fade_verts = full_ndc_quad(fade_col);
            self.draw_quads(
                &mut encoder,
                SLOT_FINAL_OUTPUT,
                &self.white_tex.view,
                &fade_verts,
                false,
                false,
            );
        }

        // 7. Copy `final_output_rt` to readback buffer.
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.pool_textures[SLOT_FINAL_OUTPUT],
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback_buf,
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

        self.queue.submit(Some(encoder.finish()));

        // Map & strip row padding into tight RGBA8 output.
        let slice = self.readback_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv()
            .map_err(|_| RendererError::Gpu("GPU readback channel closed".to_string()))?
            .map_err(|err| RendererError::Gpu(format!("GPU buffer map failed: {err}")))?;

        let mapped = slice
            .get_mapped_range()
            .map_err(|err| RendererError::Gpu(format!("GPU buffer map range failed: {err}")))?;
        let row_bytes = (self.stage_width * 4) as usize;
        let stride = self.padded_bytes_per_row as usize;
        let mut rgba = vec![0u8; row_bytes * self.stage_height as usize];
        for row in 0..self.stage_height as usize {
            let src_start = row * stride;
            let dst_start = row * row_bytes;
            rgba[dst_start..dst_start + row_bytes]
                .copy_from_slice(&mapped[src_start..src_start + row_bytes]);
        }
        drop(mapped);
        self.readback_buf.unmap();

        Ok(rgba)
    }

    fn render_single_model(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        model_in: &GpuRenderModelInput<'_>,
    ) -> Result<(), RendererError> {
        let model = model_in.model;
        let textures = self.model_textures.get(&model.key).ok_or_else(|| {
            RendererError::MissingAsset(format!(
                "Live2D GPU textures not registered for '{}'",
                model.key
            ))
        })?;
        let meshes = model.meshes();
        let (infos, plan) = model.build_clipping_plan()?;

        // Concatenate all vertices & indices of all meshes of this model into shared GPU buffers.
        let mut all_verts: Vec<Live2dVertex> = Vec::new();
        let mut all_indices: Vec<u16> = Vec::new();
        let mut mesh_ranges: Vec<(i32, u32, u32)> = Vec::with_capacity(meshes.len());
        for mesh in meshes {
            let base_v = all_verts.len() as i32;
            for v in mesh.vertices() {
                all_verts.push(Live2dVertex {
                    pos: v.position(),
                    uv: v.uv(),
                });
            }
            let idx_start = all_indices.len() as u32;
            all_indices.extend_from_slice(mesh.indices());
            let idx_count = mesh.indices().len() as u32;
            mesh_ranges.push((base_v, idx_start, idx_count));
        }

        if all_verts.is_empty() || all_indices.is_empty() {
            return Ok(());
        }

        let vbuf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("l2d_vbuf"),
            size: (all_verts.len() * std::mem::size_of::<Live2dVertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue
            .write_buffer(&vbuf, 0, bytemuck::cast_slice(&all_verts));

        let ibuf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("l2d_ibo"),
            size: align_to((all_indices.len() * 2) as u32, 4) as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let raw_idx: &[u8] = bytemuck::cast_slice(&all_indices);
        let mut padded_idx = raw_idx.to_vec();
        while padded_idx.len() % 4 != 0 {
            padded_idx.push(0);
        }
        self.queue.write_buffer(&ibuf, 0, &padded_idx);

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
            for ctx in plan.contexts() {
                let Some(layout) = ctx.layout() else { continue };
                let Some(clip_mat) = ctx.matrix_for_mask() else {
                    continue;
                };
                let b = layout.bounds();
                let u_rect = [
                    b.x() * 2.0 - 1.0,
                    b.y() * 2.0 - 1.0,
                    (b.x() + b.width()) * 2.0 - 1.0,
                    (b.y() + b.height()) * 2.0 - 1.0,
                ];
                let ch_flag = layout.channel_flag();
                for &clip_idx_i32 in ctx.masks() {
                    if clip_idx_i32 < 0 {
                        continue;
                    }
                    let m_idx = clip_idx_i32 as usize;
                    if m_idx >= meshes.len() {
                        continue;
                    }
                    let tex_i = meshes[m_idx].texture_index();
                    if tex_i < 0 || (tex_i as usize) >= textures.len() {
                        continue;
                    }
                    let (_, _, count) = mesh_ranges[m_idx];
                    if count == 0 {
                        continue;
                    }
                    mask_calls.push((m_idx, false, 0));
                    let _ = (clip_mat, u_rect, ch_flag);
                }
            }

            if !mask_calls.is_empty() {
                let mut mask_u_bytes = vec![0u8; mask_calls.len() * self.uniform_stride];
                let mut write_slot = 0usize;
                for ctx in plan.contexts() {
                    let Some(layout) = ctx.layout() else { continue };
                    let Some(clip_mat) = ctx.matrix_for_mask() else {
                        continue;
                    };
                    let b = layout.bounds();
                    let u_rect = [
                        b.x() * 2.0 - 1.0,
                        b.y() * 2.0 - 1.0,
                        (b.x() + b.width()) * 2.0 - 1.0,
                        (b.y() + b.height()) * 2.0 - 1.0,
                    ];
                    let ch_flag = layout.channel_flag();
                    for &clip_idx_i32 in ctx.masks() {
                        if clip_idx_i32 < 0 {
                            continue;
                        }
                        let m_idx = clip_idx_i32 as usize;
                        if m_idx >= meshes.len() {
                            continue;
                        }
                        let tex_i = meshes[m_idx].texture_index();
                        if tex_i < 0 || (tex_i as usize) >= textures.len() {
                            continue;
                        }
                        if mesh_ranges[m_idx].2 == 0 {
                            continue;
                        }
                        let u = Live2dMaskUniformGpu {
                            clip_matrix: *clip_mat.as_slice(),
                            base_color: u_rect,
                            channel_flag: ch_flag,
                        };
                        let off = write_slot * self.uniform_stride;
                        mask_u_bytes[off..off + std::mem::size_of::<Live2dMaskUniformGpu>()]
                            .copy_from_slice(bytemuck::bytes_of(&u));
                        mask_calls[write_slot] = (
                            m_idx,
                            (meshes[m_idx].drawable_flags() & 0x04) != 0,
                            tex_i as usize,
                        );
                        write_slot += 1;
                    }
                }

                let ubuf = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("l2d_mask_ubuf"),
                    size: mask_u_bytes.len() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.queue.write_buffer(&ubuf, 0, &mask_u_bytes);
                let u_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("l2d_mask_ubg"),
                    layout: &self.live2d_mask_ubgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &ubuf,
                            offset: 0,
                            size: wgpu::BufferSize::new(
                                std::mem::size_of::<Live2dMaskUniformGpu>() as u64,
                            ),
                        }),
                    }],
                });
                let tex_bgs: Vec<wgpu::BindGroup> = textures
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
                rpass.set_vertex_buffer(0, vbuf.slice(..));
                rpass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint16);
                for (slot, &(m_idx, double_sided, tex_i)) in mask_calls.iter().enumerate() {
                    let pipe = if double_sided {
                        &self.live2d_mask_pipe_nocull
                    } else {
                        &self.live2d_mask_pipe_cull
                    };
                    let (base_v, idx_start, idx_count) = mesh_ranges[m_idx];
                    rpass.set_pipeline(pipe);
                    rpass.set_bind_group(0, &u_bg, &[(slot * self.uniform_stride) as u32]);
                    rpass.set_bind_group(1, &tex_bgs[tex_i], &[]);
                    rpass.draw_indexed(idx_start..idx_start + idx_count, base_v, 0..1);
                }
            }
        }

        // 2. Render model meshes in sorted draw order into `SLOT_MODEL_RT`.
        self.clear_rt(encoder, SLOT_MODEL_RT, wgpu::Color::TRANSPARENT);
        let draw_order = model.sorted_draw_order();
        let mvp = model.mvp_ndc_for_stage(self.stage_width as f32, self.stage_height as f32);

        struct DrawCallMeta {
            mesh_idx: usize,
            tex_idx: usize,
            blend_idx: usize,
            cull_idx: usize,
        }
        let mut draw_calls = Vec::with_capacity(draw_order.len());
        let mut draw_uniforms_raw = vec![0u8; draw_order.len().max(1) * self.uniform_stride];

        for &d_idx in &draw_order {
            if d_idx >= meshes.len() || d_idx >= infos.len() {
                continue;
            }
            let info = &infos[d_idx];
            if !info.is_visible() {
                continue;
            }
            let tex_i = info.texture_index();
            if tex_i < 0 || (tex_i as usize) >= textures.len() {
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
            let u = Live2dDrawUniformGpu {
                mvp,
                clip_matrix,
                base_color: [1.0, 1.0, 1.0, info.opacity()],
                multiply_color: [mc[0], mc[1], mc[2], 1.0],
                screen_color: [sc[0], sc[1], sc[2], 1.0],
                channel_flag,
                mask_mode,
                _pad: [0; 3],
            };
            let call_i = draw_calls.len();
            let off = call_i * self.uniform_stride;
            draw_uniforms_raw[off..off + std::mem::size_of::<Live2dDrawUniformGpu>()]
                .copy_from_slice(bytemuck::bytes_of(&u));

            let blend_idx = match mesh.blend_mode() {
                Moc3DrawableBlendMode::Normal => 0,
                Moc3DrawableBlendMode::Additive => 1,
                Moc3DrawableBlendMode::Multiplicative => 2,
            };
            let cull_idx = if (mesh.drawable_flags() & 0x04) != 0 {
                1
            } else {
                0
            };
            draw_calls.push(DrawCallMeta {
                mesh_idx: d_idx,
                tex_idx: tex_i as usize,
                blend_idx,
                cull_idx,
            });
        }

        if !draw_calls.is_empty() {
            let used_bytes = draw_calls.len() * self.uniform_stride;
            let ubuf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("l2d_draw_ubuf"),
                size: used_bytes as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.queue
                .write_buffer(&ubuf, 0, &draw_uniforms_raw[..used_bytes]);

            let u_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("l2d_draw_ubg"),
                layout: &self.live2d_draw_ubgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &ubuf,
                        offset: 0,
                        size: wgpu::BufferSize::new(
                            std::mem::size_of::<Live2dDrawUniformGpu>() as u64
                        ),
                    }),
                }],
            });
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

            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("l2d_draw_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pool_views[SLOT_MODEL_RT],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_vertex_buffer(0, vbuf.slice(..));
            rpass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint16);
            for (slot, meta) in draw_calls.iter().enumerate() {
                let (base_v, idx_start, idx_count) = mesh_ranges[meta.mesh_idx];
                rpass.set_pipeline(&self.live2d_pipes[meta.blend_idx][meta.cull_idx]);
                rpass.set_bind_group(0, &u_bg, &[(slot * self.uniform_stride) as u32]);
                rpass.set_bind_group(1, &draw_tbgs[meta.tex_idx], &[]);
                rpass.draw_indexed(idx_start..idx_start + idx_count, base_v, 0..1);
            }
        }

        // 3. Draw model child `TriangleParticles` (add blend inside model container).
        if !model_in.particles.is_empty() {
            let tri_verts = build_triangle_particle_verts(
                model,
                model_in.particles,
                self.stage_width as f32,
                self.stage_height as f32,
            );
            if !tri_verts.is_empty() {
                self.draw_triangle_list(
                    encoder,
                    SLOT_MODEL_RT,
                    &self.white_tex.view,
                    &tri_verts,
                    true,
                );
            }
        }

        // 4. Draw model child `HologramBeam` (`beam_rt` -> `[CRT, Adjustment, Bloom]` -> `SLOT_MODEL_RT`).
        for beam in model_in.hologram_beams {
            self.clear_rt(encoder, SLOT_BEAM_RT, wgpu::Color::TRANSPARENT);
            let mut beam_verts = Vec::with_capacity(12);
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
                SLOT_BEAM_RT,
                &self.ui_hologram.view,
                &beam_verts,
                false,
            );

            let filtered_beam_slot = self.filters.apply_chain(
                &self.device,
                &self.queue,
                encoder,
                &self.pool_views,
                SLOT_BEAM_RT,
                SCRATCH_START,
                self.stage_width,
                self.stage_height,
                &beam.filters,
            );
            let beam_comp_verts = full_ndc_quad([1.0; 4]);
            self.draw_quads(
                encoder,
                SLOT_MODEL_RT,
                &self.pool_views[filtered_beam_slot],
                &beam_comp_verts,
                false,
                false,
            );
        }

        // 5. Run model filter chain (`[AlphaFilter(model.alpha), ...parent_filters]`) and composite onto `SLOT_STAGE_ROOT`.
        let mut model_filters = Vec::with_capacity(1 + model_in.parent_filters.len());
        model_filters.push(GpuFilterSpec::Alpha(model.stage.alpha));
        model_filters.extend_from_slice(model_in.parent_filters);

        let filtered_model_slot = self.filters.apply_chain(
            &self.device,
            &self.queue,
            encoder,
            &self.pool_views,
            SLOT_MODEL_RT,
            SCRATCH_START,
            self.stage_width,
            self.stage_height,
            &model_filters,
        );
        let comp_verts = full_ndc_quad([1.0; 4]);
        self.draw_quads(
            encoder,
            SLOT_STAGE_ROOT,
            &self.pool_views[filtered_model_slot],
            &comp_verts,
            false,
            false,
        );

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
            let tex = GpuTextureAsset::from_premul(&self.device, &self.queue, &s.image, "ui_text");
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
        dst_slot: usize,
        tex_view: &wgpu::TextureView,
        verts: &[QuadVertex; 4],
        additive: bool,
        clear_first: bool,
    ) {
        let mut tri = Vec::with_capacity(6);
        tri.push(verts[0]);
        tri.push(verts[1]);
        tri.push(verts[2]);
        tri.push(verts[0]);
        tri.push(verts[2]);
        tri.push(verts[3]);
        if clear_first {
            self.clear_rt(encoder, dst_slot, wgpu::Color::TRANSPARENT);
        }
        self.draw_triangle_list(encoder, dst_slot, tex_view, &tri, additive);
    }

    fn draw_triangle_list(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        dst_slot: usize,
        tex_view: &wgpu::TextureView,
        verts: &[QuadVertex],
        additive: bool,
    ) {
        if verts.is_empty() {
            return;
        }
        let vbuf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tri_vbuf"),
            size: (verts.len() * std::mem::size_of::<QuadVertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue
            .write_buffer(&vbuf, 0, bytemuck::cast_slice(verts));

        let tex_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("quad_tbg"),
            layout: &self.quad_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(tex_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler_clamp),
                },
            ],
        });

        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("tri_pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.pool_views[dst_slot],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
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
        rpass.set_bind_group(0, &tex_bg, &[]);
        rpass.set_vertex_buffer(0, vbuf.slice(..));
        rpass.draw(0..verts.len() as u32, 0..1);
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
    use crate::renderer::story::PlaybackFontConfig;
    use std::path::PathBuf;

    #[test]
    fn gpu_renders_live2d_model_with_dialogue_and_filters() {
        let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../tests/models/01ichika_normal_3.0_f_t04/01ichika_normal_3.0_f_t04.model3.json",
        );
        let mut model = Live2DModelInstance::load("ichika", &model_path, 42).expect("load model");
        let scale = (720.0 / model.original_height()) * 2.1;
        model.stage.pos_x = 640.0;
        model.stage.pos_y = 720.0 * 0.8;
        model.stage.scale = scale;
        model.stage.anchor_x = 0.5;
        model.stage.anchor_y = 0.5;
        model.stage.alpha = 1.0;
        model.stage.visible = true;
        model.accumulate_delta_ms(16.0);
        model.commit_frame_update();

        let mut gpu = GpuSceneRenderer::new(1280, 720).expect("init headless wgpu");
        gpu.register_live2d_model("ichika", &model);
        let mut text_renderer =
            StoryTextRenderer::new(&PlaybackFontConfig::Default, None).expect("font");

        let frame = gpu
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
        let non_black_pixels = frame
            .chunks_exact(4)
            .filter(|px| px[0] > 4 || px[1] > 4 || px[2] > 4)
            .count();
        assert!(
            non_black_pixels > 50_000,
            "Expected significant rendered model & UI coverage, got {non_black_pixels}"
        );
    }
}
