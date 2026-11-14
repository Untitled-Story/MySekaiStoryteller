use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::HashMap;
use std::f32::consts::PI;

use super::error::RendererError;
use super::story::{parse_hex_color, EffectTargetData, VisualEffectData};

pub const LAYOUT_HOLOGRAM_EFFECT_PREFIX: &str = "__layout_hologram__:";

#[derive(Debug, Clone, PartialEq)]
pub struct AdjustmentFilterParams {
    pub gamma: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub brightness: f32,
    pub color: [f32; 4], // [red, green, blue, alpha]
}

impl Default for AdjustmentFilterParams {
    fn default() -> Self {
        Self {
            gamma: 1.0,
            contrast: 1.0,
            saturation: 1.0,
            brightness: 1.0,
            color: [1.0, 1.0, 1.0, 1.0],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlurFilterParams {
    pub strength: f32,
    pub quality: u32,
    pub kernel_size: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColorOverlayFilterParams {
    pub color: [f32; 3],
    pub alpha: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrtFilterParams {
    pub curvature: f32,
    pub line_width: f32,
    pub line_contrast: f32,
    pub vertical_line: bool,
    pub noise: f32,
    pub noise_size: f32,
    pub vignetting: f32,
    pub vignetting_alpha: f32,
    pub vignetting_blur: f32,
    pub time: f32,
    pub seed: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OldFilmFilterParams {
    pub sepia: f32,
    pub noise: f32,
    pub noise_size: f32,
    pub scratch: f32,
    pub scratch_density: f32,
    pub scratch_width: f32,
    pub vignetting: f32,
    pub vignetting_alpha: f32,
    pub vignetting_blur: f32,
    pub seed: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BloomFilterParams {
    pub strength_x: f32,
    pub strength_y: f32,
    pub quality: u32,
    pub kernel_size: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GpuFilterSpec {
    Alpha(f32),
    Adjustment(AdjustmentFilterParams),
    Blur(BlurFilterParams),
    ColorOverlay(ColorOverlayFilterParams),
    Crt(CrtFilterParams),
    OldFilm(OldFilmFilterParams),
    Bloom(BloomFilterParams),
}

#[derive(Debug, Clone)]
pub struct TriangleParticle {
    /// Position in Live2D model-canvas coordinates (`0..originalWidth`, `0..originalHeight`).
    pub x: f32,
    pub y: f32,
    pub color_rgb: [f32; 3],
    pub size: f32,
    pub velocity_x: f32,
    pub velocity_y: f32,
    pub rotation: f32,
    pub rotation_speed: f32,
    pub age: f32,
    pub lifespan: f32,
    pub fade_duration: f32,
    pub filled: bool,
    pub alpha: f32,
}

impl TriangleParticle {
    fn update(&mut self, delta_ticks: f32) -> bool {
        self.x += self.velocity_x * delta_ticks;
        self.y += self.velocity_y * delta_ticks;
        self.rotation += self.rotation_speed * delta_ticks;
        self.age += delta_ticks / 60.0;

        if self.age < self.fade_duration {
            self.alpha = (self.age / self.fade_duration).clamp(0.0, 1.0);
        } else {
            let remaining = (self.lifespan - self.fade_duration).max(1e-6);
            let elapsed = self.age - self.fade_duration;
            self.alpha = (1.0 - elapsed / remaining).clamp(0.0, 1.0);
        }

        self.age >= self.lifespan
    }
}

#[derive(Debug, Clone)]
pub struct HologramBeamRenderData {
    pub large_scale: f32,
    pub large_alpha: f32,
    pub small_scale: f32,
    pub small_alpha: f32,
    pub filters: Vec<GpuFilterSpec>,
}

#[derive(Debug, Clone)]
struct HologramBeamState {
    elapsed_ticks: f32,
    crt_time: f32,
    crt_seed: f32,
    animating: bool,
    cycle_elapsed_ms: f64,
    start_scale: f32,
    large_scale: f32,
    large_alpha: f32,
    small_scale: f32,
    small_alpha: f32,
    swap_parity: bool,
    rng: ChaCha8Rng,
}

impl HologramBeamState {
    const SCALE_LARGE: f32 = 0.9;
    const SCALE_SMALL: f32 = 0.8;
    const MAX_ALPHA: f32 = 0.5;
    const CYCLE_MS: f64 = 5000.0;

    fn new(seed: u64) -> Self {
        Self {
            elapsed_ticks: 0.0,
            crt_time: 0.0,
            crt_seed: 0.0,
            animating: false,
            cycle_elapsed_ms: 0.0,
            start_scale: Self::SCALE_SMALL,
            large_scale: Self::SCALE_LARGE,
            large_alpha: Self::MAX_ALPHA,
            small_scale: Self::SCALE_SMALL,
            small_alpha: 0.0,
            swap_parity: false,
            rng: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    fn update(&mut self, delta_ms: f64) {
        let delta_ticks = (delta_ms * 60.0 / 1000.0) as f32;
        self.elapsed_ticks += delta_ticks;
        self.crt_time += delta_ticks * 0.01;
        self.crt_seed = self.rng.random();

        if !self.animating {
            self.animating = true;
            self.cycle_elapsed_ms = 0.0;
            self.start_scale = self.small_scale;
            return;
        }

        self.cycle_elapsed_ms += delta_ms;
        let progress = (self.cycle_elapsed_ms / Self::CYCLE_MS).clamp(0.0, 1.0) as f32;
        let eased = 0.5 - 0.5 * (PI * progress).cos();
        self.small_scale = self.start_scale + (Self::SCALE_LARGE - self.start_scale) * eased;

        let fade_in = eased * Self::MAX_ALPHA;
        let fade_out = (1.0 - eased) * Self::MAX_ALPHA;
        let total = fade_in + fade_out;
        let normalize = if total > 1.5 { 1.5 / total } else { 1.0 };
        self.small_alpha = fade_in * normalize;
        self.large_alpha = fade_out * normalize;

        if self.cycle_elapsed_ms >= Self::CYCLE_MS {
            self.swap_parity = !self.swap_parity;
            std::mem::swap(&mut self.large_scale, &mut self.small_scale);
            std::mem::swap(&mut self.large_alpha, &mut self.small_alpha);
            self.small_scale = Self::SCALE_SMALL;
            self.small_alpha = 0.0;
            self.large_alpha = Self::MAX_ALPHA;
            self.animating = false;
            self.cycle_elapsed_ms = 0.0;
        }
    }

    fn to_render_data(&self) -> HologramBeamRenderData {
        let brightness = 1.2 + 0.25 * (self.elapsed_ticks * 0.05).sin();
        HologramBeamRenderData {
            large_scale: self.large_scale,
            large_alpha: self.large_alpha,
            small_scale: self.small_scale,
            small_alpha: self.small_alpha,
            filters: vec![
                GpuFilterSpec::Crt(CrtFilterParams {
                    curvature: 1.0,
                    line_width: 8.0,
                    line_contrast: 0.03,
                    vertical_line: false,
                    noise: 0.0,
                    noise_size: 1.0,
                    vignetting: 0.0,
                    vignetting_alpha: 1.0,
                    vignetting_blur: 0.3,
                    time: self.crt_time,
                    seed: self.crt_seed,
                }),
                GpuFilterSpec::Adjustment(AdjustmentFilterParams {
                    brightness,
                    color: [0.75, 1.0, 1.0, 0.85],
                    ..Default::default()
                }),
                GpuFilterSpec::Bloom(BloomFilterParams {
                    strength_x: 15.0,
                    strength_y: 15.0,
                    quality: 4,
                    kernel_size: 5,
                }),
            ],
        }
    }
}

#[derive(Debug, Clone)]
struct TriangleParticleState {
    particles: Vec<TriangleParticle>,
    elapsed_ms: f64,
    last_spawn_time_ms: f64,
    model_canvas_width: f32,
    model_canvas_height: f32,
    rng: ChaCha8Rng,
}

impl TriangleParticleState {
    const MAX_PARTICLES: usize = 15;
    const SPAWN_INTERVAL_MS: f64 = 250.0;
    const COLORS: [[f32; 3]; 3] = [[1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0]];

    fn new(model_canvas_width: f32, model_canvas_height: f32, seed: u64) -> Self {
        Self {
            particles: Vec::new(),
            elapsed_ms: 0.0,
            last_spawn_time_ms: 0.0,
            model_canvas_width,
            model_canvas_height,
            rng: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    fn update(&mut self, delta_ms: f64) {
        let delta_ticks = (delta_ms * 60.0 / 1000.0) as f32;
        self.elapsed_ms += delta_ms;
        if self.elapsed_ms - self.last_spawn_time_ms > Self::SPAWN_INTERVAL_MS {
            self.spawn_particle();
            self.last_spawn_time_ms = self.elapsed_ms;
        }

        let mut i = self.particles.len();
        while i > 0 {
            i -= 1;
            if self.particles[i].update(delta_ticks) {
                self.particles.remove(i);
            }
        }
    }

    fn spawn_particle(&mut self) {
        if self.particles.len() >= Self::MAX_PARTICLES {
            return;
        }
        let r_x: f32 = self.rng.random();
        let r_y: f32 = self.rng.random();
        let r_col: f32 = self.rng.random();
        let r_size: f32 = self.rng.random();
        let r_vx: f32 = self.rng.random();
        let r_vy: f32 = self.rng.random();
        let r_rot: f32 = self.rng.random();
        let r_rot_dir: f32 = self.rng.random();
        let r_life: f32 = self.rng.random();
        let r_fill: f32 = self.rng.random();
        let r_init_rot: f32 = self.rng.random();

        let color_idx = ((r_col * Self::COLORS.len() as f32).floor() as usize)
            .min(Self::COLORS.len() - 1);
        let rot_dir = if r_rot_dir > 0.5 { 1.0 } else { -1.0 };

        self.particles.push(TriangleParticle {
            x: self.model_canvas_width * (0.1 + r_x * 0.8),
            y: self.model_canvas_height * (0.25 + r_y * 0.5),
            color_rgb: Self::COLORS[color_idx],
            size: 100.0 + r_size * 100.0,
            velocity_x: -0.8 + r_vx * 1.6,
            velocity_y: -0.8 + r_vy * 1.6,
            rotation: r_init_rot * std::f32::consts::TAU,
            rotation_speed: (0.01 + r_rot * 0.03) * rot_dir,
            age: 0.0,
            lifespan: 5.0 + r_life * 5.0,
            fade_duration: 0.5,
            filled: r_fill > 0.5,
            alpha: 0.0,
        });
    }
}

#[derive(Debug, Clone)]
enum EffectKindState {
    Grayscale {
        intensity: f32,
    },
    Blur {
        strength: f32,
        quality: u32,
        kernel_size: u32,
    },
    OldFilm {
        sepia: f32,
        noise: f32,
        noise_size: f32,
        scratch: f32,
        scratch_density: f32,
        scratch_width: f32,
        vignetting: f32,
        vignetting_alpha: f32,
        vignetting_blur: f32,
        seed: f32,
        rng: ChaCha8Rng,
    },
    Crt {
        curvature: f32,
        line_width: f32,
        line_contrast: f32,
        vertical_line: bool,
        noise: f32,
        noise_size: f32,
        vignetting: f32,
        vignetting_alpha: f32,
        vignetting_blur: f32,
        time: f32,
        seed: f32,
        rng: ChaCha8Rng,
    },
    ColorOverlay {
        color: [f32; 3],
        alpha: f32,
    },
    Hologram {
        crt_time: f32,
        crt_seed: f32,
        rng: ChaCha8Rng,
        beam: HologramBeamState,
        particles: TriangleParticleState,
    },
    TriangleParticles(TriangleParticleState),
}

#[derive(Debug, Clone)]
struct ActiveVisualEffect {
    effect_id: String,
    target: EffectTargetData,
    progress: f32,
    state: EffectKindState,
}

/// Manages all runtime visual effects matching `StoryVisualEffectManager` + builtin effects.
#[derive(Debug)]
pub struct VisualEffectManager {
    effects: Vec<ActiveVisualEffect>,
    effect_indices: HashMap<String, usize>,
    base_seed: u64,
    apply_counter: u64,
}

impl VisualEffectManager {
    pub fn new(base_seed: u64) -> Self {
        Self {
            effects: Vec::new(),
            effect_indices: HashMap::new(),
            base_seed,
            apply_counter: 0,
        }
    }

    pub fn has_effect(&self, effect_id: &str) -> bool {
        self.effect_indices.contains_key(effect_id)
    }

    pub fn apply(
        &mut self,
        effect_id: &str,
        target: &EffectTargetData,
        effect: &VisualEffectData,
        model_canvas_size: Option<(f32, f32)>,
    ) -> Result<(), RendererError> {
        self.remove(effect_id);
        self.apply_counter = self.apply_counter.wrapping_add(1);
        let sub_seed = mix_seed(self.base_seed, effect_id, self.apply_counter);

        let is_model_target = matches!(target, EffectTargetData::Model { .. });
        let state = match effect {
            VisualEffectData::Grayscale { intensity } => EffectKindState::Grayscale {
                intensity: *intensity,
            },
            VisualEffectData::Blur {
                strength,
                quality,
                kernel_size,
            } => EffectKindState::Blur {
                strength: *strength,
                quality: *quality,
                kernel_size: *kernel_size,
            },
            VisualEffectData::OldFilm {
                sepia,
                noise,
                noise_size,
                scratch,
                scratch_density,
                scratch_width,
                vignetting,
                vignetting_alpha,
                vignetting_blur,
            } => EffectKindState::OldFilm {
                sepia: *sepia,
                noise: *noise,
                noise_size: *noise_size,
                scratch: *scratch,
                scratch_density: *scratch_density,
                scratch_width: *scratch_width,
                vignetting: *vignetting,
                vignetting_alpha: *vignetting_alpha,
                vignetting_blur: *vignetting_blur,
                seed: 0.0,
                rng: ChaCha8Rng::seed_from_u64(sub_seed),
            },
            VisualEffectData::Crt {
                curvature,
                line_width,
                line_contrast,
                vertical_line,
                noise,
                noise_size,
                vignetting,
                vignetting_alpha,
                vignetting_blur,
            } => EffectKindState::Crt {
                curvature: *curvature,
                line_width: *line_width,
                line_contrast: *line_contrast,
                vertical_line: *vertical_line,
                noise: *noise,
                noise_size: *noise_size,
                vignetting: *vignetting,
                vignetting_alpha: *vignetting_alpha,
                vignetting_blur: *vignetting_blur,
                time: 0.0,
                seed: 0.0,
                rng: ChaCha8Rng::seed_from_u64(sub_seed),
            },
            VisualEffectData::ColorOverlay { color, alpha } => {
                let rgba = parse_hex_color(color)?;
                EffectKindState::ColorOverlay {
                    color: [rgba[0], rgba[1], rgba[2]],
                    alpha: *alpha,
                }
            }
            VisualEffectData::Hologram => {
                if !is_model_target {
                    return Err(RendererError::InvalidConfig(
                        "VFX Hologram only supports Model target".to_string(),
                    ));
                }
                let (mw, mh) = model_canvas_size.unwrap_or((1000.0, 1000.0));
                EffectKindState::Hologram {
                    crt_time: 0.0,
                    crt_seed: 0.0,
                    rng: ChaCha8Rng::seed_from_u64(sub_seed ^ 0xA11CE),
                    beam: HologramBeamState::new(sub_seed ^ 0xB3A4),
                    particles: TriangleParticleState::new(mw, mh, sub_seed ^ 0x9A87),
                }
            }
            VisualEffectData::TriangleParticles => {
                if !is_model_target {
                    return Err(RendererError::InvalidConfig(
                        "VFX TriangleParticles only supports Model target".to_string(),
                    ));
                }
                let (mw, mh) = model_canvas_size.unwrap_or((1000.0, 1000.0));
                EffectKindState::TriangleParticles(TriangleParticleState::new(mw, mh, sub_seed))
            }
        };

        let idx = self.effects.len();
        self.effects.push(ActiveVisualEffect {
            effect_id: effect_id.to_string(),
            target: target.clone(),
            progress: 0.0,
            state,
        });
        self.effect_indices.insert(effect_id.to_string(), idx);
        Ok(())
    }

    pub fn set_progress(&mut self, effect_id: &str, progress: f32) {
        if let Some(&idx) = self.effect_indices.get(effect_id) {
            self.effects[idx].progress = progress;
        }
    }

    pub fn remove(&mut self, effect_id: &str) {
        if let Some(idx) = self.effect_indices.remove(effect_id) {
            self.effects.remove(idx);
            self.effect_indices.clear();
            for (i, eff) in self.effects.iter().enumerate() {
                self.effect_indices.insert(eff.effect_id.clone(), i);
            }
        }
    }

    pub fn update(&mut self, delta_ms: f64) {
        if delta_ms <= 0.0 {
            return;
        }
        let delta_ticks = (delta_ms * 60.0 / 1000.0) as f32;
        for active in &mut self.effects {
            match &mut active.state {
                EffectKindState::OldFilm { seed, rng, .. } => {
                    *seed = rng.random();
                }
                EffectKindState::Crt {
                    time, seed, rng, ..
                } => {
                    *time += delta_ticks * 0.01;
                    *seed = rng.random();
                }
                EffectKindState::Hologram {
                    crt_time,
                    crt_seed,
                    rng,
                    beam,
                    particles,
                } => {
                    *crt_time += delta_ticks * 0.01;
                    *crt_seed = rng.random();
                    beam.update(delta_ms);
                    particles.update(delta_ms);
                }
                EffectKindState::TriangleParticles(particles) => {
                    particles.update(delta_ms);
                }
                EffectKindState::Grayscale { .. }
                | EffectKindState::Blur { .. }
                | EffectKindState::ColorOverlay { .. } => {}
            }
        }
    }

    /// Collects parent filters attached to `target` in exact Pixi application order.
    pub fn collect_filters_for(&self, target: &EffectTargetData) -> Vec<GpuFilterSpec> {
        let mut out = Vec::new();
        for active in &self.effects {
            if &active.target != target {
                continue;
            }
            let p = active.progress;
            match &active.state {
                EffectKindState::Grayscale { intensity } => {
                    out.push(GpuFilterSpec::Adjustment(AdjustmentFilterParams {
                        saturation: 1.0 - intensity * p,
                        ..Default::default()
                    }));
                }
                EffectKindState::Blur {
                    strength,
                    quality,
                    kernel_size,
                } => {
                    out.push(GpuFilterSpec::Blur(BlurFilterParams {
                        strength: strength * p,
                        quality: *quality,
                        kernel_size: *kernel_size,
                    }));
                }
                EffectKindState::OldFilm {
                    sepia,
                    noise,
                    noise_size,
                    scratch,
                    scratch_density,
                    scratch_width,
                    vignetting,
                    vignetting_alpha,
                    vignetting_blur,
                    seed,
                    ..
                } => {
                    out.push(GpuFilterSpec::OldFilm(OldFilmFilterParams {
                        sepia: sepia * p,
                        noise: noise * p,
                        noise_size: *noise_size,
                        scratch: scratch * p,
                        scratch_density: *scratch_density,
                        scratch_width: *scratch_width,
                        vignetting: *vignetting,
                        vignetting_alpha: vignetting_alpha * p,
                        vignetting_blur: *vignetting_blur,
                        seed: *seed,
                    }));
                }
                EffectKindState::Crt {
                    curvature,
                    line_width,
                    line_contrast,
                    vertical_line,
                    noise,
                    noise_size,
                    vignetting,
                    vignetting_alpha,
                    vignetting_blur,
                    time,
                    seed,
                    ..
                } => {
                    out.push(GpuFilterSpec::Crt(CrtFilterParams {
                        curvature: curvature * p,
                        line_width: *line_width,
                        line_contrast: line_contrast * p,
                        vertical_line: *vertical_line,
                        noise: noise * p,
                        noise_size: *noise_size,
                        vignetting: *vignetting,
                        vignetting_alpha: vignetting_alpha * p,
                        vignetting_blur: *vignetting_blur,
                        time: *time,
                        seed: *seed,
                    }));
                }
                EffectKindState::ColorOverlay { color, alpha } => {
                    out.push(GpuFilterSpec::ColorOverlay(ColorOverlayFilterParams {
                        color: *color,
                        alpha: alpha * p,
                    }));
                }
                EffectKindState::Hologram {
                    crt_time,
                    crt_seed,
                    ..
                } => {
                    // Matches `HologramEffect._parentFilters`:
                    // `[crtFilter, new AdjustmentFilter({ alpha: 0.85, brightness: 1.25, red: 0.75 })]`
                    out.push(GpuFilterSpec::Crt(CrtFilterParams {
                        curvature: 1.0,
                        line_width: 8.0,
                        line_contrast: 0.03,
                        vertical_line: false,
                        noise: 0.0,
                        noise_size: 1.0,
                        vignetting: 0.0,
                        vignetting_alpha: 1.0,
                        vignetting_blur: 0.3,
                        time: *crt_time,
                        seed: *crt_seed,
                    }));
                    out.push(GpuFilterSpec::Adjustment(AdjustmentFilterParams {
                        brightness: 1.25,
                        color: [0.75, 1.0, 1.0, 0.85],
                        ..Default::default()
                    }));
                }
                EffectKindState::TriangleParticles(_) => {}
            }
        }
        out
    }

    pub fn collect_model_particles(&self, model_key: &str) -> Vec<&TriangleParticle> {
        let mut out = Vec::new();
        for active in &self.effects {
            if let EffectTargetData::Model { model } = &active.target {
                if model != model_key {
                    continue;
                }
                match &active.state {
                    EffectKindState::TriangleParticles(st)
                    | EffectKindState::Hologram { particles: st, .. } => {
                        out.extend(st.particles.iter());
                    }
                    _ => {}
                }
            }
        }
        out
    }

    pub fn collect_model_hologram_beams(&self, model_key: &str) -> Vec<HologramBeamRenderData> {
        let mut out = Vec::new();
        for active in &self.effects {
            if let EffectTargetData::Model { model } = &active.target {
                if model != model_key {
                    continue;
                }
                if let EffectKindState::Hologram { beam, .. } = &active.state {
                    out.push(beam.to_render_data());
                }
            }
        }
        out
    }
}

fn mix_seed(base_seed: u64, effect_id: &str, counter: u64) -> u64 {
    let mut hash: u64 = base_seed ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for b in effect_id.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    }
    hash ^ (hash >> 30)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hologram_and_particles_spawn_and_swap_deterministically() {
        let mut mgr = VisualEffectManager::new(12345);
        mgr.apply(
            "holo",
            &EffectTargetData::Model {
                model: "m1".to_string(),
            },
            &VisualEffectData::Hologram,
            Some((1200.0, 1400.0)),
        )
        .expect("apply hologram");

        // Advance 3000ms in 50ms steps (~12 spawns at 250ms intervals, 3s mid-swap).
        for _ in 0..60 {
            mgr.update(50.0);
        }

        let particles = mgr.collect_model_particles("m1");
        assert!(!particles.is_empty());
        assert!(particles.len() <= TriangleParticleState::MAX_PARTICLES);

        let beams = mgr.collect_model_hologram_beams("m1");
        assert_eq!(beams.len(), 1);
        assert!(beams[0].small_alpha > 0.1 && beams[0].large_alpha > 0.1);

        let filters = mgr.collect_filters_for(&EffectTargetData::Model {
            model: "m1".to_string(),
        });
        assert_eq!(filters.len(), 2);
    }
}
