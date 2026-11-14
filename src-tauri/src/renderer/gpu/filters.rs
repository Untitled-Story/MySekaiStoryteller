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
    pub _pad: [i32; 3],
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

/// Compute-shader filter and YUV420p packing pipelines used when `Rgba8Unorm` storage writes are supported.
pub struct ComputeFilterPipelines {
    pub cs_dst_bgl: wgpu::BindGroupLayout,
    pub cs_orig_bgl: wgpu::BindGroupLayout,
    pub yuv_pack_bgl: wgpu::BindGroupLayout,
    pub alpha: wgpu::ComputePipeline,
    pub adjustment: wgpu::ComputePipeline,
    pub color_overlay: wgpu::ComputePipeline,
    pub blur: wgpu::ComputePipeline,
    pub blur_screen: wgpu::ComputePipeline,
    pub crt: wgpu::ComputePipeline,
    pub old_film: wgpu::ComputePipeline,
    pub yuv_pack: wgpu::ComputePipeline,
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
                    compilation_options: Default::default(),
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
                    visibility: wgpu::ShaderStages::COMPUTE,
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
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
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

        let make_cs = |label: &str,
                       pipe_layout: &wgpu::PipelineLayout,
                       entry: &str|
         -> wgpu::ComputePipeline {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(pipe_layout),
                module: shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
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
            crt: make_cs("flt_crt_cs", &cs_layout, "filter_crt_cs"),
            old_film: make_cs("flt_old_film_cs", &cs_layout, "filter_old_film_cs"),
            yuv_pack: make_cs("yuv_pack_cs", &yuv_layout, "rgba_to_yuv420p_bt709_cs"),
            cs_dst_bgl,
            cs_orig_bgl,
            yuv_pack_bgl,
        }
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

    /// Dispatches the GPU RGBA8 -> BT.709 limited-range planar YUV420p compute pass.
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
        wg_x: u32,
        wg_y: u32,
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

fn has_effective_filters(filters: &[GpuFilterSpec]) -> bool {
    filters.iter().any(|spec| match spec {
        GpuFilterSpec::Alpha(alpha) => (*alpha - 1.0).abs() > 1e-6,
        GpuFilterSpec::Blur(p) => p.strength.abs() > 1e-6,
        _ => true,
    })
}

impl FilterPipelines {
    /// Runs a sequence of `GpuFilterSpec` filters across the offscreen ping-pong pool using a single
    /// `ComputePass` when compute storage bindings are available, or RenderPasses as fallback.
    /// Returns the pool index holding the final filtered output.
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
                        wg_x: width.max(1).div_ceil(FILTER_WG_XY),
                        wg_y: height.max(1).div_ceil(FILTER_WG_XY),
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
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Blur(p) => {
                    if p.strength.abs() <= 1e-6 {
                        continue;
                    }
                    self.apply_blur(
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
                        p,
                    );
                    current = next;
                }
                GpuFilterSpec::Bloom(p) => {
                    self.apply_bloom(
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
                        p,
                    );
                    current = next;
                }
            }
        }
        current
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_blur(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        width: u32,
        height: u32,
        p: &BlurFilterParams,
    ) {
        self.run_blur_axis(
            backend,
            tex_bgs,
            scratch,
            input_slot,
            aux_x,
            swap0,
            swap1,
            width,
            height,
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
            width,
            height,
            p.strength,
            p.quality,
            p.kernel_size,
            false,
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_bloom(
        &self,
        backend: &mut DispatchBackend<'_, '_>,
        tex_bgs: &[wgpu::BindGroup],
        scratch: &mut FilterUniformScratch,
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        width: u32,
        height: u32,
        p: &BloomFilterParams,
    ) {
        if !backend.is_compute() {
            // Render-pass fallback relies on hardware Screen blend onto `output_slot`, so seed it first.
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
            width,
            height,
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
            width,
            height,
            p.strength_y,
            p.quality,
            p.kernel_size,
            false,
            Some(input_slot),
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
        strength: f32,
        quality: u32,
        kernel_size: u32,
        horizontal: bool,
        bloom_orig_slot: Option<usize>,
    ) {
        let passes: u32 = quality.max(1);
        let (k, weights): (i32, [[f32; 4]; 4]) = gaussian_half_kernel(kernel_size);
        let mut cur_strength: f32 = blur_initial_strength(strength, passes);
        let texel_size: [f32; 2] = [1.0 / width.max(1) as f32, 1.0 / height.max(1) as f32];

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
            let u: BlurUniformGpu = BlurUniformGpu {
                weights,
                texel_size,
                strength: cur_strength,
                horizontal: u32::from(horizontal),
                kernel_size: k,
                _pad: [0; 3],
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
        clear: bool,
    ) {
        let dyn_offset: u32 = scratch.push_uniform(uniform_bytes);
        match backend {
            DispatchBackend::Compute {
                cpass,
                cs,
                cs_dst_bgs,
                cs_orig_bgs,
                wg_x,
                wg_y,
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
                cpass.dispatch_workgroups(*wg_x, *wg_y, 1);
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
