use bytemuck::{Pod, Zeroable};

use crate::renderer::vfx::{BloomFilterParams, BlurFilterParams, GpuFilterSpec};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct AlphaFilterUniformGpu {
    pub alpha: f32,
    pub _pad: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct AdjustmentUniformGpu {
    pub color: [f32; 4],
    pub gamma: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub brightness: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ColorOverlayUniformGpu {
    pub color: [f32; 3],
    pub alpha: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BlurUniformGpu {
    pub weights: [[f32; 4]; 4],
    pub texel_size: [f32; 2],
    pub strength: f32,
    pub horizontal: u32,
    pub kernel_size: i32,
    pub dst_offset_x: u32,
    pub dst_offset_y: u32,
    pub dispatch_w: u32,
    pub dispatch_h: u32,
    pub _pad0: u32,
    pub uv_min: [f32; 2],
    pub uv_max: [f32; 2],
    pub src_origin: [f32; 2],
    pub src_scale: [f32; 2],
    pub _pad1: [u32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CrtUniformGpu {
    pub u_line: [f32; 4],
    pub u_noise: [f32; 2],
    pub u_dimensions: [f32; 2],
    pub u_vignette: [f32; 3],
    pub u_seed: f32,
    pub u_time: f32,
    pub _pad: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OldFilmUniformGpu {
    pub u_scratch: [f32; 3],
    pub u_sepia: f32,
    pub u_vignetting: [f32; 3],
    pub u_seed: f32,
    pub u_noise: [f32; 2],
    pub u_dimensions: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct YuvConvertUniformGpu {
    pub width: u32,
    pub height: u32,
    pub y_words: u32,
    pub uv_words: u32,
}

pub const MAX_FUSED_POINTWISE_OPS: usize = 8;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct PointwiseOpGpu {
    pub kind: u32,
    pub _pad: [u32; 3],
    pub p0: [f32; 4],
    pub p1: [f32; 4],
    pub p2: [f32; 4],
    pub p3: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PostChainUniformGpu {
    pub width: u32,
    pub height: u32,
    pub y_words: u32,
    pub uv_words: u32,
    pub dst_offset_x: u32,
    pub dst_offset_y: u32,
    pub dispatch_w: u32,
    pub dispatch_h: u32,
    pub op_count: u32,
    pub apply_backdrop: u32,
    pub has_bloom_glow: u32,
    pub skip_transparent: u32,
    pub backdrop_clear: [f32; 4],
    pub fade_color_premul: [f32; 4],
    pub bloom_uv_scale: [f32; 2],
    pub bloom_uv_max: [f32; 2],
    pub stage_inv_dims: [f32; 2],
    pub uv_px_offset: [f32; 2],
    pub fade_alpha: f32,
    pub _pad_tail: [u32; 3],
    pub ops: [PointwiseOpGpu; MAX_FUSED_POINTWISE_OPS],
}

/// Rectangular subregion in full-stage pixel coordinates used to clip model/VFX filters.
#[derive(Clone, Copy, Debug)]
pub struct FilterRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl FilterRegion {
    /// Returns a region covering the entire `(width, height)` frame.
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            x: 0,
            y: 0,
            w: width.max(1),
            h: height.max(1),
        }
    }

    pub fn is_full(&self, width: u32, height: u32) -> bool {
        self.x == 0 && self.y == 0 && self.w == width && self.h == height
    }
}

/// References one downscaled scratch pool (`Half` = 1/2 res or `Quarter` = 1/4 res) for Blur/Bloom.
pub struct ScaledPoolLevel<'a> {
    pub width: u32,
    pub height: u32,
    pub scale_factor: u32,
    pub filter_bgs: &'a [wgpu::BindGroup],
    pub cs_dst_bgs: &'a [wgpu::BindGroup],
}

/// Optional deferred Bloom glow kept in a scaled buffer so a trailing fused YUV pass can blend it in registers.
#[derive(Clone, Copy, Debug)]
pub struct DeferredBloomGlow {
    pub mode: u32, // 1 = bloom screen glow, 2 = blur replace sample
    pub use_quarter: bool,
    pub scaled_slot: usize,
    pub uv_scale: [f32; 2],
    pub uv_max: [f32; 2],
}

pub fn ops_preserve_transparent(ops: &[PointwiseOpGpu], count: usize) -> u32 {
    let safe: bool = ops[..count].iter().all(|op| match op.kind {
        1..=3 => true,
        4 => op.p1[0] <= 0.0,
        5 => op.p2[0] <= 0.0,
        _ => false,
    });
    u32::from(safe)
}

/// Encodes one pointwise `GpuFilterSpec` into a `PointwiseOpGpu` entry, returning `None` for spatial ops.
pub fn encode_pointwise_op(spec: &GpuFilterSpec, stage_w: u32, stage_h: u32) -> Option<PointwiseOpGpu> {
    let w: f32 = stage_w.max(1) as f32;
    let h: f32 = stage_h.max(1) as f32;
    match spec {
        GpuFilterSpec::Alpha(alpha) => Some(PointwiseOpGpu {
            kind: 1,
            p0: [*alpha, 0.0, 0.0, 0.0],
            ..Default::default()
        }),
        GpuFilterSpec::Adjustment(p) => Some(PointwiseOpGpu {
            kind: 2,
            p0: p.color,
            p1: [p.gamma, p.contrast, p.saturation, p.brightness],
            ..Default::default()
        }),
        GpuFilterSpec::ColorOverlay(p) => Some(PointwiseOpGpu {
            kind: 3,
            p0: [p.color[0], p.color[1], p.color[2], p.alpha],
            ..Default::default()
        }),
        GpuFilterSpec::Crt(p) => Some(PointwiseOpGpu {
            kind: 4,
            p0: [
                p.curvature,
                p.line_width,
                p.line_contrast,
                if p.vertical_line { 1.0 } else { 0.0 },
            ],
            p1: [p.noise, p.noise_size, w, h],
            p2: [p.vignetting, p.vignetting_alpha, p.vignetting_blur, p.seed],
            p3: [p.time, 0.0, 0.0, 0.0],
            ..Default::default()
        }),
        GpuFilterSpec::OldFilm(p) => Some(PointwiseOpGpu {
            kind: 5,
            p0: [p.scratch, p.scratch_density, p.scratch_width, p.sepia],
            p1: [p.vignetting, p.vignetting_alpha, p.vignetting_blur, p.seed],
            p2: [p.noise, p.noise_size, w, h],
            ..Default::default()
        }),
        GpuFilterSpec::Blur(_) | GpuFilterSpec::Bloom(_) => None,
    }
}

/// Returns whether a filter is purely pointwise (`Alpha`, `Adjustment`, `ColorOverlay`, `Crt`, `OldFilm`).
pub fn is_pointwise_filter(spec: &GpuFilterSpec) -> bool {
    !matches!(spec, GpuFilterSpec::Blur(_) | GpuFilterSpec::Bloom(_))
}

/// Exact `GAUSSIAN_VALUES` constants from `node_modules/pixi.js/lib/filters/defaults/blur/const.mjs`.
pub fn gaussian_half_kernel(kernel_size: u32) -> (i32, [[f32; 4]; 4]) {
    let (k, vals): (i32, &[f32]) = match kernel_size {
        5 => (5, &[0.153388, 0.221461, 0.250301]),
        7 => (7, &[0.071303, 0.131514, 0.189879, 0.214607]),
        9 => (9, &[0.028532, 0.067234, 0.124009, 0.179044, 0.20236]),
        11 => (11, &[0.0093, 0.028002, 0.065984, 0.121703, 0.175713, 0.198596]),
        13 => (
            13,
            &[0.002406, 0.009255, 0.027867, 0.065666, 0.121117, 0.174868, 0.197641],
        ),
        15 => (
            15,
            &[
                0.000489, 0.002403, 0.009246, 0.02784, 0.065602, 0.120999, 0.174697, 0.197448,
            ],
        ),
        _ => (5, &[0.153388, 0.221461, 0.250301]),
    };

    let mut flat = [0.0f32; 16];
    for (i, &w) in vals.iter().enumerate() {
        flat[i] = w;
    }
    let packed = [
        [flat[0], flat[1], flat[2], flat[3]],
        [flat[4], flat[5], flat[6], flat[7]],
        [flat[8], flat[9], flat[10], flat[11]],
        [flat[12], flat[13], flat[14], flat[15]],
    ];
    (k, packed)
}

/// Returns discrete variance `sum_{d} d^2 * w_d` for the Gaussian half-kernel of `kernel_size`.
fn gaussian_kernel_variance(kernel_size: u32) -> f32 {
    let (k, packed): (i32, [[f32; 4]; 4]) = gaussian_half_kernel(kernel_size);
    let r: i32 = (k - 1) / 2;
    let flat: [f32; 16] = [
        packed[0][0], packed[0][1], packed[0][2], packed[0][3],
        packed[1][0], packed[1][1], packed[1][2], packed[1][3],
        packed[2][0], packed[2][1], packed[2][2], packed[2][3],
        packed[3][0], packed[3][1], packed[3][2], packed[3][3],
    ];
    let mut var: f32 = 0.0;
    for i in 0..r as usize {
        let d: f32 = (r - i as i32) as f32;
        var += 2.0 * d * d * flat[i];
    }
    var.max(1e-6)
}

/// Exact initial strength calculation from `BlurFilterPass._calculateInitialStrength()` in `BlurFilterPass.mjs`.
pub fn blur_initial_strength(strength: f32, passes: u32) -> f32 {
    let passes = passes.max(1);
    let mut sum_of_squares = 1.0f32;
    let mut coeff = 0.5f32;
    for _ in 1..passes {
        sum_of_squares += coeff * coeff;
        coeff *= 0.5;
    }
    strength / sum_of_squares.sqrt()
}

pub fn pixi_screen_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrc,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

pub fn pixi_normal_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

pub fn pixi_add_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

pub fn live2d_multiplicative_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Dst,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

pub fn live2d_additive_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

pub fn live2d_mask_setup_blend() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::OneMinusSrc,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

const FILTER_WG_XY: u32 = 16;
const YUV_DISPATCH_X: u32 = 256;
const YUV_WG_SIZE: u32 = 64;
const SCALED_PYRAMID_MIN_WIDTH: u32 = 1024;

/// Compute-shader filter and YUV420p packing pipelines used when `Rgba8Unorm` storage writes are supported.
pub struct ComputeFilterPipelines {
    pub cs_dst_bgl: wgpu::BindGroupLayout,
    pub cs_orig_bgl: wgpu::BindGroupLayout,
    pub yuv_pack_bgl: wgpu::BindGroupLayout,
    pub post_chain_bgl: wgpu::BindGroupLayout,
    pub fused_aux_bgl: wgpu::BindGroupLayout,
    pub alpha: wgpu::ComputePipeline,
    pub adjustment: wgpu::ComputePipeline,
    pub color_overlay: wgpu::ComputePipeline,
    pub blur: wgpu::ComputePipeline,
    pub blur_screen: wgpu::ComputePipeline,
    pub downsample_2x: wgpu::ComputePipeline,
    pub downsample_4x: wgpu::ComputePipeline,
    pub upsample: wgpu::ComputePipeline,
    pub bloom_upsample_screen: wgpu::ComputePipeline,
    pub pointwise_light: wgpu::ComputePipeline,
    pub pointwise_chain: wgpu::ComputePipeline,
    pub crt: wgpu::ComputePipeline,
    pub old_film: wgpu::ComputePipeline,
    pub yuv_pack: wgpu::ComputePipeline,
    pub fused_post_yuv_fast_2d: wgpu::ComputePipeline,
    pub fused_post_yuv_light_2d: wgpu::ComputePipeline,
    pub fused_post_yuv_noui_2d: wgpu::ComputePipeline,
    pub fused_post_yuv_2d: wgpu::ComputePipeline,
}

pub struct FilterPipelines {
    pub tex_bgl: wgpu::BindGroupLayout,
    pub uniform_bgl: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub alpha: wgpu::RenderPipeline,
    pub adjustment: wgpu::RenderPipeline,
    pub color_overlay: wgpu::RenderPipeline,
    pub blur_replace: wgpu::RenderPipeline,
    pub blur_screen: wgpu::RenderPipeline,
    pub crt: wgpu::RenderPipeline,
    pub old_film: wgpu::RenderPipeline,
    pub compute: Option<ComputeFilterPipelines>,
}

impl FilterPipelines {
    /// Creates both fragment render-pass filter pipelines and (when supported) `@compute` filter/YUV pipelines.
    pub fn new(device: &wgpu::Device, shader: &wgpu::ShaderModule, enable_compute: bool) -> Self {
        let tex_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("filter_tex_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let uniform_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("filter_uniform_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("filter_pipeline_layout"),
                bind_group_layouts: &[Some(&tex_bgl), Some(&uniform_bgl)],
                immediate_size: 0,
            });

        let sampler: wgpu::Sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("filter_linear_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let make_pipe = |label: &str, fs_entry: &str, blend: wgpu::BlendState| -> wgpu::RenderPipeline {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: shader,
                    entry_point: Some("filter_vs"),
                    compilation_options: wgpu::PipelineCompilationOptions {
                    zero_initialize_workgroup_memory: false,
                    ..Default::default()
                },
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: shader,
                    entry_point: Some(fs_entry),
                    compilation_options: wgpu::PipelineCompilationOptions {
                    zero_initialize_workgroup_memory: false,
                    ..Default::default()
                },
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

        let compute: Option<ComputeFilterPipelines> = if enable_compute {
            Some(Self::build_compute_pipelines(
                device,
                shader,
                &tex_bgl,
                &uniform_bgl,
            ))
        } else {
            None
        };

        Self {
            tex_bgl,
            uniform_bgl,
            sampler,
            alpha: make_pipe("flt_alpha", "filter_alpha_fs", wgpu::BlendState::REPLACE),
            adjustment: make_pipe(
                "flt_adjustment",
                "filter_adjustment_fs",
                wgpu::BlendState::REPLACE,
            ),
            color_overlay: make_pipe(
                "flt_color_overlay",
                "filter_color_overlay_fs",
                wgpu::BlendState::REPLACE,
            ),
            blur_replace: make_pipe("flt_blur_replace", "filter_blur_fs", wgpu::BlendState::REPLACE),
            blur_screen: make_pipe("flt_blur_screen", "filter_blur_fs", pixi_screen_blend()),
            crt: make_pipe("flt_crt", "filter_crt_fs", wgpu::BlendState::REPLACE),
            old_film: make_pipe("flt_old_film", "filter_old_film_fs", wgpu::BlendState::REPLACE),
            compute,
        }
    }

    fn build_compute_pipelines(
        device: &wgpu::Device,
        shader: &wgpu::ShaderModule,
        tex_bgl: &wgpu::BindGroupLayout,
        uniform_bgl: &wgpu::BindGroupLayout,
    ) -> ComputeFilterPipelines {
        let cs_dst_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("filter_cs_dst_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                }],
            });

        let cs_orig_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("filter_cs_orig_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                }],
            });

        let post_chain_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("filter_post_chain_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<PostChainUniformGpu>() as u64,
                        ),
                    },
                    count: None,
                }],
            });

        let cs_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("filter_cs_layout"),
                bind_group_layouts: &[Some(tex_bgl), Some(uniform_bgl), Some(&cs_dst_bgl)],
                immediate_size: 0,
            });
        let cs_screen_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("filter_cs_screen_layout"),
                bind_group_layouts: &[
                    Some(tex_bgl),
                    Some(uniform_bgl),
                    Some(&cs_dst_bgl),
                    Some(&cs_orig_bgl),
                ],
                immediate_size: 0,
            });
        let pointwise_chain_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("filter_pointwise_chain_layout"),
                bind_group_layouts: &[Some(tex_bgl), Some(&post_chain_bgl), Some(&cs_dst_bgl)],
                immediate_size: 0,
            });

        let make_cs = |label: &str,
                       pipe_layout: &wgpu::PipelineLayout,
                       entry: &str|
         -> wgpu::ComputePipeline {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(pipe_layout),
                module: shader,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    zero_initialize_workgroup_memory: false,
                    ..Default::default()
                },
                cache: None,
            })
        };

        let yuv_pack_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("yuv_pack_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                std::mem::size_of::<YuvConvertUniformGpu>() as u64,
                            ),
                        },
                        count: None,
                    },
                ],
            });
        let yuv_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("yuv_pack_layout"),
                bind_group_layouts: &[Some(tex_bgl), Some(&yuv_pack_bgl)],
                immediate_size: 0,
            });
        let fused_aux_bgl: wgpu::BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("fused_yuv_aux_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
            });
        let fused_yuv_layout: wgpu::PipelineLayout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("fused_yuv_2d_layout"),
                bind_group_layouts: &[
                    Some(tex_bgl),
                    Some(&yuv_pack_bgl),
                    Some(&post_chain_bgl),
                    Some(&fused_aux_bgl),
                ],
                immediate_size: 0,
            });

        ComputeFilterPipelines {
            alpha: make_cs("flt_alpha_cs", &cs_layout, "filter_alpha_cs"),
            adjustment: make_cs("flt_adjustment_cs", &cs_layout, "filter_adjustment_cs"),
            color_overlay: make_cs(
                "flt_color_overlay_cs",
                &cs_layout,
                "filter_color_overlay_cs",
            ),
            blur: make_cs("flt_blur_cs", &cs_layout, "filter_blur_cs"),
            blur_screen: make_cs(
                "flt_blur_screen_cs",
                &cs_screen_layout,
                "filter_blur_screen_cs",
            ),
            downsample_2x: make_cs("flt_downsample_2x_cs", &cs_layout, "filter_downsample_2x_cs"),
            downsample_4x: make_cs("flt_downsample_4x_cs", &cs_layout, "filter_downsample_4x_cs"),
            upsample: make_cs("flt_upsample_cs", &cs_layout, "filter_upsample_cs"),
            bloom_upsample_screen: make_cs(
                "flt_bloom_upsample_screen_cs",
                &cs_screen_layout,
                "filter_bloom_upsample_screen_cs",
            ),
            pointwise_light: make_cs(
                "flt_pointwise_light_cs",
                &pointwise_chain_layout,
                "filter_pointwise_light_cs",
            ),
            pointwise_chain: make_cs(
                "flt_pointwise_chain_cs",
                &pointwise_chain_layout,
                "filter_pointwise_chain_cs",
            ),
            crt: make_cs("flt_crt_cs", &cs_layout, "filter_crt_cs"),
            old_film: make_cs("flt_old_film_cs", &cs_layout, "filter_old_film_cs"),
            yuv_pack: make_cs("yuv_pack_cs", &yuv_layout, "rgba_to_yuv420p_bt709_cs"),
            fused_post_yuv_fast_2d: make_cs(
                "fused_post_yuv_fast_2d_cs",
                &fused_yuv_layout,
                "fused_post_yuv_fast_2d_cs",
            ),
            fused_post_yuv_light_2d: make_cs(
                "fused_post_yuv_light_2d_cs",
                &fused_yuv_layout,
                "fused_post_yuv_light_2d_cs",
            ),
            fused_post_yuv_noui_2d: make_cs(
                "fused_post_yuv_noui_2d_cs",
                &fused_yuv_layout,
                "fused_post_yuv_noui_2d_cs",
            ),
            fused_post_yuv_2d: make_cs(
                "fused_post_yuv_2d_cs",
                &fused_yuv_layout,
                "fused_post_yuv_2d_cs",
            ),
            cs_dst_bgl,
            cs_orig_bgl,
            yuv_pack_bgl,
            post_chain_bgl,
            fused_aux_bgl,
        }
    }

    /// Creates an auxiliary bind group (`bloom_tex`, `sampler`, `ui_overlay_tex`) for `fused_post_yuv_2d_cs`.
    pub fn create_fused_aux_bind_group(
        &self,
        device: &wgpu::Device,
        bloom_view: &wgpu::TextureView,
        ui_view: &wgpu::TextureView,
        label: &str,
    ) -> Option<wgpu::BindGroup> {
        let cs: &ComputeFilterPipelines = self.compute.as_ref()?;
        Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &cs.fused_aux_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(bloom_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(ui_view),
                },
            ],
        }))
    }

    /// Creates a compute storage-write bind group targeting a render target pool view.
    pub fn create_cs_dst_bind_group(
        &self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        label: &str,
    ) -> Option<wgpu::BindGroup> {
        let cs: &ComputeFilterPipelines = self.compute.as_ref()?;
        Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &cs.cs_dst_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(view),
            }],
        }))
    }

    /// Creates a compute read-only texture bind group for unblurred Bloom base sampling.
    pub fn create_cs_orig_bind_group(
        &self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        label: &str,
    ) -> Option<wgpu::BindGroup> {
        let cs: &ComputeFilterPipelines = self.compute.as_ref()?;
        Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &cs.cs_orig_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(view),
            }],
        }))
    }

    /// Dispatches the fast 2D macro-tiled fused post-process + BT.709 YUV420p compute pass
    /// (`width % 8 == 0 && height % 2 == 0`), or falls back to the generic 1D YUV kernel.
    #[allow(clippy::too_many_arguments)]
    pub fn encode_fused_yuv420p_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        src_tex_bg: &wgpu::BindGroup,
        yuv_pack_bg: &wgpu::BindGroup,
        bloom_tex_bg: &wgpu::BindGroup,
        chain_scratch: &mut PostChainScratch,
        post_u: &PostChainUniformGpu,
    ) -> bool {
        let Some(cs) = self.compute.as_ref() else {
            return false;
        };
        if post_u.width >= 8 && post_u.height >= 2 && post_u.width % 8 == 0 && post_u.height % 2 == 0
        {
            let dyn_off: u32 = chain_scratch.push(post_u);
            let ops_slice: &[PointwiseOpGpu] =
                &post_u.ops[..(post_u.op_count as usize).min(MAX_FUSED_POINTWISE_OPS)];
            let is_fast_path: bool = post_u.op_count == 0 && post_u.has_bloom_glow == 0;
            let is_light_path: bool = post_u.has_bloom_glow == 0
                && ops_slice.iter().all(|op| matches!(op.kind, 1 | 3 | 6));
            let has_ui_op: bool = ops_slice.iter().any(|op| op.kind == 6);
            let (pipe, wg_x, wg_y): (&wgpu::ComputePipeline, u32, u32) = if is_fast_path {
                (
                    &cs.fused_post_yuv_fast_2d,
                    post_u.width.div_ceil(64).max(1),
                    post_u.height.div_ceil(32).max(1),
                )
            } else if is_light_path {
                (
                    &cs.fused_post_yuv_light_2d,
                    post_u.width.div_ceil(64).max(1),
                    post_u.height.div_ceil(16).max(1),
                )
            } else if !has_ui_op {
                (
                    &cs.fused_post_yuv_noui_2d,
                    post_u.width.div_ceil(64).max(1),
                    post_u.height.div_ceil(16).max(1),
                )
            } else {
                (
                    &cs.fused_post_yuv_2d,
                    post_u.width.div_ceil(64).max(1),
                    post_u.height.div_ceil(16).max(1),
                )
            };
            let mut cpass: wgpu::ComputePass<'_> =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("fused_post_yuv_2d_cs"),
                    timestamp_writes: None,
                });
            cpass.set_pipeline(pipe);
            cpass.set_bind_group(0, src_tex_bg, &[]);
            cpass.set_bind_group(1, yuv_pack_bg, &[]);
            cpass.set_bind_group(2, &chain_scratch.s_bg, &[dyn_off]);
            cpass.set_bind_group(3, bloom_tex_bg, &[]);
            cpass.dispatch_workgroups(wg_x, wg_y, 1);
            return true;
        }
        self.encode_yuv420p_pass(
            encoder,
            src_tex_bg,
            yuv_pack_bg,
            post_u.y_words,
            post_u.uv_words,
        )
    }

    /// Dispatches the generic GPU RGBA8 -> BT.709 limited-range planar YUV420p 1D fallback compute pass.
    pub fn encode_yuv420p_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        src_tex_bg: &wgpu::BindGroup,
        yuv_pack_bg: &wgpu::BindGroup,
        y_words: u32,
        uv_words: u32,
    ) -> bool {
        let Some(cs) = self.compute.as_ref() else {
            return false;
        };
        let total_items: u32 = y_words.saturating_add(uv_words);
        let workgroups_total: u32 = total_items.div_ceil(YUV_WG_SIZE).max(1);
        let wg_x: u32 = workgroups_total.min(YUV_DISPATCH_X);
        let wg_y: u32 = workgroups_total.div_ceil(YUV_DISPATCH_X);
        let mut cpass: wgpu::ComputePass<'_> =
            encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("rgba_to_yuv420p_cs"),
                timestamp_writes: None,
            });
        cpass.set_pipeline(&cs.yuv_pack);
        cpass.set_bind_group(0, src_tex_bg, &[]);
        cpass.set_bind_group(1, yuv_pack_bg, &[]);
        cpass.dispatch_workgroups(wg_x, wg_y, 1);
        true
    }

    /// Creates a reusable sampled-texture bind group for a render target pool view.
    pub fn create_tex_bind_group(
        &self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        label: &str,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }

    /// Returns the upper bound on single-pass filter invocations required by `filters`.
    pub fn estimate_passes(filters: &[GpuFilterSpec]) -> usize {
        let mut total: usize = 0;
        for spec in filters {
            total += match spec {
                GpuFilterSpec::Blur(p) => (p.quality.max(1) as usize) * 2 + 1,
                GpuFilterSpec::Bloom(p) => (p.quality.max(1) as usize) * 2 + 1,
                _ => 1,
            };
        }
        total
    }
}

#[derive(Clone, Copy)]
enum FilterKind {
    Alpha,
    Adjustment,
    ColorOverlay,
    BlurReplace,
    BlurScreen,
    Crt,
    OldFilm,
}

enum DispatchBackend<'enc, 'res> {
    Compute {
        cpass: wgpu::ComputePass<'enc>,
        cs: &'res ComputeFilterPipelines,
        cs_dst_bgs: &'res [wgpu::BindGroup],
        cs_orig_bgs: &'res [wgpu::BindGroup],
        half_pool: Option<&'res ScaledPoolLevel<'res>>,
        quarter_pool: Option<&'res ScaledPoolLevel<'res>>,
    },
    Render {
        encoder: &'enc mut wgpu::CommandEncoder,
        views: &'res [wgpu::TextureView],
    },
}

impl<'enc, 'res> DispatchBackend<'enc, 'res> {
    fn is_compute(&self) -> bool {
        matches!(self, Self::Compute { .. })
    }
}

pub fn has_effective_filters(filters: &[GpuFilterSpec]) -> bool {
    filters.iter().any(|spec| match spec {
        GpuFilterSpec::Alpha(alpha) => (*alpha - 1.0).abs() > 1e-6,
        GpuFilterSpec::Blur(p) => p.strength.abs() > 1e-6,
        _ => true,
    })
}

/// Output of running `apply_chain_advanced`, optionally deferring trailing pointwise ops
/// and/or a trailing scaled Bloom glow into `fused_post_yuv_2d_cs`.
pub struct FilterChainOutput {
    pub slot: usize,
    pub deferred_bloom: Option<DeferredBloomGlow>,
    pub trailing_pointwise_start: usize,
}

fn full_blur_uniform(
    weights: [[f32; 4]; 4],
    texel_size: [f32; 2],
    strength: f32,
    horizontal: bool,
    kernel_size: i32,
    width: u32,
    height: u32,
) -> BlurUniformGpu {
    let w: f32 = width.max(1) as f32;
    let h: f32 = height.max(1) as f32;
    BlurUniformGpu {
        weights,
        texel_size,
        strength,
        horizontal: u32::from(horizontal),
        kernel_size,
        dst_offset_x: 0,
        dst_offset_y: 0,
        dispatch_w: width,
        dispatch_h: height,
        _pad0: 0,
        uv_min: [0.0, 0.0],
        uv_max: [1.0, 1.0],
        src_origin: [0.0, 0.0],
        src_scale: [1.0 / w, 1.0 / h],
        _pad1: [0; 2],
    }
}

impl FilterPipelines {
    /// Runs a sequence of `GpuFilterSpec` filters across the entire `(width, height)` frame.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_chain(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        tex_bgs: &[wgpu::BindGroup],
        cs_dst_bgs: &[wgpu::BindGroup],
        cs_orig_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        scratch_start: usize,
        width: u32,
        height: u32,
        region: FilterRegion,
        filters: &[GpuFilterSpec],
        force_render: bool,
    ) -> usize {
        if !has_effective_filters(filters) {
            return input_slot;
        }
        let mut backend: DispatchBackend<'_, '_> = if !force_render {
            if let Some(cs) = self.compute.as_ref() {
                if !cs_dst_bgs.is_empty() && !cs_orig_bgs.is_empty() {
                    let cpass: wgpu::ComputePass<'_> =
                        encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                            label: Some("filter_compute_pass"),
                            timestamp_writes: None,
                        });
                    DispatchBackend::Compute {
                        cpass,
                        cs,
                        cs_dst_bgs,
                        cs_orig_bgs,
                        half_pool: None,
                        quarter_pool: None,
                    }
                } else {
                    DispatchBackend::Render { encoder, views }
                }
            } else {
                DispatchBackend::Render { encoder, views }
            }
        } else {
            DispatchBackend::Render { encoder, views }
        };

        let mut current: usize = input_slot;
        let slot_a: usize = scratch_start;
        let slot_b: usize = scratch_start + 1;
        let slot_aux_x: usize = scratch_start + 2;
        let slot_swap0: usize = scratch_start + 3;
        let slot_swap1: usize = scratch_start + 4;

        for spec in filters {
            if let GpuFilterSpec::Alpha(alpha) = spec {
                if (*alpha - 1.0).abs() <= 1e-6 {
                    continue;
                }
            }
            let next: usize = if current == slot_a { slot_b } else { slot_a };
            match spec {
                GpuFilterSpec::Alpha(alpha) => {
                    let u: AlphaFilterUniformGpu = AlphaFilterUniformGpu {
                        alpha: *alpha,
                        _pad: [0.0; 3],
                    };
                    self.dispatch_step(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        FilterKind::Alpha,
                        current,
                        next,
                        None,
                        bytemuck::bytes_of(&u),
                        width,
                        height,
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Adjustment(p) => {
                    let u: AdjustmentUniformGpu = AdjustmentUniformGpu {
                        color: p.color,
                        gamma: p.gamma,
                        contrast: p.contrast,
                        saturation: p.saturation,
                        brightness: p.brightness,
                    };
                    self.dispatch_step(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        FilterKind::Adjustment,
                        current,
                        next,
                        None,
                        bytemuck::bytes_of(&u),
                        width,
                        height,
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::ColorOverlay(p) => {
                    let u: ColorOverlayUniformGpu = ColorOverlayUniformGpu {
                        color: p.color,
                        alpha: p.alpha,
                    };
                    self.dispatch_step(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        FilterKind::ColorOverlay,
                        current,
                        next,
                        None,
                        bytemuck::bytes_of(&u),
                        width,
                        height,
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Crt(p) => {
                    let u: CrtUniformGpu = CrtUniformGpu {
                        u_line: [
                            p.curvature,
                            p.line_width,
                            p.line_contrast,
                            if p.vertical_line { 1.0 } else { 0.0 },
                        ],
                        u_noise: [p.noise, p.noise_size],
                        u_dimensions: [width as f32, height as f32],
                        u_vignette: [p.vignetting, p.vignetting_alpha, p.vignetting_blur],
                        u_seed: p.seed,
                        u_time: p.time,
                        _pad: [0.0; 3],
                    };
                    self.dispatch_step(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        FilterKind::Crt,
                        current,
                        next,
                        None,
                        bytemuck::bytes_of(&u),
                        width,
                        height,
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::OldFilm(p) => {
                    let u: OldFilmUniformGpu = OldFilmUniformGpu {
                        u_scratch: [p.scratch, p.scratch_density, p.scratch_width],
                        u_sepia: p.sepia,
                        u_vignetting: [p.vignetting, p.vignetting_alpha, p.vignetting_blur],
                        u_seed: p.seed,
                        u_noise: [p.noise, p.noise_size],
                        u_dimensions: [width as f32, height as f32],
                    };
                    self.dispatch_step(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        FilterKind::OldFilm,
                        current,
                        next,
                        None,
                        bytemuck::bytes_of(&u),
                        width,
                        height,
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Blur(p) => {
                    if p.strength.abs() <= 1e-6 {
                        continue;
                    }
                    self.apply_blur_region(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        current,
                        next,
                        slot_aux_x,
                        slot_swap0,
                        slot_swap1,
                        width,
                        height,
                        region,
                        p,
                        false,
                    );
                    current = next;
                }
                GpuFilterSpec::Bloom(p) => {
                    self.apply_bloom_region(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        current,
                        next,
                        slot_aux_x,
                        slot_swap0,
                        slot_swap1,
                        width,
                        height,
                        region,
                        p,
                        false,
                    );
                    current = next;
                }
            }
        }
        current
    }

    /// Optimized filter chain supporting region clipping, contiguous pointwise op fusion,
    /// Half/Quarter resolution Blur/Bloom pyramids, and optional deferral of trailing Bloom+Pointwise
    /// into `fused_post_yuv_2d_cs`.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_chain_advanced(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        tex_bgs: &[wgpu::BindGroup],
        cs_dst_bgs: &[wgpu::BindGroup],
        cs_orig_bgs: &[wgpu::BindGroup],
        half_pool: Option<&ScaledPoolLevel<'_>>,
        quarter_pool: Option<&ScaledPoolLevel<'_>>,
        scratch: &mut FilterUniformScratch,
        chain_scratch: &mut PostChainScratch,
        input_slot: usize,
        scratch_start: usize,
        stage_width: u32,
        stage_height: u32,
        region: FilterRegion,
        filters: &[GpuFilterSpec],
        allow_defer_trailing: bool,
        force_render: bool,
    ) -> FilterChainOutput {
        self.apply_chain_advanced_with_offset(
            encoder,
            views,
            tex_bgs,
            cs_dst_bgs,
            cs_orig_bgs,
            half_pool,
            quarter_pool,
            scratch,
            chain_scratch,
            input_slot,
            scratch_start,
            stage_width,
            stage_height,
            region,
            [0.0, 0.0],
            filters,
            allow_defer_trailing,
            None,
            force_render,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_chain_advanced_with_offset(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        tex_bgs: &[wgpu::BindGroup],
        cs_dst_bgs: &[wgpu::BindGroup],
        cs_orig_bgs: &[wgpu::BindGroup],
        half_pool: Option<&ScaledPoolLevel<'_>>,
        quarter_pool: Option<&ScaledPoolLevel<'_>>,
        scratch: &mut FilterUniformScratch,
        chain_scratch: &mut PostChainScratch,
        input_slot: usize,
        scratch_start: usize,
        stage_width: u32,
        stage_height: u32,
        region: FilterRegion,
        uv_px_offset: [f32; 2],
        filters: &[GpuFilterSpec],
        allow_defer_trailing: bool,
        preferred_out_slot: Option<usize>,
        force_render: bool,
    ) -> FilterChainOutput {
        if force_render || self.compute.is_none() || cs_dst_bgs.is_empty() || cs_orig_bgs.is_empty() {
            let slot: usize = self.apply_chain(
                encoder,
                views,
                tex_bgs,
                cs_dst_bgs,
                cs_orig_bgs,
                scratch,
                input_slot,
                scratch_start,
                stage_width,
                stage_height,
                region,
                filters,
                force_render,
            );
            return FilterChainOutput {
                slot,
                deferred_bloom: None,
                trailing_pointwise_start: filters.len(),
            };
        }

        if !has_effective_filters(filters) {
            return FilterChainOutput {
                slot: input_slot,
                deferred_bloom: None,
                trailing_pointwise_start: filters.len(),
            };
        }

        // Identify maximal trailing slice `[trailing_start..filters.len()]` that can run in
        // `fused_post_yuv_2d_cs` when `allow_defer_trailing` is enabled:
        // up to 8 pointwise ops, optionally preceded by one scaled Bloom glow.
        let (exec_end, trailing_scaled_idx, trailing_pw_start): (usize, Option<usize>, usize) =
            if allow_defer_trailing && region.is_full(stage_width, stage_height) {
                let mut pw_start: usize = filters.len();
                let mut pw_count: usize = 0;
                while pw_start > 0
                    && is_pointwise_filter(&filters[pw_start - 1])
                    && pw_count < MAX_FUSED_POINTWISE_OPS
                {
                    pw_start -= 1;
                    if !matches!(filters[pw_start], GpuFilterSpec::Alpha(a) if (a - 1.0).abs() <= 1e-6)
                    {
                        pw_count += 1;
                    }
                }
                if pw_start > 0 && stage_width >= SCALED_PYRAMID_MIN_WIDTH {
                    let prev_i: usize = pw_start - 1;
                    match &filters[prev_i] {
                        GpuFilterSpec::Bloom(p)
                            if quarter_pool.is_some()
                                && p.strength_x.abs().max(p.strength_y.abs()) >= 0.5 =>
                        {
                            (prev_i, Some(prev_i), pw_start)
                        }
                        GpuFilterSpec::Blur(p)
                            if (p.strength.abs() >= 0.5 && quarter_pool.is_some())
                                || (p.strength.abs() > 1e-6 && half_pool.is_some()) =>
                        {
                            (prev_i, Some(prev_i), pw_start)
                        }
                        _ => (pw_start, None, pw_start),
                    }
                } else {
                    (pw_start, None, pw_start)
                }
            } else {
                (filters.len(), None, filters.len())
            };

        let cs: &ComputeFilterPipelines = self.compute.as_ref().expect("checked compute");
        let mut backend: DispatchBackend<'_, '_> = DispatchBackend::Compute {
            cpass: encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("filter_compute_pass"),
                timestamp_writes: None,
            }),
            cs,
            cs_dst_bgs,
            cs_orig_bgs,
            half_pool,
            quarter_pool,
        };

        let mut current: usize = input_slot;
        let slot_a: usize = scratch_start;
        let slot_b: usize = scratch_start + 1;
        let slot_aux_x: usize = scratch_start + 2;
        let slot_swap0: usize = scratch_start + 3;
        let slot_swap1: usize = scratch_start + 4;

        let mut idx: usize = 0;
        while idx < exec_end {
            if is_pointwise_filter(&filters[idx]) {
                let mut ops: [PointwiseOpGpu; MAX_FUSED_POINTWISE_OPS] = Default::default();
                let mut op_count: usize = 0;
                while idx < exec_end
                    && is_pointwise_filter(&filters[idx])
                    && op_count < MAX_FUSED_POINTWISE_OPS
                {
                    if let GpuFilterSpec::Alpha(a) = filters[idx] {
                        if (a - 1.0).abs() <= 1e-6 {
                            idx += 1;
                            continue;
                        }
                    }
                    if let Some(encoded) =
                        encode_pointwise_op(&filters[idx], stage_width, stage_height)
                    {
                        ops[op_count] = encoded;
                        op_count += 1;
                    }
                    idx += 1;
                }
                if op_count > 0 {
                    let default_next: usize = if current == slot_a { slot_b } else { slot_a };
                    let next: usize = if idx >= exec_end {
                        preferred_out_slot
                            .filter(|&dst| dst != current && dst < cs_dst_bgs.len())
                            .unwrap_or(default_next)
                    } else {
                        default_next
                    };
                    let skip_transparent: u32 = ops_preserve_transparent(&ops, op_count);
                    let post_u: PostChainUniformGpu = PostChainUniformGpu {
                        width: stage_width,
                        height: stage_height,
                        y_words: 0,
                        uv_words: 0,
                        dst_offset_x: region.x,
                        dst_offset_y: region.y,
                        dispatch_w: region.w,
                        dispatch_h: region.h,
                        op_count: op_count as u32,
                        apply_backdrop: 0,
                        has_bloom_glow: 0,
                        skip_transparent,
                        backdrop_clear: [0.0; 4],
                        fade_color_premul: [0.0; 4],
                        bloom_uv_scale: [0.0; 2],
                        bloom_uv_max: [1.0; 2],
                        stage_inv_dims: [
                            1.0 / stage_width.max(1) as f32,
                            1.0 / stage_height.max(1) as f32,
                        ],
                        uv_px_offset,
                        fade_alpha: 0.0,
                        _pad_tail: [0; 3],
                        ops,
                    };
                    let dyn_off: u32 = chain_scratch.push(&post_u);
                    let is_light: bool = ops[..op_count].iter().all(|o| o.kind <= 3);
                    if let DispatchBackend::Compute {
                        cpass,
                        cs,
                        cs_dst_bgs,
                        ..
                    } = &mut backend
                    {
                        cpass.set_pipeline(if is_light {
                            &cs.pointwise_light
                        } else {
                            &cs.pointwise_chain
                        });
                        cpass.set_bind_group(0, &tex_bgs[current], &[]);
                        cpass.set_bind_group(1, &chain_scratch.s_bg, &[dyn_off]);
                        cpass.set_bind_group(2, &cs_dst_bgs[next], &[]);
                        cpass.dispatch_workgroups(
                            region.w.div_ceil(FILTER_WG_XY * 4).max(1),
                            region.h.div_ceil(FILTER_WG_XY).max(1),
                            1,
                        );
                    }
                    current = next;
                }
                continue;
            }

            let next: usize = if current == slot_a { slot_b } else { slot_a };
            match &filters[idx] {
                GpuFilterSpec::Blur(p) => {
                    if p.strength.abs() > 1e-6 {
                        let _ = self.apply_blur_region(
                            &mut backend,
                            tex_bgs,
                            scratch,
                            current,
                            next,
                            slot_aux_x,
                            slot_swap0,
                            slot_swap1,
                            stage_width,
                            stage_height,
                            region,
                            p,
                            false,
                        );
                        current = next;
                    }
                }
                GpuFilterSpec::Bloom(p) => {
                    let _ = self.apply_bloom_region(
                        &mut backend,
                        tex_bgs,
                        scratch,
                        current,
                        next,
                        slot_aux_x,
                        slot_swap0,
                        slot_swap1,
                        stage_width,
                        stage_height,
                        region,
                        p,
                        false,
                    );
                    current = next;
                }
                _ => {}
            }
            idx += 1;
        }

        let deferred_bloom: Option<DeferredBloomGlow> = trailing_scaled_idx.and_then(|s_idx| {
            match &filters[s_idx] {
                GpuFilterSpec::Bloom(p) => self.apply_bloom_region(
                    &mut backend,
                    tex_bgs,
                    scratch,
                    current,
                    current,
                    slot_aux_x,
                    slot_swap0,
                    slot_swap1,
                    stage_width,
                    stage_height,
                    region,
                    p,
                    true,
                ),
                GpuFilterSpec::Blur(p) => self.apply_blur_region(
                    &mut backend,
                    tex_bgs,
                    scratch,
                    current,
                    current,
                    slot_aux_x,
                    slot_swap0,
                    slot_swap1,
                    stage_width,
                    stage_height,
                    region,
                    p,
                    true,
                ),
                _ => None,
            }
        });

        FilterChainOutput {
            slot: current,
            deferred_bloom,
            trailing_pointwise_start: trailing_pw_start,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_blur_region(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        stage_width: u32,
        stage_height: u32,
        region: FilterRegion,
        p: &BlurFilterParams,
        defer_upsample: bool,
    ) -> Option<DeferredBloomGlow> {
        let abs_s: f32 = p.strength.abs();
        let scaled: Option<(&ScaledPoolLevel<'_>, bool)> = match backend {
            DispatchBackend::Compute {
                half_pool,
                quarter_pool,
                ..
            } if stage_width >= SCALED_PYRAMID_MIN_WIDTH && abs_s > 1e-6 => {
                if abs_s >= 0.5 {
                    quarter_pool.map(|q| (q, true))
                } else {
                    half_pool.map(|h| (h, false))
                }
            }
            _ => None,
        };

        if let Some((sp, is_quarter)) = scaled {
            if self.run_scaled_blur(
                backend,
                tex_bgs,
                scratch,
                sp,
                input_slot,
                stage_width,
                stage_height,
                region,
                p.strength,
                p.strength,
                p.quality,
                p.kernel_size,
            ) {
                let s: f32 = sp.scale_factor as f32;
                let dst_w: u32 = region.w.div_ceil(sp.scale_factor).min(sp.width).max(1);
                let dst_h: u32 = region.h.div_ceil(sp.scale_factor).min(sp.height).max(1);
                let uv_scale: [f32; 2] =
                    [1.0 / (s * sp.width as f32), 1.0 / (s * sp.height as f32)];
                let uv_max: [f32; 2] = [
                    (dst_w as f32 - 0.5).max(0.5) / sp.width as f32,
                    (dst_h as f32 - 0.5).max(0.5) / sp.height as f32,
                ];
                if defer_upsample {
                    return Some(DeferredBloomGlow {
                        mode: 2,
                        use_quarter: is_quarter,
                        scaled_slot: 2,
                        uv_scale,
                        uv_max,
                    });
                }
                let up_u: BlurUniformGpu = BlurUniformGpu {
                    weights: [[0.0; 4]; 4],
                    texel_size: [1.0 / stage_width.max(1) as f32, 1.0 / stage_height.max(1) as f32],
                    strength: 0.0,
                    horizontal: 0,
                    kernel_size: 0,
                    dst_offset_x: region.x,
                    dst_offset_y: region.y,
                    dispatch_w: region.w,
                    dispatch_h: region.h,
                    _pad0: 0,
                    uv_min: [0.5 / sp.width as f32, 0.5 / sp.height as f32],
                    uv_max,
                    src_origin: [0.0, 0.0],
                    src_scale: uv_scale,
                    _pad1: [0; 2],
                };
                self.dispatch_scaled_or_upsample(
                    backend,
                    &sp.filter_bgs[2],
                    output_slot,
                    None,
                    scratch,
                    &up_u,
                    region.w,
                    region.h,
                    ScaledOpKind::Upsample,
                );
                return None;
            }
        }

        self.run_blur_axis(
            backend,
            tex_bgs,
            scratch,
            input_slot,
            aux_x,
            swap0,
            swap1,
            stage_width,
            stage_height,
            region,
            p.strength,
            p.quality,
            p.kernel_size,
            true,
            None,
        );
        self.run_blur_axis(
            backend,
            tex_bgs,
            scratch,
            aux_x,
            output_slot,
            swap0,
            swap1,
            stage_width,
            stage_height,
            region,
            p.strength,
            p.quality,
            p.kernel_size,
            false,
            None,
        );
        None
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_bloom_region(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        stage_width: u32,
        stage_height: u32,
        region: FilterRegion,
        p: &BloomFilterParams,
        defer_upsample: bool,
    ) -> Option<DeferredBloomGlow> {
        let strength_max: f32 = p.strength_x.abs().max(p.strength_y.abs());
        let scaled: Option<(&ScaledPoolLevel<'_>, bool)> = match backend {
            DispatchBackend::Compute {
                quarter_pool,
                half_pool,
                ..
            } if stage_width >= SCALED_PYRAMID_MIN_WIDTH && strength_max >= 0.5 => {
                if let Some(q) = *quarter_pool {
                    Some((q, true))
                } else {
                    half_pool.map(|h| (h, false))
                }
            }
            _ => None,
        };

        if let Some((sp, is_quarter)) = scaled {
            if self.run_scaled_blur(
                backend,
                tex_bgs,
                scratch,
                sp,
                input_slot,
                stage_width,
                stage_height,
                region,
                p.strength_x,
                p.strength_y,
                p.quality,
                p.kernel_size,
            ) {
                let s: f32 = sp.scale_factor as f32;
                let dst_w: u32 = region.w.div_ceil(sp.scale_factor).min(sp.width).max(1);
                let dst_h: u32 = region.h.div_ceil(sp.scale_factor).min(sp.height).max(1);
                let uv_scale: [f32; 2] =
                    [1.0 / (s * sp.width as f32), 1.0 / (s * sp.height as f32)];
                let uv_max: [f32; 2] = [
                    (dst_w as f32 - 0.5).max(0.5) / sp.width as f32,
                    (dst_h as f32 - 0.5).max(0.5) / sp.height as f32,
                ];
                if defer_upsample {
                    return Some(DeferredBloomGlow {
                        mode: 1,
                        use_quarter: is_quarter,
                        scaled_slot: 2,
                        uv_scale,
                        uv_max,
                    });
                }
                let up_u: BlurUniformGpu = BlurUniformGpu {
                    weights: [[0.0; 4]; 4],
                    texel_size: [1.0 / stage_width.max(1) as f32, 1.0 / stage_height.max(1) as f32],
                    strength: 0.0,
                    horizontal: 0,
                    kernel_size: 0,
                    dst_offset_x: region.x,
                    dst_offset_y: region.y,
                    dispatch_w: region.w,
                    dispatch_h: region.h,
                    _pad0: 0,
                    uv_min: [0.5 / sp.width as f32, 0.5 / sp.height as f32],
                    uv_max,
                    src_origin: [0.0, 0.0],
                    src_scale: uv_scale,
                    _pad1: [0; 2],
                };
                self.dispatch_scaled_or_upsample(
                    backend,
                    &sp.filter_bgs[2],
                    output_slot,
                    Some(input_slot),
                    scratch,
                    &up_u,
                    region.w,
                    region.h,
                    ScaledOpKind::BloomUpsampleScreen,
                );
                return None;
            }
        }

        if !backend.is_compute() {
            let u: AlphaFilterUniformGpu = AlphaFilterUniformGpu {
                alpha: 1.0,
                _pad: [0.0; 3],
            };
            self.dispatch_step(
                backend,
                tex_bgs,
                scratch,
                FilterKind::Alpha,
                input_slot,
                output_slot,
                None,
                bytemuck::bytes_of(&u),
                stage_width,
                stage_height,
                true,
            );
        }
        self.run_blur_axis(
            backend,
            tex_bgs,
            scratch,
            input_slot,
            aux_x,
            swap0,
            swap1,
            stage_width,
            stage_height,
            region,
            p.strength_x,
            p.quality,
            p.kernel_size,
            true,
            None,
        );
        self.run_blur_axis(
            backend,
            tex_bgs,
            scratch,
            aux_x,
            output_slot,
            swap0,
            swap1,
            stage_width,
            stage_height,
            region,
            p.strength_y,
            p.quality,
            p.kernel_size,
            false,
            Some(input_slot),
        );
        None
    }

    /// Downsamples `input_slot[region]` into `sp[0]`, executes separable H passes ending in `sp[1]`
    /// and V passes ending in `sp[2]`.
    #[allow(clippy::too_many_arguments)]
    fn run_scaled_blur(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        sp: &ScaledPoolLevel<'_>,
        input_slot: usize,
        stage_width: u32,
        stage_height: u32,
        region: FilterRegion,
        strength_x: f32,
        strength_y: f32,
        quality: u32,
        kernel_size: u32,
    ) -> bool {
        let DispatchBackend::Compute { cpass, cs, .. } = backend else {
            return false;
        };
        if sp.scale_factor != 2 && sp.scale_factor != 4 {
            return false;
        }
        let s_u32: u32 = sp.scale_factor;
        let dst_w: u32 = region.w.div_ceil(s_u32).min(sp.width).max(1);
        let dst_h: u32 = region.h.div_ceil(s_u32).min(sp.height).max(1);
        let fw: f32 = stage_width.max(1) as f32;
        let fh: f32 = stage_height.max(1) as f32;
        let s: f32 = s_u32 as f32;

        // 1. Downsample `input_slot` region -> `sp[0]`.
        let down_u: BlurUniformGpu = BlurUniformGpu {
            weights: [[0.0; 4]; 4],
            texel_size: [1.0 / fw, 1.0 / fh],
            strength: 0.0,
            horizontal: 0,
            kernel_size: 0,
            dst_offset_x: 0,
            dst_offset_y: 0,
            dispatch_w: dst_w,
            dispatch_h: dst_h,
            _pad0: 0,
            uv_min: [(region.x as f32 + 0.5) / fw, (region.y as f32 + 0.5) / fh],
            uv_max: [
                ((region.x + region.w) as f32 - 0.5).max(0.5) / fw,
                ((region.y + region.h) as f32 - 0.5).max(0.5) / fh,
            ],
            src_origin: [region.x as f32 / fw, region.y as f32 / fh],
            src_scale: [s / fw, s / fh],
            _pad1: [0; 2],
        };
        let wg_x: u32 = dst_w.div_ceil(FILTER_WG_XY).max(1);
        let wg_y: u32 = dst_h.div_ceil(FILTER_WG_XY).max(1);
        let down_off: u32 = scratch.push_uniform(bytemuck::bytes_of(&down_u));
        cpass.set_pipeline(if s_u32 == 4 {
            &cs.downsample_4x
        } else {
            &cs.downsample_2x
        });
        cpass.set_bind_group(0, &tex_bgs[input_slot], &[]);
        cpass.set_bind_group(1, &scratch.u_bg, &[down_off]);
        cpass.set_bind_group(2, &sp.cs_dst_bgs[0], &[]);
        cpass.dispatch_workgroups(wg_x, wg_y, 1);

        // 2. Run 1 H + 1 V separable pass over `[0..dst_w, 0..dst_h]` (`sp[0] -> sp[1] -> sp[2]`).
        // Collapsing multi-pass Pixi blur (`quality >= 2`) into a variance-matched single pass cuts
        // 4-8x compute barriers while keeping identical Gaussian sigma.
        let eff_kernel: u32 = if quality > 1 && kernel_size < 9 {
            9
        } else {
            kernel_size
        };
        let sigma_scale: f32 = if eff_kernel != kernel_size {
            (gaussian_kernel_variance(kernel_size) / gaussian_kernel_variance(eff_kernel)).sqrt()
        } else {
            1.0
        };
        let (k, weights): (i32, [[f32; 4]; 4]) = gaussian_half_kernel(eff_kernel);
        let pool_w: f32 = sp.width as f32;
        let pool_h: f32 = sp.height as f32;
        let scaled_texel: [f32; 2] = [1.0 / (pool_w * s), 1.0 / (pool_h * s)];
        let pool_uv_min: [f32; 2] = [0.5 / pool_w, 0.5 / pool_h];
        let pool_uv_max: [f32; 2] = [
            (dst_w as f32 - 0.5).max(0.5) / pool_w,
            (dst_h as f32 - 0.5).max(0.5) / pool_h,
        ];
        let pool_scale: [f32; 2] = [1.0 / pool_w, 1.0 / pool_h];

        cpass.set_pipeline(&cs.blur);
        for &(src_idx, dst_idx, horizontal, strength) in &[
            (0usize, 1usize, 1u32, strength_x * sigma_scale),
            (1usize, 2usize, 0u32, strength_y * sigma_scale),
        ] {
            let u: BlurUniformGpu = BlurUniformGpu {
                weights,
                texel_size: scaled_texel,
                strength,
                horizontal,
                kernel_size: k,
                dst_offset_x: 0,
                dst_offset_y: 0,
                dispatch_w: dst_w,
                dispatch_h: dst_h,
                _pad0: 0,
                uv_min: pool_uv_min,
                uv_max: pool_uv_max,
                src_origin: [0.0, 0.0],
                src_scale: pool_scale,
                _pad1: [0; 2],
            };
            let off: u32 = scratch.push_uniform(bytemuck::bytes_of(&u));
            cpass.set_bind_group(0, &sp.filter_bgs[src_idx], &[]);
            cpass.set_bind_group(1, &scratch.u_bg, &[off]);
            cpass.set_bind_group(2, &sp.cs_dst_bgs[dst_idx], &[]);
            cpass.dispatch_workgroups(wg_x, wg_y, 1);
        }

        true
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_scaled_or_upsample(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        src_tex_bg: &wgpu::BindGroup,
        output_slot: usize,
        bloom_orig_slot: Option<usize>,
        scratch: &mut FilterUniformScratch,
        u: &BlurUniformGpu,
        dispatch_w: u32,
        dispatch_h: u32,
        op: ScaledOpKind,
    ) {
        let DispatchBackend::Compute {
            cpass,
            cs,
            cs_dst_bgs,
            cs_orig_bgs,
            ..
        } = backend
        else {
            return;
        };
        let off: u32 = scratch.push_uniform(bytemuck::bytes_of(u));
        match op {
            ScaledOpKind::Upsample => {
                cpass.set_pipeline(&cs.upsample);
                cpass.set_bind_group(0, src_tex_bg, &[]);
                cpass.set_bind_group(1, &scratch.u_bg, &[off]);
                cpass.set_bind_group(2, &cs_dst_bgs[output_slot], &[]);
            }
            ScaledOpKind::BloomUpsampleScreen => {
                cpass.set_pipeline(&cs.bloom_upsample_screen);
                cpass.set_bind_group(0, src_tex_bg, &[]);
                cpass.set_bind_group(1, &scratch.u_bg, &[off]);
                cpass.set_bind_group(2, &cs_dst_bgs[output_slot], &[]);
                if let Some(orig) = bloom_orig_slot {
                    cpass.set_bind_group(3, &cs_orig_bgs[orig], &[]);
                }
            }
        }
        cpass.dispatch_workgroups(
            dispatch_w.div_ceil(FILTER_WG_XY).max(1),
            dispatch_h.div_ceil(FILTER_WG_XY).max(1),
            1,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn run_blur_axis(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        output_slot: usize,
        swap0: usize,
        swap1: usize,
        width: u32,
        height: u32,
        region: FilterRegion,
        strength: f32,
        quality: u32,
        kernel_size: u32,
        horizontal: bool,
        bloom_orig_slot: Option<usize>,
    ) {
        let passes: u32 = quality.max(1);
        let (k, weights): (i32, [[f32; 4]; 4]) = gaussian_half_kernel(kernel_size);
        let mut cur_strength: f32 = blur_initial_strength(strength, passes);
        let fw: f32 = width.max(1) as f32;
        let fh: f32 = height.max(1) as f32;
        let texel_size: [f32; 2] = [1.0 / fw, 1.0 / fh];
        let is_full: bool = region.is_full(width, height);

        let mut flip: usize = input_slot;
        for pass_idx in 0..passes {
            let is_last: bool = pass_idx + 1 == passes;
            let dst_slot: usize = if is_last {
                output_slot
            } else if pass_idx % 2 == 0 {
                swap0
            } else {
                swap1
            };
            let is_screen: bool = is_last && bloom_orig_slot.is_some();
            let (kind, clear, orig_slot): (FilterKind, bool, Option<usize>) = if is_screen {
                (FilterKind::BlurScreen, false, bloom_orig_slot)
            } else {
                (FilterKind::BlurReplace, true, None)
            };
            let u: BlurUniformGpu = if is_full {
                full_blur_uniform(
                    weights,
                    texel_size,
                    cur_strength,
                    horizontal,
                    k,
                    width,
                    height,
                )
            } else {
                BlurUniformGpu {
                    weights,
                    texel_size,
                    strength: cur_strength,
                    horizontal: u32::from(horizontal),
                    kernel_size: k,
                    dst_offset_x: region.x,
                    dst_offset_y: region.y,
                    dispatch_w: region.w,
                    dispatch_h: region.h,
                    _pad0: 0,
                    uv_min: [(region.x as f32 + 0.5) / fw, (region.y as f32 + 0.5) / fh],
                    uv_max: [
                        ((region.x + region.w) as f32 - 0.5).max(0.5) / fw,
                        ((region.y + region.h) as f32 - 0.5).max(0.5) / fh,
                    ],
                    src_origin: [region.x as f32 / fw, region.y as f32 / fh],
                    src_scale: texel_size,
                    _pad1: [0; 2],
                }
            };
            let (disp_w, disp_h): (u32, u32) = if backend.is_compute() && !is_full {
                (region.w, region.h)
            } else {
                (width, height)
            };
            self.dispatch_step(
                backend,
                tex_bgs,
                scratch,
                kind,
                flip,
                dst_slot,
                orig_slot,
                bytemuck::bytes_of(&u),
                disp_w,
                disp_h,
                clear,
            );
            cur_strength *= 0.5;
            flip = dst_slot;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_step(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        kind: FilterKind,
        src_slot: usize,
        dst_slot: usize,
        orig_slot: Option<usize>,
        uniform_bytes: &[u8],
        dispatch_w: u32,
        dispatch_h: u32,
        clear: bool,
    ) {
        let dyn_offset: u32 = scratch.push_uniform(uniform_bytes);
        match backend {
            DispatchBackend::Compute {
                cpass,
                cs,
                cs_dst_bgs,
                cs_orig_bgs,
                ..
            } => {
                let pipe: &wgpu::ComputePipeline = match kind {
                    FilterKind::Alpha => &cs.alpha,
                    FilterKind::Adjustment => &cs.adjustment,
                    FilterKind::ColorOverlay => &cs.color_overlay,
                    FilterKind::BlurReplace => &cs.blur,
                    FilterKind::BlurScreen => &cs.blur_screen,
                    FilterKind::Crt => &cs.crt,
                    FilterKind::OldFilm => &cs.old_film,
                };
                cpass.set_pipeline(pipe);
                cpass.set_bind_group(0, &tex_bgs[src_slot], &[]);
                cpass.set_bind_group(1, &scratch.u_bg, &[dyn_offset]);
                cpass.set_bind_group(2, &cs_dst_bgs[dst_slot], &[]);
                if matches!(kind, FilterKind::BlurScreen) {
                    let orig_idx: usize = orig_slot.unwrap_or(src_slot);
                    cpass.set_bind_group(3, &cs_orig_bgs[orig_idx], &[]);
                }
                cpass.dispatch_workgroups(
                    dispatch_w.max(1).div_ceil(FILTER_WG_XY),
                    dispatch_h.max(1).div_ceil(FILTER_WG_XY),
                    1,
                );
            }
            DispatchBackend::Render { encoder, views } => {
                let pipe: &wgpu::RenderPipeline = match kind {
                    FilterKind::Alpha => &self.alpha,
                    FilterKind::Adjustment => &self.adjustment,
                    FilterKind::ColorOverlay => &self.color_overlay,
                    FilterKind::BlurReplace => &self.blur_replace,
                    FilterKind::BlurScreen => &self.blur_screen,
                    FilterKind::Crt => &self.crt,
                    FilterKind::OldFilm => &self.old_film,
                };
                let load: wgpu::LoadOp<wgpu::Color> = if clear {
                    wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                } else {
                    wgpu::LoadOp::Load
                };
                let mut rpass: wgpu::RenderPass<'_> =
                    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("filter_pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &views[dst_slot],
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
                rpass.set_pipeline(pipe);
                rpass.set_bind_group(0, &tex_bgs[src_slot], &[]);
                rpass.set_bind_group(1, &scratch.u_bg, &[dyn_offset]);
                rpass.draw(0..3, 0..1);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ScaledOpKind {
    Upsample,
    BloomUpsampleScreen,
}

/// Persistent per-frame uniform buffer + dynamic-offset bind group for `FilterPipelines`.
pub struct FilterUniformScratch {
    ubuf: wgpu::Buffer,
    u_bg: wgpu::BindGroup,
    uniform_stride: usize,
    capacity_slots: usize,
    cpu_bytes: Vec<u8>,
}

impl FilterUniformScratch {
    const MIN_BIND_BYTES: u64 = std::mem::size_of::<BlurUniformGpu>() as u64;

    /// Allocates a filter uniform buffer holding `initial_slots` aligned uniform entries.
    pub fn new(
        device: &wgpu::Device,
        filters: &FilterPipelines,
        uniform_stride: usize,
        initial_slots: usize,
    ) -> Self {
        let slots: usize = initial_slots.max(1);
        let byte_len: u64 = (slots * uniform_stride) as u64;
        let ubuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("filter_scratch_ubuf"),
            size: byte_len,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let u_bg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("filter_scratch_u_bg"),
            layout: &filters.uniform_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &ubuf,
                    offset: 0,
                    size: wgpu::BufferSize::new(Self::MIN_BIND_BYTES),
                }),
            }],
        });
        Self {
            ubuf,
            u_bg,
            uniform_stride,
            capacity_slots: slots,
            cpu_bytes: Vec::with_capacity(slots * uniform_stride),
        }
    }

    /// Clears staged uniform bytes and grows the GPU backing buffer if `required_slots` exceeds capacity.
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        filters: &FilterPipelines,
        required_slots: usize,
    ) {
        self.cpu_bytes.clear();
        if required_slots > self.capacity_slots {
            let new_slots: usize = required_slots.next_power_of_two().max(self.capacity_slots * 2);
            self.ubuf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("filter_scratch_ubuf"),
                size: (new_slots * self.uniform_stride) as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.u_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("filter_scratch_u_bg"),
                layout: &filters.uniform_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.ubuf,
                        offset: 0,
                        size: wgpu::BufferSize::new(Self::MIN_BIND_BYTES),
                    }),
                }],
            });
            self.capacity_slots = new_slots;
        }
    }

    fn push_uniform(&mut self, bytes: &[u8]) -> u32 {
        let offset: usize = self.cpu_bytes.len();
        self.cpu_bytes.resize(offset + self.uniform_stride, 0);
        let copy_len: usize = bytes.len().min(self.uniform_stride);
        self.cpu_bytes[offset..offset + copy_len].copy_from_slice(&bytes[..copy_len]);
        offset as u32
    }

    /// Uploads all staged filter uniforms for the current frame in a single queue write.
    pub fn flush(&self, queue: &wgpu::Queue) {
        if !self.cpu_bytes.is_empty() {
            queue.write_buffer(&self.ubuf, 0, &self.cpu_bytes);
        }
    }
}

/// Persistent per-frame dynamic-offset storage scratch for fused `PostChainUniformGpu` dispatches.
pub struct PostChainScratch {
    sbuf: wgpu::Buffer,
    pub(crate) s_bg: wgpu::BindGroup,
    stride: usize,
    capacity_slots: usize,
    cpu_bytes: Vec<u8>,
}

impl PostChainScratch {
    const MIN_BIND_BYTES: u64 = std::mem::size_of::<PostChainUniformGpu>() as u64;

    /// Allocates a storage scratch buffer holding `initial_slots` `PostChainUniformGpu` entries.
    pub fn new(
        device: &wgpu::Device,
        filters: &FilterPipelines,
        storage_align: usize,
        initial_slots: usize,
    ) -> Option<Self> {
        let cs: &ComputeFilterPipelines = filters.compute.as_ref()?;
        let align: usize = storage_align.max(256);
        let entry_bytes: usize = std::mem::size_of::<PostChainUniformGpu>();
        let stride: usize = entry_bytes.div_ceil(align) * align;
        let slots: usize = initial_slots.max(4);
        let sbuf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("post_chain_scratch_sbuf"),
            size: (slots * stride) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let s_bg: wgpu::BindGroup = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post_chain_scratch_s_bg"),
            layout: &cs.post_chain_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &sbuf,
                    offset: 0,
                    size: wgpu::BufferSize::new(Self::MIN_BIND_BYTES),
                }),
            }],
        });
        Some(Self {
            sbuf,
            s_bg,
            stride,
            capacity_slots: slots,
            cpu_bytes: Vec::with_capacity(slots * stride),
        })
    }

    pub fn prepare(&mut self, device: &wgpu::Device, filters: &FilterPipelines, required_slots: usize) {
        self.cpu_bytes.clear();
        if required_slots > self.capacity_slots {
            if let Some(cs) = filters.compute.as_ref() {
                let new_slots: usize = required_slots.next_power_of_two().max(self.capacity_slots * 2);
                self.sbuf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("post_chain_scratch_sbuf"),
                    size: (new_slots * self.stride) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.s_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("post_chain_scratch_s_bg"),
                    layout: &cs.post_chain_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.sbuf,
                            offset: 0,
                            size: wgpu::BufferSize::new(Self::MIN_BIND_BYTES),
                        }),
                    }],
                });
                self.capacity_slots = new_slots;
            }
        }
    }

    pub(crate) fn push(&mut self, post_u: &PostChainUniformGpu) -> u32 {
        let offset: usize = self.cpu_bytes.len();
        self.cpu_bytes.resize(offset + self.stride, 0);
        let bytes: &[u8] = bytemuck::bytes_of(post_u);
        self.cpu_bytes[offset..offset + bytes.len()].copy_from_slice(bytes);
        offset as u32
    }

    pub fn flush(&self, queue: &wgpu::Queue) {
        if !self.cpu_bytes.is_empty() {
            queue.write_buffer(&self.sbuf, 0, &self.cpu_bytes);
        }
    }
}
