use mocari::assets::{load_model_runtime, DecodedTexture, RuntimeModel};
use mocari::moc3::Moc3DrawableMesh;
use mocari::render::common::{draw_order_indices, ClippingPlan, DrawableInfo};
use mocari::runtime::ModelRuntime;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::breath::CubismBreath;
use super::expression::ModelExpressionBank;
use super::eyeblink::CubismEyeBlink;
use super::motion::{
    load_motion_bank, set_clamped_param, MotionBank, ParallelMotionTrack,
};
use super::{LIP_SYNC_GAIN, LIP_SYNC_WEIGHT, MOTION_IGNORE_EYE_PARAMS, MOTION_IGNORE_FACE_PARAMS};
use crate::renderer::error::RendererError;

#[derive(Debug, Clone, Deserialize)]
pub struct MotionManifestEntry {
    #[serde(rename = "File")]
    pub file: String,
    #[serde(rename = "FadeInTime")]
    pub fade_in_time: Option<f32>,
    #[serde(rename = "FadeOutTime")]
    pub fade_out_time: Option<f32>,
    #[serde(rename = "Sound")]
    pub sound: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Model3FileRefsRaw {
    #[serde(rename = "Moc")]
    moc: Option<String>,
    #[serde(rename = "Motions", default)]
    motions: HashMap<String, Vec<MotionManifestEntry>>,
}

#[derive(Debug, Deserialize)]
struct Model3RawManifest {
    #[serde(rename = "Version")]
    version: Option<u32>,
    #[serde(rename = "FileReferences")]
    file_references: Option<Model3FileRefsRaw>,
}

/// Resolved transform matching `PixiLive2DModel` (`anchorMode: 'canvas'`, `anchor: (0.5, asset.anchor)`).
#[derive(Debug, Clone, Copy)]
pub struct Live2DStageTransform {
    pub pos_x: f32,
    pub pos_y: f32,
    pub scale: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub alpha: f32,
    pub visible: bool,
}

impl Default for Live2DStageTransform {
    fn default() -> Self {
        Self {
            pos_x: 0.0,
            pos_y: 0.0,
            scale: 1.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
            alpha: 0.0,
            visible: false,
        }
    }
}

/// Complete pure-Rust Live2D `.moc3` model instance replicating `untitled-pixi-live2d-engine` + `src/story/scene.ts`.
pub struct Live2DModelInstance {
    pub key: String,
    runtime_model: RuntimeModel,
    motions: MotionBank,
    expressions: ModelExpressionBank,
    parallel_tracks: [ParallelMotionTrack; 2],
    eye_blink: CubismEyeBlink,
    breath: CubismBreath,
    eye_blink_ids: Vec<String>,
    lip_sync_ids: Vec<String>,
    saved_parameters: Vec<f32>,
    repeat_flags: Vec<bool>,
    elapsed_seconds: f32,
    pending_delta_ms: f32,
    mouth_sync_raw: f32,
    pub stage: Live2DStageTransform,
}

impl Live2DModelInstance {
    pub fn load(key: &str, model_path: &Path, seed: u64) -> Result<Self, RendererError> {
        let lower_name = model_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if lower_name.ends_with(".model.json") && !lower_name.ends_with(".model3.json") {
            return Err(RendererError::UnsupportedLegacyModel(format!(
                "Model '{}' uses legacy Cubism 2 (.model.json / .moc); only Cubism 3/4/5 .model3.json + .moc3 models are supported by the pure-Rust renderer",
                model_path.display()
            )));
        }

        let manifest_text = fs::read_to_string(model_path).map_err(|e| {
            RendererError::ModelLoad(format!(
                "Failed to read model manifest '{}': {e}",
                model_path.display()
            ))
        })?;
        let raw_manifest: Model3RawManifest =
            serde_json::from_str(&manifest_text).map_err(|e| {
                RendererError::ModelLoad(format!(
                    "Invalid model JSON '{}': {e}",
                    model_path.display()
                ))
            })?;
        let version = raw_manifest.version.unwrap_or(0);
        let Some(file_refs) = raw_manifest.file_references else {
            return Err(RendererError::UnsupportedLegacyModel(format!(
                "Model '{}' has no Cubism 3+ FileReferences block (version={version}); legacy Cubism 2 models are not supported",
                model_path.display()
            )));
        };
        if version < 3 {
            return Err(RendererError::UnsupportedLegacyModel(format!(
                "Model '{}' has unsupported Cubism version {}; requires Cubism 3+",
                model_path.display(),
                version
            )));
        }
        if let Some(moc) = &file_refs.moc {
            if !moc.to_ascii_lowercase().ends_with(".moc3") {
                return Err(RendererError::UnsupportedLegacyModel(format!(
                    "Model '{}' references '{}', expected a .moc3 binary",
                    model_path.display(),
                    moc
                )));
            }
        }

        let mut runtime_model = load_model_runtime(model_path).map_err(|e| {
            RendererError::ModelLoad(format!(
                "Failed to load Live2D runtime '{}': {e:?}",
                model_path.display()
            ))
        })?;
        let model_dir = model_path
            .parent()
            .ok_or_else(|| RendererError::ModelLoad("Model path has no parent directory".into()))?;

        let motions = load_motion_bank(model_dir, &file_refs.motions)?;
        let expressions =
            ModelExpressionBank::load(model_dir, runtime_model.runtime().model().expressions())?;

        // Extract `EyeBlink` and `LipSync` parameter groups (`Groups` in model3.json).
        let mut eye_blink_ids = Vec::new();
        let mut lip_sync_ids = Vec::new();
        for group in runtime_model.runtime().model().groups() {
            if group.target() != "Parameter" {
                continue;
            }
            match group.name() {
                "EyeBlink" => eye_blink_ids.extend(group.ids().iter().cloned()),
                "LipSync" => lip_sync_ids.extend(group.ids().iter().cloned()),
                _ => {}
            }
        }
        if lip_sync_ids.is_empty() {
            lip_sync_ids.push("ParamMouthOpenY".to_string());
        }

        // Initial pose & mesh update at t = 0 so canvas bounds and defaults are ready.
        runtime_model.runtime_mut().apply_pose(0.0);
        runtime_model.runtime_mut().update_meshes();

        let saved_parameters = runtime_model.runtime().parameter_values().to_vec();
        let repeat_flags = vec![false; saved_parameters.len()];

        Ok(Self {
            key: key.to_string(),
            runtime_model,
            motions,
            expressions,
            parallel_tracks: [ParallelMotionTrack::default(), ParallelMotionTrack::default()],
            eye_blink: CubismEyeBlink::new(eye_blink_ids.clone(), seed),
            breath: CubismBreath::with_default_sekai_params(),
            eye_blink_ids,
            lip_sync_ids,
            saved_parameters,
            repeat_flags,
            elapsed_seconds: 0.0,
            pending_delta_ms: 0.0,
            mouth_sync_raw: 0.0,
            stage: Live2DStageTransform::default(),
        })
    }

    pub fn runtime(&self) -> &ModelRuntime {
        self.runtime_model.runtime()
    }

    pub fn textures(&self) -> &[DecodedTexture] {
        self.runtime_model.textures()
    }

    pub fn original_width(&self) -> f32 {
        self.runtime().canvas().width()
    }

    pub fn original_height(&self) -> f32 {
        self.runtime().canvas().height()
    }

    pub fn pixels_per_unit(&self) -> f32 {
        self.runtime().canvas().pixels_per_unit()
    }

    /// Accumulates frame substeps just like `Live2DModel.update(dt)`.
    pub fn accumulate_delta_ms(&mut self, delta_ms: f32) {
        self.pending_delta_ms += delta_ms.max(0.0);
    }

    pub fn set_mouth_sync(&mut self, value: f32) {
        self.mouth_sync_raw = value.clamp(0.0, 1.0);
    }

    /// Runs `Cubism4InternalModel.update(dt, now)` matching `cubism.es.js:11928-11957`.
    pub fn commit_frame_update(&mut self) {
        self.commit_simulation_step(true);
    }

    /// Advances motions, expressions, blink, breath, lip-sync, physics, and pose,
    /// optionally skipping `update_meshes()` on intermediate substeps that are not rendered.
    pub fn commit_simulation_step(&mut self, update_meshes: bool) {
        let dt_ms: f32 = self.pending_delta_ms;
        self.pending_delta_ms = 0.0;
        let dt: f32 = dt_ms / 1000.0;
        self.elapsed_seconds += dt;
        let now: f32 = self.elapsed_seconds;

        let repeat_flags = &self.repeat_flags;

        // 1. Update parallel motions onto current parameters (`updateMotions` before `saveParameters`).
        let mut motion_updated: bool = false;
        let runtime = self.runtime_model.runtime_mut();
        for track in &mut self.parallel_tracks {
            motion_updated |= track.update_parameters(runtime, now, repeat_flags);
        }

        // 2. `model.saveParameters()`.
        let param_values = runtime.parameter_values();
        if self.saved_parameters.len() == param_values.len() {
            self.saved_parameters.copy_from_slice(param_values);
        } else {
            self.saved_parameters = param_values.to_vec();
        }

        // 3. Expressions (`expressionManager.update`).
        self.expressions.update(runtime, dt);

        // 4. `if (!motionUpdated) eyeBlink.updateParameters`.
        if !motion_updated {
            self.eye_blink.update_parameters(runtime, dt);
        }

        // 5. `breath.updateParameters`.
        self.breath.update_parameters(runtime, dt);

        // 6. Lip sync (`untitled-pixi-live2d-engine` RMS weighting).
        if self.mouth_sync_raw > 0.0 && !self.lip_sync_ids.is_empty() {
            let mut val = (self.mouth_sync_raw * LIP_SYNC_GAIN).powf(1.15);
            val = val.clamp(0.1, 1.0);
            for id in &self.lip_sync_ids {
                if let Some(idx) = runtime.parameter_index(id) {
                    let cur = runtime.parameter_value_by_index(idx).unwrap_or(0.0);
                    set_clamped_param(runtime, idx, cur + val * LIP_SYNC_WEIGHT, repeat_flags);
                }
            }
        }

        // 7. Physics + 8. Pose (`deltaTimeSeconds`).
        if dt > 0.0 {
            runtime.apply_physics(dt);
            runtime.apply_pose(dt);
        }

        // 9. `model.update()` -> regenerate deformed vertices / opacity / colors.
        if update_meshes {
            runtime.update_meshes();
        }

        // 10. `model.loadParameters()`.
        for (idx, &saved) in self.saved_parameters.iter().enumerate() {
            runtime.set_parameter_by_index(idx, saved);
        }
    }

    pub fn start_motion(
        &mut self,
        motion_group: Option<&str>,
        facial_group: Option<&str>,
        ignore_motion_eye_params: bool,
    ) -> Result<(), RendererError> {
        self.stop_all_motions();

        let ignore_ids: &[&str] = if facial_group.is_some() {
            MOTION_IGNORE_FACE_PARAMS
        } else if ignore_motion_eye_params {
            MOTION_IGNORE_EYE_PARAMS
        } else {
            &[]
        };

        if let Some(group) = motion_group {
            if let Some(entries) = self.motions.get(group) {
                if let Some(first) = entries.first() {
                    self.parallel_tracks[0].start_motion(
                        first,
                        ignore_ids,
                        Some(false),
                        self.eye_blink_ids.clone(),
                        self.lip_sync_ids.clone(),
                    );
                }
            }
        }
        if let Some(group) = facial_group {
            if let Some(entries) = self.motions.get(group) {
                if let Some(first) = entries.first() {
                    self.parallel_tracks[1].start_motion(
                        first,
                        &[],
                        Some(false),
                        self.eye_blink_ids.clone(),
                        self.lip_sync_ids.clone(),
                    );
                }
            }
        }

        Ok(())
    }

    pub fn play_last_frame(
        &mut self,
        motion_group: Option<&str>,
        facial_group: Option<&str>,
    ) {
        self.stop_all_motions();
        let eye_ids = self.eye_blink_ids.clone();
        let lip_ids = self.lip_sync_ids.clone();

        if let Some(group) = motion_group {
            if let Some(first) = self.motions.get(group).and_then(|v| v.first()) {
                let runtime = self.runtime_model.runtime_mut();
                self.parallel_tracks[0].play_last_frame(
                    first,
                    runtime,
                    eye_ids.clone(),
                    lip_ids.clone(),
                    &self.repeat_flags,
                );
            }
        }
        if let Some(group) = facial_group {
            if let Some(first) = self.motions.get(group).and_then(|v| v.first()) {
                let runtime = self.runtime_model.runtime_mut();
                self.parallel_tracks[1].play_last_frame(
                    first,
                    runtime,
                    eye_ids,
                    lip_ids,
                    &self.repeat_flags,
                );
            }
        }
        let runtime = self.runtime_model.runtime_mut();
        self.saved_parameters = runtime.parameter_values().to_vec();
        runtime.apply_pose(0.0);
        runtime.update_meshes();
    }

    pub fn stop_all_motions(&mut self) {
        for track in &mut self.parallel_tracks {
            track.stop_all();
        }
    }

    pub fn is_motion_finished(&self) -> bool {
        self.parallel_tracks.iter().all(ParallelMotionTrack::is_finished)
    }

    pub fn set_parameter(&mut self, param_id: &str, value: f32) {
        let runtime = self.runtime_model.runtime_mut();
        if let Some(idx) = runtime.parameter_index(param_id) {
            set_clamped_param(runtime, idx, value, &self.repeat_flags);
        }
    }

    pub fn reset_parameter(&mut self, param_id: &str) {
        let runtime = self.runtime_model.runtime_mut();
        if let Some(idx) = runtime.parameter_index(param_id) {
            let default = runtime.parameter_default_by_index(idx).unwrap_or(0.0);
            runtime.set_parameter_by_index(idx, default);
        }
    }

    pub fn reset_all_parameters(&mut self) {
        self.runtime_model.runtime_mut().reset_parameters();
        self.runtime_model.runtime_mut().reset_part_opacities();
    }

    pub fn set_eye_open(&mut self, value: f32) {
        let ids = if self.eye_blink_ids.is_empty() {
            vec!["ParamEyeLOpen".to_string(), "ParamEyeROpen".to_string()]
        } else {
            self.eye_blink_ids.clone()
        };
        for id in ids {
            self.set_parameter(&id, value);
        }
    }

    pub fn set_expression(&mut self, name: &str) -> Result<(), RendererError> {
        self.expressions.set_expression(name)
    }

    pub fn reset_expression(&mut self) {
        self.expressions.reset_expression();
    }

    pub fn has_motion_group(&self, group: &str) -> bool {
        self.motions.contains_key(group)
    }

    pub fn sorted_draw_order(&self) -> Vec<usize> {
        let meshes = self.runtime().meshes();
        let infos: Vec<DrawableInfo> = meshes.iter().map(DrawableInfo::from_mesh).collect();
        draw_order_indices(&infos)
    }

    pub fn build_clipping_plan(&self) -> Result<(Vec<DrawableInfo>, ClippingPlan), RendererError> {
        let infos: Vec<DrawableInfo> = self
            .runtime()
            .meshes()
            .iter()
            .map(DrawableInfo::from_mesh)
            .collect();
        let mut plan = ClippingPlan::from_drawables(infos.iter());
        plan.prepare_single_texture_masks(&infos).map_err(|e| {
            RendererError::Render(format!("Failed to prepare Live2D clipping plan: {e:?}"))
        })?;
        Ok((infos, plan))
    }

    pub fn meshes(&self) -> &[Moc3DrawableMesh] {
        self.runtime().meshes()
    }

    /// Converts a `.moc3` model-space coordinate `[mx, my]` (Y-up) into stage pixel coordinates `[sx, sy]` (Y-down).
    pub fn model_point_to_stage_px(&self, model_xy: [f32; 2]) -> [f32; 2] {
        let ppu = self.pixels_per_unit();
        let orig_w = self.original_width();
        let orig_h = self.original_height();
        let s = self.stage.scale;
        let sx = self.stage.pos_x + (model_xy[0] * ppu - (self.stage.anchor_x - 0.5) * orig_w) * s;
        let sy = self.stage.pos_y + (-model_xy[1] * ppu + (0.5 - self.stage.anchor_y) * orig_h) * s;
        [sx, sy]
    }

    /// Computes 4x4 column-major MVP matrix mapping Cubism `.moc3` model space directly to `wgpu` NDC `[-1..1]`.
    pub fn mvp_ndc_for_stage(&self, stage_width: f32, stage_height: f32) -> [f32; 16] {
        let ppu = self.pixels_per_unit();
        let orig_w = self.original_width();
        let orig_h = self.original_height();
        let s = self.stage.scale;

        let scale_x = (2.0 / stage_width) * s * ppu;
        let scale_y = (2.0 / stage_height) * s * ppu;

        let offset_px_x = self.stage.pos_x - (self.stage.anchor_x - 0.5) * orig_w * s;
        let offset_px_y = self.stage.pos_y + (0.5 - self.stage.anchor_y) * orig_h * s;

        let tx = 2.0 * offset_px_x / stage_width - 1.0;
        let ty = 1.0 - 2.0 * offset_px_y / stage_height;

        [
            scale_x, 0.0, 0.0, 0.0,
            0.0, scale_y, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            tx, ty, 0.0, 1.0,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_models() -> Vec<(&'static str, PathBuf)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/models");
        vec![
            (
                "ichika",
                root.join("01ichika_normal_3.0_f_t04/01ichika_normal_3.0_f_t04.model3.json"),
            ),
            (
                "miku",
                root.join("21miku_band_3.0_f_t01/21miku_band_3.0_f_t01.model3.json"),
            ),
            (
                "rin",
                root.join("22rin_idol_3.0_f_t02/22rin_idol_3.0_f_t02.model3.json"),
            ),
            (
                "luka",
                root.join("24luka_band_3.0_f_t01/24luka_band_3.0_f_t01.model3.json"),
            ),
        ]
    }

    #[test]
    fn reject_legacy_cubism2_model_explicitly() {
        let err = Live2DModelInstance::load(
            "legacy",
            Path::new("/tmp/nonexistent/legacy.model.json"),
            42,
        )
        .err()
        .expect("must fail");
        assert!(matches!(err, RendererError::UnsupportedLegacyModel(_)));
    }

    #[test]
    fn load_and_animate_all_four_test_models() {
        for (name, path) in test_models() {
            let mut instance = Live2DModelInstance::load(name, &path, 1234)
                .unwrap_or_else(|e| panic!("failed to load {name}: {e}"));
            assert!(
                instance.original_width() > 100.0 && instance.original_height() > 100.0,
                "unexpected canvas size for {name}: {}x{}",
                instance.original_width(),
                instance.original_height()
            );
            assert!(!instance.meshes().is_empty());
            assert!(!instance.textures().is_empty());

            // Verify clipping plan succeeds cleanly within single texture budget.
            let (_, plan) = instance.build_clipping_plan().expect("clipping plan");
            assert!(plan.contexts().len() <= 36);

            // Start motion + facial + lip sync and step a few frames.
            assert!(instance.has_motion_group("w-normal-glad01") || !instance.motions.is_empty());
            let motion_name = instance
                .motions
                .keys()
                .find(|k| k.starts_with("w-"))
                .cloned();
            let facial_name = instance
                .motions
                .keys()
                .find(|k| k.starts_with("face_"))
                .cloned();
            instance
                .start_motion(motion_name.as_deref(), facial_name.as_deref(), true)
                .expect("start motion");
            assert!(!instance.is_motion_finished());

            instance.set_mouth_sync(0.8);
            for _ in 0..10 {
                instance.accumulate_delta_ms(33.3333);
                instance.commit_frame_update();
            }
            let (_, plan_after) = instance.build_clipping_plan().expect("clipping plan");
            assert!(!plan_after.unmasked_drawable_indices().is_empty());
        }
    }

    #[test]
    fn play_last_frame_applies_final_pose_and_finishes_cleanly() {
        let (_, path) = test_models().into_iter().next().unwrap();
        let mut instance = Live2DModelInstance::load("ichika", &path, 77).unwrap();
        instance.play_last_frame(Some("w-normal-nod01"), Some("face_smile_01"));
        assert!(instance.is_motion_finished());
        // Verify canvas info & coordinate mapping are sane.
        let origin_stage = instance.model_point_to_stage_px([0.0, 0.0]);
        assert!(origin_stage[0].is_finite() && origin_stage[1].is_finite());
    }
}
