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
}

impl FilterPipelines {
    pub fn new(device: &wgpu::Device, shader: &wgpu::ShaderModule) -> Self {
        let tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("filter_tex_bgl"),
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

        let uniform_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("filter_uniform_bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("filter_pipeline_layout"),
            bind_group_layouts: &[Some(&tex_bgl), Some(&uniform_bgl)],
            immediate_size: 0,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("filter_linear_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let make_pipe = |label: &str, fs_entry: &str, blend: wgpu::BlendState| {
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
        }
    }

    /// Runs a sequence of `GpuFilterSpec` filters across an offscreen ping-pong pool of `(view, tex)` slots.
    /// `pool` must contain at least 4 `Rgba8Unorm` textures of size `(width, height)`.
    /// Returns the pool index holding the final filtered output (which may be `input_slot` if empty).
    pub fn apply_chain<'a>(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        input_slot: usize,
        scratch_start: usize,
        width: u32,
        height: u32,
        filters: &[GpuFilterSpec],
    ) -> usize {
        if filters.is_empty() {
            return input_slot;
        }
        let mut current = input_slot;
        let slot_a = scratch_start;
        let slot_b = scratch_start + 1;
        let slot_aux_x = scratch_start + 2;
        let slot_swap0 = scratch_start + 3;
        let slot_swap1 = scratch_start + 4;

        for spec in filters {
            let next = if current == slot_a { slot_b } else { slot_a };
            match spec {
                GpuFilterSpec::Alpha(alpha) => {
                    let u = AlphaFilterUniformGpu {
                        alpha: *alpha,
                        _pad: [0.0; 3],
                    };
                    self.run_single_pass(
                        device,
                        queue,
                        encoder,
                        &self.alpha,
                        &views[current],
                        &views[next],
                        bytemuck::bytes_of(&u),
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Adjustment(p) => {
                    let u = AdjustmentUniformGpu {
                        color: p.color,
                        gamma: p.gamma,
                        contrast: p.contrast,
                        saturation: p.saturation,
                        brightness: p.brightness,
                    };
                    self.run_single_pass(
                        device,
                        queue,
                        encoder,
                        &self.adjustment,
                        &views[current],
                        &views[next],
                        bytemuck::bytes_of(&u),
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::ColorOverlay(p) => {
                    let u = ColorOverlayUniformGpu {
                        color: p.color,
                        alpha: p.alpha,
                    };
                    self.run_single_pass(
                        device,
                        queue,
                        encoder,
                        &self.color_overlay,
                        &views[current],
                        &views[next],
                        bytemuck::bytes_of(&u),
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Crt(p) => {
                    let u = CrtUniformGpu {
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
                    self.run_single_pass(
                        device,
                        queue,
                        encoder,
                        &self.crt,
                        &views[current],
                        &views[next],
                        bytemuck::bytes_of(&u),
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::OldFilm(p) => {
                    let u = OldFilmUniformGpu {
                        u_scratch: [p.scratch, p.scratch_density, p.scratch_width],
                        u_sepia: p.sepia,
                        u_vignetting: [p.vignetting, p.vignetting_alpha, p.vignetting_blur],
                        u_seed: p.seed,
                        u_noise: [p.noise, p.noise_size],
                        u_dimensions: [width as f32, height as f32],
                    };
                    self.run_single_pass(
                        device,
                        queue,
                        encoder,
                        &self.old_film,
                        &views[current],
                        &views[next],
                        bytemuck::bytes_of(&u),
                        true,
                    );
                    current = next;
                }
                GpuFilterSpec::Blur(p) => {
                    self.apply_blur(
                        device,
                        queue,
                        encoder,
                        views,
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
                        device,
                        queue,
                        encoder,
                        views,
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
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        width: u32,
        height: u32,
        p: &BlurFilterParams,
    ) {
        if p.strength.abs() <= 1e-6 {
            let u = AlphaFilterUniformGpu {
                alpha: 1.0,
                _pad: [0.0; 3],
            };
            self.run_single_pass(
                device,
                queue,
                encoder,
                &self.alpha,
                &views[input_slot],
                &views[output_slot],
                bytemuck::bytes_of(&u),
                true,
            );
            return;
        }
        self.run_blur_axis(
            device,
            queue,
            encoder,
            views,
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
            false,
        );
        self.run_blur_axis(
            device,
            queue,
            encoder,
            views,
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
            false,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_bloom(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
        input_slot: usize,
        output_slot: usize,
        aux_x: usize,
        swap0: usize,
        swap1: usize,
        width: u32,
        height: u32,
        p: &BloomFilterParams,
    ) {
        // Step 1: Copy original `input` into `output` (`BloomFilter extends AlphaFilter(1)`).
        let u = AlphaFilterUniformGpu {
            alpha: 1.0,
            _pad: [0.0; 3],
        };
        self.run_single_pass(
            device,
            queue,
            encoder,
            &self.alpha,
            &views[input_slot],
            &views[output_slot],
            bytemuck::bytes_of(&u),
            true,
        );
        // Step 2: Horizontal blur `input -> aux_x`.
        self.run_blur_axis(
            device,
            queue,
            encoder,
            views,
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
            false,
        );
        // Step 3: Vertical blur `aux_x -> output` with Screen blend mode without clearing `output`.
        self.run_blur_axis(
            device,
            queue,
            encoder,
            views,
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
            true,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn run_blur_axis(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        views: &[wgpu::TextureView],
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
        final_screen_blend: bool,
    ) {
        let passes = quality.max(1);
        let (k, weights) = gaussian_half_kernel(kernel_size);
        let mut cur_strength = blur_initial_strength(strength, passes);
        let texel_size = [1.0 / width.max(1) as f32, 1.0 / height.max(1) as f32];

        let mut flip = input_slot;
        for pass_idx in 0..passes {
            let is_last = pass_idx + 1 == passes;
            let dst_slot = if is_last {
                output_slot
            } else if pass_idx % 2 == 0 {
                swap0
            } else {
                swap1
            };
            let (pipe, clear) = if is_last && final_screen_blend {
                (&self.blur_screen, false)
            } else {
                (&self.blur_replace, true)
            };
            let u = BlurUniformGpu {
                weights,
                texel_size,
                strength: cur_strength,
                horizontal: if horizontal { 1 } else { 0 },
                kernel_size: k,
                _pad: [0; 3],
            };
            self.run_single_pass(
                device,
                queue,
                encoder,
                pipe,
                &views[flip],
                &views[dst_slot],
                bytemuck::bytes_of(&u),
                clear,
            );
            cur_strength *= 0.5;
            flip = dst_slot;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_single_pass(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        src_view: &wgpu::TextureView,
        dst_view: &wgpu::TextureView,
        uniform_bytes: &[u8],
        clear: bool,
    ) {
        let tex_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("filter_tex_bg"),
            layout: &self.tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let ubuf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("filter_ubuf"),
            size: uniform_bytes.len() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&ubuf, 0, uniform_bytes);
        let u_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("filter_u_bg"),
            layout: &self.uniform_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: ubuf.as_entire_binding(),
            }],
        });

        let load = if clear {
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
        } else {
            wgpu::LoadOp::Load
        };
        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("filter_pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst_view,
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
        rpass.set_pipeline(pipeline);
        rpass.set_bind_group(0, &tex_bg, &[]);
        rpass.set_bind_group(1, &u_bg, &[]);
        rpass.draw(0..3, 0..1);
    }
}
