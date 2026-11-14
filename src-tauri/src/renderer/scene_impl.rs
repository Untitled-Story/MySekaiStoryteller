use std::collections::{HashMap, HashSet};

use super::audio::{decode_audio_file, DecodedAudio, ScheduledVoiceEvent, VOICE_VOLUME};
use super::config::VideoExportConfig;
use super::dispatcher::SceneDriver;
use super::error::RendererError;
use super::gpu::scene_renderer::{
    precompute_background_mips, precompute_model_texture_mips, PrecomputedTextureMips,
};
use super::gpu::{GpuRenderFrameInput, GpuRenderModelInput, GpuSceneRenderer};
use super::live2d::Live2DModelInstance;
use super::story::{
    EffectTargetData, LayoutMode, ModelAsset, PositionData, ProjectRenderInput, Side, SnippetData,
    VisualEffectData,
};
use super::text::StoryTextRenderer;
use super::vfx::{
    GpuFilterSpec, HologramBeamRenderData, TriangleParticle, VisualEffectManager,
    LAYOUT_HOLOGRAM_EFFECT_PREFIX,
};

struct LoadedSceneModel {
    asset: ModelAsset,
    instance: Live2DModelInstance,
}

#[derive(Debug, Clone)]
struct ActiveModelVoice {
    voice_key: String,
    start_ms: f64,
    end_ms: f64,
}

/// Complete offline scene backend driving Live2D models, decoded audio lip-sync,
/// SVG/text overlays, seeded VFX, and headless `wgpu` rendering identically to `src/story/scene.ts`.
pub struct StorySceneState<'a> {
    input: &'a ProjectRenderInput,
    master_seed: u64,
    stage_width: u32,
    stage_height: u32,
    gpu: GpuSceneRenderer,
    text_renderer: StoryTextRenderer,
    vfx: VisualEffectManager,

    layout_mode: LayoutMode,
    background_key: Option<String>,
    loaded_backgrounds: HashSet<String>,

    models: HashMap<String, LoadedSceneModel>,
    model_order: Vec<String>,
    positioned_model_keys: HashSet<String>,

    decoded_voices: HashMap<String, DecodedAudio>,
    active_model_voices: HashMap<String, ActiveModelVoice>,
    scheduled_voices: Vec<ScheduledVoiceEvent>,

    dialogue_visible: bool,
    dialogue_alpha: f32,
    dialogue_speaker: String,
    dialogue_partial_text: String,

    telop_visible: bool,
    telop_text: String,
    telop_alpha: f32,
    telop_x_offset: f32,

    fade_visible: bool,
    fade_color: [f32; 4],
    fade_alpha: f32,
    background_clear: [f32; 4],
}

impl<'a> StorySceneState<'a> {
    pub fn new(
        input: &'a ProjectRenderInput,
        config: &VideoExportConfig,
        master_seed: u64,
    ) -> Result<Self, RendererError> {
        Self::new_with_voices(input, config, master_seed, HashMap::new())
    }

    pub fn new_with_voices(
        input: &'a ProjectRenderInput,
        config: &VideoExportConfig,
        master_seed: u64,
        decoded_voices: HashMap<String, DecodedAudio>,
    ) -> Result<Self, RendererError> {
        let mut preload_model_keys: HashSet<String> = HashSet::new();
        let mut preload_bg_keys: HashSet<String> = HashSet::new();
        collect_story_preload_keys(
            &input.story.snippets,
            &mut preload_model_keys,
            &mut preload_bg_keys,
        );

        let mut model_specs: Vec<(String, ModelAsset, std::path::PathBuf, u64)> =
            Vec::with_capacity(preload_model_keys.len());
        for key in preload_model_keys {
            if let Ok((asset, path)) = input.resolve_model_asset(&key) {
                let seed: u64 = derive_key_seed(master_seed, &key);
                model_specs.push((key, asset.clone(), path, seed));
            }
        }
        let mut bg_specs: Vec<(String, std::path::PathBuf)> =
            Vec::with_capacity(preload_bg_keys.len());
        for key in preload_bg_keys {
            if let Ok(path) = input.resolve_background_path(&key) {
                bg_specs.push((key, path));
            }
        }

        let background_clear = config.resolved_background_rgba()?;
        let mut gpu: Option<GpuSceneRenderer> = None;
        let mut text_renderer: Option<StoryTextRenderer> = None;
        let mut init_err: Option<RendererError> = None;
        let mut preloaded_models: Vec<(
            String,
            ModelAsset,
            Live2DModelInstance,
            Vec<PrecomputedTextureMips>,
        )> = Vec::new();
        let mut preloaded_bgs: Vec<(String, PrecomputedTextureMips)> = Vec::new();

        std::thread::scope(|s| {
            let model_handles: Vec<_> = model_specs
                .into_iter()
                .map(|(key, asset, path, seed)| {
                    s.spawn(
                        move || -> Option<(
                            String,
                            ModelAsset,
                            Live2DModelInstance,
                            Vec<PrecomputedTextureMips>,
                        )> {
                            let instance: Live2DModelInstance =
                                Live2DModelInstance::load(&key, &path, seed).ok()?;
                            let pre_mips: Vec<PrecomputedTextureMips> =
                                precompute_model_texture_mips(&instance);
                            Some((key, asset, instance, pre_mips))
                        },
                    )
                })
                .collect();
            let bg_handles: Vec<_> = bg_specs
                .into_iter()
                .map(|(key, path)| {
                    s.spawn(move || -> Option<(String, PrecomputedTextureMips)> {
                        let pre: PrecomputedTextureMips = precompute_background_mips(&path).ok()?;
                        Some((key, pre))
                    })
                })
                .collect();

            match GpuSceneRenderer::new(config.width, config.height)
                .and_then(|g| Ok((g, StoryTextRenderer::new(&input.font, Some(&input.data_dir))?)))
            {
                Ok((g, t)) => {
                    gpu = Some(g);
                    text_renderer = Some(t);
                }
                Err(e) => {
                    init_err = Some(e);
                }
            }

            for h in model_handles {
                if let Ok(Some(item)) = h.join() {
                    preloaded_models.push(item);
                }
            }
            for h in bg_handles {
                if let Ok(Some(item)) = h.join() {
                    preloaded_bgs.push(item);
                }
            }
        });

        if let Some(e) = init_err {
            return Err(e);
        }
        let mut gpu: GpuSceneRenderer = gpu.expect("gpu initialized");
        let text_renderer: StoryTextRenderer = text_renderer.expect("text initialized");
        let vfx = VisualEffectManager::new(master_seed);

        let mut models: HashMap<String, LoadedSceneModel> =
            HashMap::with_capacity(preloaded_models.len());
        for (key, asset, instance, pre_mips) in preloaded_models {
            gpu.register_live2d_model_precomputed(&key, &instance, &pre_mips);
            models.insert(key, LoadedSceneModel { asset, instance });
        }

        let mut loaded_backgrounds: HashSet<String> = HashSet::with_capacity(preloaded_bgs.len());
        for (key, pre_bg) in preloaded_bgs {
            gpu.register_background_precomputed(&key, &pre_bg);
            loaded_backgrounds.insert(key);
        }

        Ok(Self {
            input,
            master_seed,
            stage_width: config.width,
            stage_height: config.height,
            gpu,
            text_renderer,
            vfx,
            layout_mode: LayoutMode::Normal,
            background_key: None,
            loaded_backgrounds,
            models,
            model_order: Vec::new(),
            positioned_model_keys: HashSet::new(),
            decoded_voices,
            active_model_voices: HashMap::new(),
            scheduled_voices: Vec::new(),
            dialogue_visible: false,
            dialogue_alpha: 0.0,
            dialogue_speaker: String::new(),
            dialogue_partial_text: String::new(),
            telop_visible: false,
            telop_text: String::new(),
            telop_alpha: 0.0,
            telop_x_offset: 0.0,
            fade_visible: false,
            fade_color: [0.0, 0.0, 0.0, 1.0],
            fade_alpha: 0.0,
            background_clear,
        })
    }

    pub fn scheduled_voices(&self) -> &[ScheduledVoiceEvent] {
        &self.scheduled_voices
    }

    pub fn decoded_voices(&self) -> &HashMap<String, DecodedAudio> {
        &self.decoded_voices
    }

    /// Consumes the scene state and returns the collected voice events and decoded voice buffers.
    pub fn into_audio_timeline(self) -> (Vec<ScheduledVoiceEvent>, HashMap<String, DecodedAudio>) {
        (self.scheduled_voices, self.decoded_voices)
    }

    /// Commits zero-dt parameter changes onto attached Live2D meshes and composites the current frame to RGBA8.
    pub fn render_current_frame(&mut self) -> Result<Vec<u8>, RendererError> {
        self.with_prepared_frame(|gpu, text_renderer, frame_input| {
            gpu.render_frame(frame_input, text_renderer)
        })
    }

    /// Submits the current frame onto the active double-buffered GPU slot and, when a previous frame
    /// was in-flight, completes its readback into `prev_rgba_out` (returning `Ok(true)`).
    pub fn submit_and_drain_previous_frame_into(
        &mut self,
        prev_rgba_out: &mut Vec<u8>,
    ) -> Result<bool, RendererError> {
        self.with_prepared_frame(|gpu, text_renderer, frame_input| {
            gpu.submit_and_drain_previous_into(frame_input, text_renderer, prev_rgba_out)
        })
    }

    /// Completes the oldest trailing in-flight GPU frame readback into `rgba_out`.
    pub fn finish_pending_frame_into(
        &mut self,
        rgba_out: &mut Vec<u8>,
    ) -> Result<bool, RendererError> {
        self.gpu.finish_pending_frame_into(rgba_out)
    }

    /// Submits the current frame onto the GPU YUV420p readback ring and drains the oldest
    /// completed frame into `prev_yuv_out` once the ring is full.
    pub fn submit_and_drain_previous_yuv_frame_into(
        &mut self,
        prev_yuv_out: &mut rusty_h264_common::YuvFrame,
    ) -> Result<bool, RendererError> {
        self.with_prepared_frame(|gpu, text_renderer, frame_input| {
            gpu.submit_and_drain_previous_yuv_into(frame_input, text_renderer, prev_yuv_out)
        })
    }

    /// Completes the oldest trailing in-flight GPU YUV420p frame readback into `yuv_out`.
    pub fn finish_pending_yuv_frame_into(
        &mut self,
        yuv_out: &mut rusty_h264_common::YuvFrame,
    ) -> Result<bool, RendererError> {
        self.gpu.finish_pending_yuv_into(yuv_out)
    }

    fn with_prepared_frame<R>(
        &mut self,
        render_fn: impl FnOnce(
            &mut GpuSceneRenderer,
            &mut StoryTextRenderer,
            &GpuRenderFrameInput<'_>,
        ) -> Result<R, RendererError>,
    ) -> Result<R, RendererError> {
        let effective_fade_alpha: f32 = self.fade_alpha * self.fade_color[3];
        let opaque_fade: bool = self.fade_visible && effective_fade_alpha >= 1.0 - 1e-5;
        for key in &self.model_order {
            if let Some(entry) = self.models.get_mut(key) {
                if entry.instance.stage.visible && entry.instance.stage.alpha > 0.0 {
                    entry.instance.commit_simulation_step(!opaque_fade);
                }
            }
        }

        if opaque_fade {
            let empty_input = GpuRenderFrameInput {
                background_key: None,
                models: &[],
                stage_filters: &[],
                screen_filters: &[],
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
                fade_visible: true,
                fade_color: self.fade_color,
                fade_alpha: effective_fade_alpha,
                background_clear: self.background_clear,
            };
            return render_fn(&mut self.gpu, &mut self.text_renderer, &empty_input);
        }

        struct PreparedModel<'m> {
            model: &'m Live2DModelInstance,
            parent_filters: Vec<GpuFilterSpec>,
            particles: Vec<&'m TriangleParticle>,
            hologram_beams: Vec<HologramBeamRenderData>,
        }

        let mut prepared: Vec<PreparedModel<'_>> = Vec::with_capacity(self.model_order.len());
        for key in &self.model_order {
            let Some(entry) = self.models.get(key) else {
                continue;
            };
            let target = EffectTargetData::Model { model: key.clone() };
            let parent_filters = self.vfx.collect_filters_for(&target);
            let particles = self.vfx.collect_model_particles(key);
            let hologram_beams = self.vfx.collect_model_hologram_beams(key);
            prepared.push(PreparedModel {
                model: &entry.instance,
                parent_filters,
                particles,
                hologram_beams,
            });
        }

        let gpu_models: Vec<GpuRenderModelInput<'_>> = prepared
            .iter()
            .map(|p| GpuRenderModelInput {
                model: p.model,
                parent_filters: &p.parent_filters,
                particles: &p.particles,
                hologram_beams: &p.hologram_beams,
            })
            .collect();

        let stage_filters = self.vfx.collect_filters_for(&EffectTargetData::Stage);
        let screen_filters = self.vfx.collect_filters_for(&EffectTargetData::Screen);

        let frame_input = GpuRenderFrameInput {
            background_key: self.background_key.as_deref(),
            models: &gpu_models,
            stage_filters: &stage_filters,
            screen_filters: &screen_filters,
            dialogue_visible: self.dialogue_visible,
            dialogue_bg_alpha: self.dialogue_alpha,
            dialogue_underline_alpha: self.dialogue_alpha,
            dialogue_body_text: &self.dialogue_partial_text,
            dialogue_body_alpha: self.dialogue_alpha,
            dialogue_speaker_text: &self.dialogue_speaker,
            dialogue_speaker_alpha: self.dialogue_alpha,
            telop_visible: self.telop_visible,
            telop_text: &self.telop_text,
            telop_alpha: self.telop_alpha,
            telop_x_offset: self.telop_x_offset,
            fade_visible: self.fade_visible,
            fade_color: self.fade_color,
            fade_alpha: self.fade_alpha * self.fade_color[3],
            background_clear: self.background_clear,
        };

        render_fn(&mut self.gpu, &mut self.text_renderer, &frame_input)
    }

    fn ensure_model_loaded(&mut self, model_key: &str) -> Result<(), RendererError> {
        if self.models.contains_key(model_key) {
            return Ok(());
        }
        let (asset, entry_path) = self.input.resolve_model_asset(model_key)?;
        let seed = derive_key_seed(self.master_seed, model_key);
        let instance = Live2DModelInstance::load(model_key, &entry_path, seed)?;
        self.gpu.register_live2d_model(model_key, &instance);
        self.models.insert(
            model_key.to_string(),
            LoadedSceneModel {
                asset: asset.clone(),
                instance,
            },
        );
        Ok(())
    }

    fn layout_model_entry(&mut self, model_key: &str) {
        if let Some(entry) = self.models.get_mut(model_key) {
            let orig_h = entry.instance.original_height().max(1.0);
            let scale_mult = match self.layout_mode {
                LayoutMode::Normal => entry.asset.normal_scale,
                LayoutMode::Three => entry.asset.small_scale,
            };
            entry.instance.stage.anchor_x = 0.5;
            entry.instance.stage.anchor_y = entry.asset.anchor;
            entry.instance.stage.scale = (self.stage_height as f32 / orig_h) * scale_mult;
        }
    }

    fn set_layout_hologram(&mut self, model_key: &str, enabled: bool) -> Result<(), RendererError> {
        let effect_id = format!("{LAYOUT_HOLOGRAM_EFFECT_PREFIX}{model_key}");
        if enabled {
            if !self.vfx.has_effect(&effect_id) {
                self.ensure_model_loaded(model_key)?;
                let canvas_size = self
                    .models
                    .get(model_key)
                    .map(|m| (m.instance.original_width(), m.instance.original_height()));
                self.vfx.apply(
                    &effect_id,
                    &EffectTargetData::Model {
                        model: model_key.to_string(),
                    },
                    &VisualEffectData::Hologram,
                    canvas_size,
                )?;
            }
        } else {
            self.vfx.remove(&effect_id);
        }
        Ok(())
    }
}

impl<'a> SceneDriver for StorySceneState<'a> {
    fn set_layout_mode(&mut self, mode: LayoutMode) {
        self.layout_mode = mode;
    }

    fn set_background(&mut self, bg_key: &str) -> Result<(), RendererError> {
        if !self.loaded_backgrounds.contains(bg_key) {
            let path = self.input.resolve_background_path(bg_key)?;
            self.gpu.register_background_from_file(bg_key, &path)?;
            self.loaded_backgrounds.insert(bg_key.to_string());
        }
        self.background_key = Some(bg_key.to_string());
        Ok(())
    }

    fn attach_or_show_model(
        &mut self,
        model_key: &str,
        position: &PositionData,
        hologram: bool,
        motion: Option<&str>,
        facial: Option<&str>,
    ) -> Result<(), RendererError> {
        self.ensure_model_loaded(model_key)?;
        self.layout_model_entry(model_key);

        if !self.model_order.iter().any(|k| k == model_key) {
            self.model_order.push(model_key.to_string());
        }

        let (rx, ry) = side_to_rel_position(position, self.layout_mode);
        let sw = self.stage_width as f32;
        let sh = self.stage_height as f32;
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.stage.visible = true;
            entry.instance.stage.pos_x = sw * rx;
            entry.instance.stage.pos_y = sh * (ry + 0.3);
            if motion.is_some() || facial.is_some() {
                entry.instance.play_last_frame(motion, facial);
            }
        }
        self.positioned_model_keys.insert(model_key.to_string());
        self.set_layout_hologram(model_key, hologram)?;
        Ok(())
    }

    fn model_alpha(&self, model_key: &str) -> Option<f32> {
        if !self.model_order.iter().any(|k| k == model_key) {
            return None;
        }
        self.models
            .get(model_key)
            .filter(|m| m.instance.stage.visible)
            .map(|m| m.instance.stage.alpha)
    }

    fn set_model_alpha(&mut self, model_key: &str, alpha: f32) {
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.stage.alpha = alpha.clamp(0.0, 1.0);
        }
    }

    fn detach_model(&mut self, model_key: &str) {
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.stage.visible = false;
            entry.instance.stage.alpha = 0.0;
        }
        self.model_order.retain(|k| k != model_key);
        self.active_model_voices.remove(model_key);
        let _ = self.set_layout_hologram(model_key, false);
    }

    fn set_model_position(
        &mut self,
        model_key: &str,
        from: &PositionData,
        to: &PositionData,
        progress: f32,
    ) -> Result<(), RendererError> {
        self.ensure_model_loaded(model_key)?;
        self.positioned_model_keys.insert(model_key.to_string());
        let (fx, fy) = side_to_rel_position(from, self.layout_mode);
        let (tx, ty) = side_to_rel_position(to, self.layout_mode);
        let sw = self.stage_width as f32;
        let sh = self.stage_height as f32;
        let ax0 = sw * fx;
        let ay0 = sh * (fy + 0.3);
        let ax1 = sw * tx;
        let ay1 = sh * (ty + 0.3);
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.stage.pos_x = ax0 + (ax1 - ax0) * progress;
            entry.instance.stage.pos_y = ay0 + (ay1 - ay0) * progress;
        }
        Ok(())
    }

    fn start_model_motion(
        &mut self,
        model_key: &str,
        motion: Option<&str>,
        facial: Option<&str>,
        ignore_eye_params: bool,
    ) -> Result<(), RendererError> {
        self.ensure_model_loaded(model_key)?;
        if let Some(entry) = self.models.get_mut(model_key) {
            entry
                .instance
                .start_motion(motion, facial, ignore_eye_params)?;
        }
        Ok(())
    }

    fn is_model_motion_finished(&self, model_key: &str) -> bool {
        self.models
            .get(model_key)
            .map(|m| m.instance.is_motion_finished())
            .unwrap_or(true)
    }

    fn close_model_eyes(&mut self, model_key: &str) {
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.set_eye_open(0.0);
        }
    }

    fn set_model_parameter(&mut self, model_key: &str, param_id: &str, value: f32) {
        if let Some(entry) = self.models.get_mut(model_key) {
            entry.instance.set_parameter(param_id, value);
        }
    }

    fn is_talk_shown(&self) -> bool {
        self.dialogue_visible
    }

    fn prepare_dialogue(&mut self, speaker: &str, _content: &str) {
        self.dialogue_speaker = speaker.to_string();
        self.dialogue_partial_text.clear();
    }

    fn set_dialogue_visibility(&mut self, visible: bool, alpha: f32) {
        self.dialogue_visible = visible;
        self.dialogue_alpha = alpha.clamp(0.0, 1.0);
    }

    fn set_dialogue_text(&mut self, partial_text: &str) {
        self.dialogue_partial_text = partial_text.to_string();
    }

    fn start_voice(
        &mut self,
        model_key: Option<&str>,
        voice_key: &str,
        now_ms: f64,
    ) -> Result<Option<f64>, RendererError> {
        if !self.decoded_voices.contains_key(voice_key) {
            let path = self.input.resolve_voice_path(voice_key)?;
            let decoded = decode_audio_file(&path)?;
            self.decoded_voices.insert(voice_key.to_string(), decoded);
        }
        let duration_ms = self
            .decoded_voices
            .get(voice_key)
            .map(DecodedAudio::duration_ms)
            .unwrap_or(0.0);
        if duration_ms > 0.0 {
            self.scheduled_voices.push(ScheduledVoiceEvent {
                start_ms: now_ms,
                voice_key: voice_key.to_string(),
                gain: VOICE_VOLUME,
            });
            if let Some(m_key) = model_key {
                self.active_model_voices.insert(
                    m_key.to_string(),
                    ActiveModelVoice {
                        voice_key: voice_key.to_string(),
                        start_ms: now_ms,
                        end_ms: now_ms + duration_ms,
                    },
                );
            }
            Ok(Some(duration_ms))
        } else {
            Ok(None)
        }
    }

    fn prepare_telop(&mut self, content: &str) {
        self.telop_text = content.to_string();
    }

    fn set_telop_state(&mut self, visible: bool, alpha: f32, x_offset: f32) {
        self.telop_visible = visible;
        self.telop_alpha = alpha.clamp(0.0, 1.0);
        self.telop_x_offset = x_offset;
    }

    fn current_fade_alpha(&self) -> f32 {
        self.fade_alpha
    }

    fn set_fade_state(&mut self, color: Option<[f32; 4]>, visible: bool, alpha: f32) {
        if let Some(rgba) = color {
            self.fade_color = rgba;
        }
        self.fade_visible = visible;
        self.fade_alpha = alpha.clamp(0.0, 1.0);
    }

    fn has_effect(&self, effect_id: &str) -> bool {
        self.vfx.has_effect(effect_id)
    }

    fn apply_effect(
        &mut self,
        effect_id: &str,
        target: &EffectTargetData,
        effect: &VisualEffectData,
    ) -> Result<(), RendererError> {
        let model_canvas_size = if let EffectTargetData::Model { model } = target {
            self.ensure_model_loaded(model)?;
            self.models
                .get(model)
                .map(|m| (m.instance.original_width(), m.instance.original_height()))
        } else {
            None
        };
        self.vfx.apply(effect_id, target, effect, model_canvas_size)
    }

    fn set_effect_progress(&mut self, effect_id: &str, progress: f32) {
        self.vfx.set_progress(effect_id, progress);
    }

    fn remove_effect(&mut self, effect_id: &str) {
        self.vfx.remove(effect_id);
    }

    fn tick_scene(&mut self, delta_ms: f64, now_ms: f64) {
        self.vfx.update(delta_ms);

        self.active_model_voices
            .retain(|_, voice| now_ms < voice.end_ms);

        for model_key in &self.model_order {
            let mouth_open = if let Some(voice) = self.active_model_voices.get(model_key) {
                self.decoded_voices
                    .get(&voice.voice_key)
                    .map(|audio| audio.lip_sync_mouth_open_at(now_ms - voice.start_ms))
                    .unwrap_or(0.0)
            } else {
                0.0
            };

            if let Some(entry) = self.models.get_mut(model_key) {
                entry.instance.set_mouth_sync(mouth_open);
                entry.instance.accumulate_delta_ms(delta_ms as f32);
                entry.instance.commit_simulation_step(false);
            }
        }
    }
}

fn side_to_rel_position(pos: &PositionData, mode: LayoutMode) -> (f32, f32) {
    let base_x = match (mode, pos.side) {
        (LayoutMode::Normal, Side::Center) => 0.5,
        (LayoutMode::Normal, Side::Left) => 0.3,
        (LayoutMode::Normal, Side::Right) => 0.7,
        (LayoutMode::Three, Side::Center) => 0.5,
        (LayoutMode::Three, Side::Left) => 0.25,
        (LayoutMode::Three, Side::Right) => 0.75,
    };
    (base_x + pos.offset / 1920.0, 0.5)
}

fn derive_key_seed(master_seed: u64, key: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64 ^ master_seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    for &b in key.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn collect_story_preload_keys(
    snippets: &[SnippetData],
    models: &mut HashSet<String>,
    backgrounds: &mut HashSet<String>,
) {
    for snippet in snippets {
        match snippet {
            SnippetData::ChangeBackgroundImage { data, .. } => {
                backgrounds.insert(data.background.clone());
            }
            SnippetData::LayoutAppear { data, .. } => {
                models.insert(data.model.clone());
            }
            SnippetData::Move { data, .. } => {
                models.insert(data.model.clone());
            }
            SnippetData::Motion { data, .. } => {
                models.insert(data.model.clone());
            }
            SnippetData::DoParam { data, .. } => {
                models.insert(data.model.clone());
            }
            SnippetData::Talk { data, .. } => {
                if let Some(model) = &data.model {
                    models.insert(model.clone());
                }
            }
            SnippetData::ApplyEffect { data, .. } => {
                if let EffectTargetData::Model { model } = &data.target {
                    models.insert(model.clone());
                }
            }
            SnippetData::Parallel { snippets, .. } => {
                collect_story_preload_keys(snippets, models, backgrounds);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::config::VideoQualityPreset;
    use crate::renderer::dispatcher::StoryRunner;
    use crate::renderer::story::*;
    use std::path::PathBuf;

    fn build_test_input(dir: &PathBuf) -> ProjectRenderInput {
        let data_dir = dir.join("data");
        let project_dir = dir.join("project");
        let models_dir = data_dir.join("models/ichika");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(project_dir.join("backgrounds")).unwrap();
        std::fs::create_dir_all(project_dir.join("voices")).unwrap();

        // Point directly to tests/models and tests/voices via hardlink/copy into temp dirs.
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let src_model_dir = repo_root.join("tests/models/01ichika_normal_3.0_f_t04");
        fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) {
            std::fs::create_dir_all(dst).unwrap();
            for entry in std::fs::read_dir(src).unwrap().flatten() {
                let p = entry.path();
                let d = dst.join(entry.file_name());
                if p.is_dir() {
                    copy_dir_all(&p, &d);
                } else {
                    std::fs::copy(&p, &d).unwrap();
                }
            }
        }
        copy_dir_all(&src_model_dir, &models_dir);

        // Create a tiny solid teal PNG background.
        let mut bg = image::RgbaImage::new(64, 64);
        for px in bg.pixels_mut() {
            *px = image::Rgba([28, 62, 92, 255]);
        }
        bg.save(project_dir.join("backgrounds/classroom.png"))
            .unwrap();

        // Copy first test voice from tests/voices if available.
        let mut voice_rel = None;
        if let Ok(rd) = std::fs::read_dir(repo_root.join("tests/voices")) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let fname = entry.file_name();
                    let dst = project_dir.join("voices").join(&fname);
                    std::fs::copy(&p, &dst).unwrap();
                    voice_rel = Some(format!("voices/{}", fname.to_string_lossy()));
                    break;
                }
            }
        }

        let mut models = HashMap::new();
        models.insert(
            "ichika_main".to_string(),
            ModelAsset {
                name: Some("星乃一歌".to_string()),
                model_id: "ichika".to_string(),
                normal_scale: 2.1,
                small_scale: 1.6,
                anchor: 0.5,
            },
        );
        let mut backgrounds = HashMap::new();
        backgrounds.insert(
            "bg_room".to_string(),
            BackgroundAsset {
                name: Some("Room".to_string()),
                path: "backgrounds/classroom.png".to_string(),
            },
        );
        let mut voices = HashMap::new();
        let has_voice = voice_rel.is_some();
        if let Some(vr) = voice_rel {
            voices.insert(
                "v01".to_string(),
                VoiceAsset {
                    name: Some("v01".to_string()),
                    path: vr,
                },
            );
        }

        let mut registry_models = HashMap::new();
        registry_models.insert(
            "ichika".to_string(),
            ModelRegistryEntry {
                name: Some("Ichika".to_string()),
                entry: "01ichika_normal_3.0_f_t04.model3.json".to_string(),
                motions: Vec::new(),
                facials: Vec::new(),
            },
        );

        let snippets = vec![
            SnippetData::ChangeBackgroundImage {
                id: None,
                delay: 0.0,
                data: ChangeBackgroundImageData {
                    background: "bg_room".to_string(),
                },
            },
            SnippetData::Telop {
                id: None,
                delay: 0.0,
                data: TelopData {
                    content: "第一章 · 纯 Rust 渲染".to_string(),
                },
            },
            SnippetData::LayoutAppear {
                id: None,
                delay: 0.0,
                data: LayoutAppearData {
                    model: "ichika_main".to_string(),
                    position: PositionData {
                        side: Side::Center,
                        offset: 0.0,
                    },
                    hologram: true,
                    motion: Some("w-normal-nod01".to_string()),
                    facial: Some("face_smile_01".to_string()),
                },
            },
            SnippetData::ApplyEffect {
                id: None,
                delay: 0.0,
                data: ApplyEffectData {
                    effect_id: "fx_stage_blur".to_string(),
                    duration: 0.2,
                    target: EffectTargetData::Stage,
                    effect: VisualEffectData::Blur {
                        strength: 4.0,
                        quality: 2,
                        kernel_size: 5,
                    },
                },
            },
            SnippetData::Talk {
                id: None,
                delay: 0.0,
                data: TalkData {
                    speaker: "星乃一歌".to_string(),
                    content: "大家好，这是一个离线场景驱动测试！".to_string(),
                    model: Some("ichika_main".to_string()),
                    voice: if has_voice {
                        Some("v01".to_string())
                    } else {
                        None
                    },
                },
            },
            SnippetData::ScreenFadeOut {
                id: None,
                delay: 0.0,
                data: ScreenFadeOutData {
                    duration: 0.15,
                    color: "#000000".to_string(),
                },
            },
        ];

        ProjectRenderInput {
            data_dir,
            project_dir,
            story: StoryData {
                version: 1,
                snippets,
            },
            assets: ProjectAssets {
                models,
                backgrounds,
                voices,
            },
            model_registry: ModelRegistry {
                version: 1,
                models: registry_models,
            },
            font: PlaybackFontConfig::Default,
        }
    }

    #[test]
    fn story_scene_state_drives_story_runner_deterministically() {
        let tmp = std::env::temp_dir().join("mss_scene_impl_test");
        let _ = std::fs::remove_dir_all(&tmp);
        let input = build_test_input(&tmp);

        let config = VideoExportConfig {
            width: 1280,
            height: 720,
            fps: 30,
            quality: VideoQualityPreset::Balanced,
            trailing_hold_ms: 0,
            seed_mode: crate::renderer::config::SeedMode::Fixed { seed: 2026 },
            ..Default::default()
        };
        let seed = config.resolve_seed();

        let render_once = || -> (Vec<Vec<u8>>, usize) {
            let mut scene = StorySceneState::new(&input, &config, seed).expect("scene init");
            let mut runner = StoryRunner::new(input.story.clone());
            runner.initialize(&mut scene).expect("init");
            let mut sampled = Vec::new();
            let frame_dt = 1000.0 / config.fps as f64;
            for f in 0..90 {
                if f % 30 == 0 || f == 10 {
                    sampled.push(scene.render_current_frame().expect("render frame"));
                }
                runner.step_frame(frame_dt, &mut scene).expect("step");
                if runner.is_fully_idle() {
                    break;
                }
            }
            (sampled, scene.scheduled_voices().len())
        };

        let (run1, voices1) = render_once();
        let (run2, voices2) = render_once();
        assert_eq!(voices1, voices2);
        assert_eq!(run1.len(), run2.len());
        assert!(run1.len() >= 2);
        assert_eq!(run1[0], run2[0], "Frame 0 must be bit-exact deterministic");
        assert_eq!(run1[1], run2[1], "Frame 10 must be bit-exact deterministic");

        // Ensure background + model + dialogue actually produced diverse colors cleanly.
        let non_black = run1[1]
            .chunks_exact(4)
            .filter(|p| p[0] > 10 || p[1] > 10 || p[2] > 10)
            .count();
        assert!(non_black > 50_000, "rendered too dark: {non_black}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
