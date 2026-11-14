use mocari::json::{Motion3, MotionCurve, MotionPoint, MotionSegment};
use mocari::runtime::ModelRuntime;
use serde::Deserialize;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::fs;
use std::path::Path;

use super::DEFAULT_MOTION_FADE_SECONDS;
use crate::renderer::error::RendererError;

#[derive(Debug, Deserialize)]
struct RawMotionMetaFade {
    #[serde(rename = "FadeInTime")]
    fade_in_time: Option<f32>,
    #[serde(rename = "FadeOutTime")]
    fade_out_time: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct RawMotionFadeDoc {
    #[serde(rename = "Meta")]
    meta: Option<RawMotionMetaFade>,
}

/// Loaded `.motion3.json` clip together with resolved default fade times from both `.motion3.json` and `.model3.json`.
#[derive(Debug, Clone)]
pub struct LoadedMotion {
    pub motion: Motion3,
    pub default_fade_in_seconds: f32,
    pub default_fade_out_seconds: f32,
}

impl LoadedMotion {
    pub fn load(
        path: &Path,
        manifest_fade_in: Option<f32>,
        manifest_fade_out: Option<f32>,
    ) -> Result<Self, RendererError> {
        let source = fs::read_to_string(path).map_err(|e| {
            RendererError::ModelLoad(format!("Failed to read motion '{}': {e}", path.display()))
        })?;
        let motion = Motion3::from_json_str(&source).map_err(|e| {
            RendererError::ModelLoad(format!("Failed to parse motion '{}': {e}", path.display()))
        })?;
        let raw: RawMotionFadeDoc = serde_json::from_str(&source).unwrap_or(RawMotionFadeDoc { meta: None });
        let meta_fade_in = raw.meta.as_ref().and_then(|m| m.fade_in_time);
        let meta_fade_out = raw.meta.as_ref().and_then(|m| m.fade_out_time);

        // Mirrors `CubismMotionManager.createMotion`:
        // Prefer motion3 Meta FadeInTime if defined (and >= 0 else 1s), otherwise model3 definition > 0, else 0.5s.
        let default_fade_in_seconds = match meta_fade_in {
            Some(v) if v >= 0.0 => v,
            Some(_) => 1.0,
            None => match manifest_fade_in {
                Some(v) if v > 0.0 => v,
                _ => DEFAULT_MOTION_FADE_SECONDS,
            },
        };
        let default_fade_out_seconds = match meta_fade_out {
            Some(v) if v >= 0.0 => v,
            Some(_) => 1.0,
            None => match manifest_fade_out {
                Some(v) if v > 0.0 => v,
                _ => DEFAULT_MOTION_FADE_SECONDS,
            },
        };

        Ok(Self {
            motion,
            default_fade_in_seconds,
            default_fade_out_seconds,
        })
    }
}

/// Active queued motion matching `CubismMotionQueueEntry` + `CubismMotion`.
#[derive(Debug, Clone)]
pub struct ActiveMotionEntry {
    motion: Motion3,
    fade_in_seconds: f32,
    fade_out_seconds: f32,
    is_loop: bool,
    ignore_param_ids: Vec<String>,
    eye_blink_ids: Vec<String>,
    lip_sync_ids: Vec<String>,
    started: bool,
    finished: bool,
    start_time_seconds: f32,
    fade_in_start_time_seconds: f32,
    end_time_seconds: f32,
}

impl ActiveMotionEntry {
    pub fn new(
        loaded: &LoadedMotion,
        ignore_param_ids: &[&str],
        loop_override: Option<bool>,
        eye_blink_ids: Vec<String>,
        lip_sync_ids: Vec<String>,
    ) -> Self {
        let is_loop = loop_override.unwrap_or_else(|| loaded.motion.meta().is_looping());
        Self {
            motion: loaded.motion.clone(),
            fade_in_seconds: loaded.default_fade_in_seconds,
            fade_out_seconds: loaded.default_fade_out_seconds,
            is_loop,
            ignore_param_ids: ignore_param_ids.iter().map(|s| (*s).to_string()).collect(),
            eye_blink_ids,
            lip_sync_ids,
            started: false,
            finished: false,
            start_time_seconds: 0.0,
            fade_in_start_time_seconds: 0.0,
            end_time_seconds: -1.0,
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    fn setup_if_needed(&mut self, user_time_seconds: f32) {
        if self.started {
            return;
        }
        self.started = true;
        self.start_time_seconds = user_time_seconds;
        self.fade_in_start_time_seconds = user_time_seconds;
        let duration = self.motion.meta().duration();
        self.end_time_seconds = if self.is_loop || duration <= 0.0 {
            -1.0
        } else {
            user_time_seconds + duration
        };
    }

    fn fade_weight(&self, user_time_seconds: f32) -> f32 {
        let fade_in = if self.fade_in_seconds <= 0.0 {
            1.0
        } else {
            easing_sine((user_time_seconds - self.fade_in_start_time_seconds) / self.fade_in_seconds)
        };
        let fade_out = if self.fade_out_seconds <= 0.0 || self.end_time_seconds < 0.0 {
            1.0
        } else {
            easing_sine((self.end_time_seconds - user_time_seconds) / self.fade_out_seconds)
        };
        (fade_in * fade_out).clamp(0.0, 1.0)
    }

    pub fn update_parameters(
        &mut self,
        runtime: &mut ModelRuntime,
        user_time_seconds: f32,
        repeat_flags: &[bool],
    ) {
        if self.finished {
            return;
        }
        self.setup_if_needed(user_time_seconds);
        let fade_weight = self.fade_weight(user_time_seconds);
        let time_offset = (user_time_seconds - self.start_time_seconds).max(0.0);

        self.apply_at_time(
            runtime,
            time_offset,
            fade_weight,
            user_time_seconds,
            repeat_flags,
        );

        if self.end_time_seconds > 0.0 && self.end_time_seconds < user_time_seconds {
            self.finished = true;
        }
    }

    /// Evaluates the motion directly at its final timestamp (`fadeWeight = 1.0`) for `playMotionLastFrame`.
    pub fn apply_last_frame(&self, runtime: &mut ModelRuntime, repeat_flags: &[bool]) {
        let duration = self.motion.meta().duration().max(0.0);
        let dummy_now = duration;
        self.apply_at_time_inner(
            runtime,
            duration,
            1.0,
            dummy_now,
            true,
            repeat_flags,
        );
    }

    fn apply_at_time(
        &self,
        runtime: &mut ModelRuntime,
        time_offset_seconds: f32,
        fade_weight: f32,
        user_time_seconds: f32,
        repeat_flags: &[bool],
    ) {
        self.apply_at_time_inner(
            runtime,
            time_offset_seconds,
            fade_weight,
            user_time_seconds,
            false,
            repeat_flags,
        );
    }

    fn apply_at_time_inner(
        &self,
        runtime: &mut ModelRuntime,
        time_offset_seconds: f32,
        fade_weight: f32,
        user_time_seconds: f32,
        force_full_weight: bool,
        repeat_flags: &[bool],
    ) {
        let meta = self.motion.meta();
        let mut duration = meta.duration();
        let fps = if meta.fps() > 0.0 { meta.fps() } else { 30.0 };
        let is_correction = self.is_loop;
        let mut time = time_offset_seconds;
        if self.is_loop && duration > 0.0 {
            duration += 1.0 / fps;
            if duration > 0.0 {
                while time > duration {
                    time -= duration;
                }
            }
        }
        let are_beziers_restricted = meta.are_beziers_restricted();

        let tmp_fade_in = if force_full_weight || self.fade_in_seconds <= 0.0 {
            1.0
        } else {
            easing_sine((user_time_seconds - self.fade_in_start_time_seconds) / self.fade_in_seconds)
        };
        let tmp_fade_out = if force_full_weight
            || self.fade_out_seconds <= 0.0
            || self.end_time_seconds < 0.0
        {
            1.0
        } else {
            easing_sine((self.end_time_seconds - user_time_seconds) / self.fade_out_seconds)
        };

        let mut eye_blink_value: Option<f32> = None;
        let mut lip_sync_value: Option<f32> = None;

        for curve in self.motion.curves() {
            if curve.target() == "Model" && !self.is_ignored(curve.id()) {
                let value =
                    evaluate_curve(curve, time, are_beziers_restricted, is_correction, duration);
                match curve.id() {
                    "EyeBlink" => eye_blink_value = Some(value),
                    "LipSync" => lip_sync_value = Some(value),
                    _ => {}
                }
            }
        }

        let mut eye_blink_flags: u64 = 0;
        let mut lip_sync_flags: u64 = 0;

        for curve in self.motion.curves() {
            if self.is_ignored(curve.id()) {
                continue;
            }
            match curve.target() {
                "Parameter" => {
                    let Some(param_idx) = runtime.parameter_index(curve.id()) else {
                        continue;
                    };
                    let source_value = runtime.parameter_value_by_index(param_idx).unwrap_or(0.0);
                    let mut value =
                        evaluate_curve(curve, time, are_beziers_restricted, is_correction, duration);

                    if let Some(eb) = eye_blink_value {
                        for (i, id) in self.eye_blink_ids.iter().take(64).enumerate() {
                            if id == curve.id() {
                                value *= eb;
                                eye_blink_flags |= 1_u64 << i;
                                break;
                            }
                        }
                    }
                    if let Some(ls) = lip_sync_value {
                        for (i, id) in self.lip_sync_ids.iter().take(64).enumerate() {
                            if id == curve.id() {
                                value += ls;
                                lip_sync_flags |= 1_u64 << i;
                                break;
                            }
                        }
                    }

                    if repeat_flags.get(param_idx).copied().unwrap_or(false) {
                        value = repeat_param_value(runtime, param_idx, value);
                    }

                    let curve_weight = if force_full_weight {
                        1.0
                    } else {
                        match (curve.fade_in_time(), curve.fade_out_time()) {
                            (None, None) => fade_weight,
                            (cfi, cfo) => {
                                let fin = match cfi {
                                    None => tmp_fade_in,
                                    Some(t) if t <= 0.0 => 1.0,
                                    Some(t) => easing_sine(
                                        (user_time_seconds - self.fade_in_start_time_seconds) / t,
                                    ),
                                };
                                let fout = match cfo {
                                    None => tmp_fade_out,
                                    Some(t) if t <= 0.0 || self.end_time_seconds < 0.0 => 1.0,
                                    Some(t) => {
                                        easing_sine((self.end_time_seconds - user_time_seconds) / t)
                                    }
                                };
                                (fin * fout).clamp(0.0, 1.0)
                            }
                        }
                    };
                    let blended = source_value + (value - source_value) * curve_weight;
                    set_clamped_param(runtime, param_idx, blended, repeat_flags);
                }
                "PartOpacity" => {
                    let Some(part_idx) = runtime.part_index(curve.id()) else {
                        continue;
                    };
                    let value =
                        evaluate_curve(curve, time, are_beziers_restricted, is_correction, duration);
                    runtime.set_part_opacity_by_index(part_idx, value.clamp(0.0, 1.0));
                }
                _ => {}
            }
        }

        if let Some(eb) = eye_blink_value {
            let eff_weight = if force_full_weight { 1.0 } else { fade_weight };
            for (i, id) in self.eye_blink_ids.iter().take(64).enumerate() {
                if (eye_blink_flags >> i) & 1 != 0 {
                    continue;
                }
                if let Some(param_idx) = runtime.parameter_index(id) {
                    let source = runtime.parameter_value_by_index(param_idx).unwrap_or(1.0);
                    let next = source + (eb - source) * eff_weight;
                    set_clamped_param(runtime, param_idx, next, repeat_flags);
                }
            }
        }
        if let Some(ls) = lip_sync_value {
            let eff_weight = if force_full_weight { 1.0 } else { fade_weight };
            for (i, id) in self.lip_sync_ids.iter().take(64).enumerate() {
                if (lip_sync_flags >> i) & 1 != 0 {
                    continue;
                }
                if let Some(param_idx) = runtime.parameter_index(id) {
                    let source = runtime.parameter_value_by_index(param_idx).unwrap_or(0.0);
                    let next = source + (ls - source) * eff_weight;
                    set_clamped_param(runtime, param_idx, next, repeat_flags);
                }
            }
        }
    }

    fn is_ignored(&self, id: &str) -> bool {
        self.ignore_param_ids.iter().any(|ignored| ignored == id)
    }
}

/// Manages one track of `ParallelMotionManager` matching `untitled-pixi-live2d-engine`.
#[derive(Debug, Default)]
pub struct ParallelMotionTrack {
    active: Option<ActiveMotionEntry>,
}

impl ParallelMotionTrack {
    pub fn start_motion(
        &mut self,
        loaded: &LoadedMotion,
        ignore_param_ids: &[&str],
        loop_override: Option<bool>,
        eye_blink_ids: Vec<String>,
        lip_sync_ids: Vec<String>,
    ) {
        self.active = Some(ActiveMotionEntry::new(
            loaded,
            ignore_param_ids,
            loop_override,
            eye_blink_ids,
            lip_sync_ids,
        ));
    }

    pub fn play_last_frame(
        &mut self,
        loaded: &LoadedMotion,
        runtime: &mut ModelRuntime,
        eye_blink_ids: Vec<String>,
        lip_sync_ids: Vec<String>,
        repeat_flags: &[bool],
    ) {
        self.active = None;
        let entry = ActiveMotionEntry::new(
            loaded,
            &[],
            Some(false),
            eye_blink_ids,
            lip_sync_ids,
        );
        entry.apply_last_frame(runtime, repeat_flags);
    }

    pub fn stop_all(&mut self) {
        self.active = None;
    }

    pub fn is_finished(&self) -> bool {
        self.active
            .as_ref()
            .map(ActiveMotionEntry::is_finished)
            .unwrap_or(true)
    }

    pub fn update_parameters(
        &mut self,
        runtime: &mut ModelRuntime,
        user_time_seconds: f32,
        repeat_flags: &[bool],
    ) -> bool {
        let Some(entry) = self.active.as_mut() else {
            return false;
        };
        entry.update_parameters(runtime, user_time_seconds, repeat_flags);
        let updated = true;
        if entry.is_finished() {
            self.active = None;
        }
        updated
    }
}

/// Loads all motion groups from `.model3.json` into memory so playback/looping has zero per-frame disk I/O.
pub type MotionBank = HashMap<String, Vec<LoadedMotion>>;

pub fn load_motion_bank(
    model_dir: &Path,
    manifest_motions: &HashMap<String, Vec<super::model::MotionManifestEntry>>,
) -> Result<MotionBank, RendererError> {
    let mut bank = HashMap::with_capacity(manifest_motions.len());
    for (group, entries) in manifest_motions {
        let mut loaded = Vec::with_capacity(entries.len());
        for entry in entries {
            let path = model_dir.join(&entry.file);
            loaded.push(LoadedMotion::load(
                &path,
                entry.fade_in_time,
                entry.fade_out_time,
            )?);
        }
        bank.insert(group.clone(), loaded);
    }
    Ok(bank)
}

pub fn easing_sine(value: f32) -> f32 {
    if value < 0.0 {
        0.0
    } else if value > 1.0 {
        1.0
    } else {
        0.5 - 0.5 * (value * PI).cos()
    }
}

fn evaluate_curve(
    curve: &MotionCurve,
    time: f32,
    are_beziers_restricted: bool,
    is_correction: bool,
    end_time: f32,
) -> f32 {
    let segments = curve.segments();
    if segments.is_empty() {
        return curve.first_point().value;
    }
    if time <= curve.first_point().time {
        return curve.first_point().value;
    }

    for seg in segments {
        let seg_end = seg.end();
        if seg_end.time > time {
            if let Some(sampled) = sample_segment_exact(seg, time, are_beziers_restricted) {
                return sampled;
            }
        }
    }

    let last_seg = segments.last().expect("checked non-empty");
    let last_point = last_seg.end();
    if is_correction && time < end_time {
        return correct_end_point(
            last_seg,
            last_point,
            MotionPoint {
                time: end_time,
                value: curve.first_point().value,
            },
            time,
        );
    }
    last_point.value
}

fn sample_segment_exact(
    seg: &MotionSegment,
    time: f32,
    are_beziers_restricted: bool,
) -> Option<f32> {
    if let Some(v) = seg.sample(time, are_beziers_restricted) {
        return Some(v);
    }
    match seg {
        MotionSegment::Linear { start, end } => Some(linear_eval(*start, *end, time)),
        MotionSegment::Bezier {
            start,
            control1,
            control2,
            end,
        } => {
            if are_beziers_restricted {
                let denom = end.time - start.time;
                let t = if denom.abs() <= f32::EPSILON {
                    0.0
                } else {
                    ((time - start.time) / denom).max(0.0)
                };
                Some(cubic_bezier_1d(
                    start.value,
                    control1.value,
                    control2.value,
                    end.value,
                    t,
                ))
            } else {
                seg.sample(time, false)
            }
        }
        MotionSegment::Stepped { start, .. } => Some(start.value),
        MotionSegment::InverseStepped { end, .. } => Some(end.value),
    }
}

fn correct_end_point(
    last_seg: &MotionSegment,
    begin_point: MotionPoint,
    end_point: MotionPoint,
    time: f32,
) -> f32 {
    match last_seg {
        MotionSegment::Stepped { .. } => begin_point.value,
        MotionSegment::InverseStepped { .. } => end_point.value,
        MotionSegment::Linear { .. } | MotionSegment::Bezier { .. } => {
            linear_eval(begin_point, end_point, time)
        }
    }
}

fn linear_eval(p0: MotionPoint, p1: MotionPoint, time: f32) -> f32 {
    let denom = p1.time - p0.time;
    let t = if denom.abs() <= f32::EPSILON {
        0.0
    } else {
        ((time - p0.time) / denom).max(0.0)
    };
    p0.value + (p1.value - p0.value) * t
}

fn cubic_bezier_1d(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let u = 1.0 - t;
    u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3
}

pub(crate) fn repeat_param_value(runtime: &ModelRuntime, idx: usize, mut value: f32) -> f32 {
    let min = runtime.parameter_minimum_by_index(idx).unwrap_or(-180.0);
    let max = runtime.parameter_maximum_by_index(idx).unwrap_or(180.0);
    let size = max - min;
    if size <= 0.0 || !value.is_finite() {
        return value.clamp(min, max);
    }
    while value > max {
        value -= size;
    }
    while value < min {
        value += size;
    }
    value
}

pub(crate) fn set_clamped_param(
    runtime: &mut ModelRuntime,
    idx: usize,
    value: f32,
    repeat_flags: &[bool],
) {
    let v = if repeat_flags.get(idx).copied().unwrap_or(false) {
        repeat_param_value(runtime, idx, value)
    } else {
        let min = runtime.parameter_minimum_by_index(idx).unwrap_or(f32::NEG_INFINITY);
        let max = runtime.parameter_maximum_by_index(idx).unwrap_or(f32::INFINITY);
        value.clamp(min, max)
    };
    runtime.set_parameter_by_index(idx, v);
}
