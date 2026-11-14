use std::collections::HashMap;

use super::clock::{ClockEvent, DeterministicClock, TaskId};
use super::error::RendererError;
use super::story::{
    parse_hex_color, Curve, EffectTargetData, LayoutMode, PositionData, SnippetData, StoryData,
    VisualEffectData,
};

pub const MODEL_SHOW_TIME_MS: f64 = 200.0;
pub const MODEL_HIDE_TIME_MS: f64 = 50.0;
pub const MOTION_START_DELAY_MS: f64 = 10.0;
pub const DIALOGUE_SHOW_TIME_MS: f64 = 200.0;
pub const DIALOGUE_HIDE_TIME_MS: f64 = 200.0;
pub const DIALOGUE_CHAR_TIME_MS: f64 = 70.0;
pub const TELOP_SHOW_TIME_MS: f64 = 200.0;
pub const TELOP_HOLD_TIME_MS: f64 = 2000.0;
pub const TELOP_HIDE_TIME_MS: f64 = 200.0;

/// Scene side-effects interface driven by the deterministic story dispatcher.
pub trait SceneDriver {
    fn set_layout_mode(&mut self, mode: LayoutMode);
    fn set_background(&mut self, bg_key: &str) -> Result<(), RendererError>;

    fn attach_or_show_model(
        &mut self,
        model_key: &str,
        position: &PositionData,
        hologram: bool,
        motion: Option<&str>,
        facial: Option<&str>,
    ) -> Result<(), RendererError>;

    fn model_alpha(&self, model_key: &str) -> Option<f32>;
    fn set_model_alpha(&mut self, model_key: &str, alpha: f32);
    fn detach_model(&mut self, model_key: &str);
    fn set_model_position(
        &mut self,
        model_key: &str,
        from: &PositionData,
        to: &PositionData,
        progress: f32,
    ) -> Result<(), RendererError>;
    fn start_model_motion(
        &mut self,
        model_key: &str,
        motion: Option<&str>,
        facial: Option<&str>,
        ignore_eye_params: bool,
    ) -> Result<(), RendererError>;
    fn is_model_motion_finished(&self, model_key: &str) -> bool;
    fn close_model_eyes(&mut self, model_key: &str);
    fn set_model_parameter(&mut self, model_key: &str, param_id: &str, value: f32);

    fn is_talk_shown(&self) -> bool;
    fn prepare_dialogue(&mut self, speaker: &str, content: &str);
    fn set_dialogue_visibility(&mut self, visible: bool, alpha: f32);
    fn set_dialogue_text(&mut self, partial_text: &str);
    /// Attempts to start voice playback for `model_key` (or unattached voice); returns voice duration in ms if started.
    fn start_voice(&mut self, model_key: Option<&str>, voice_key: &str, now_ms: f64)
        -> Result<Option<f64>, RendererError>;

    fn prepare_telop(&mut self, content: &str);
    fn set_telop_state(&mut self, visible: bool, alpha: f32, x_offset: f32);

    fn current_fade_alpha(&self) -> f32;
    fn set_fade_state(&mut self, color: Option<[f32; 4]>, visible: bool, alpha: f32);

    fn has_effect(&self, effect_id: &str) -> bool;
    fn apply_effect(
        &mut self,
        effect_id: &str,
        target: &EffectTargetData,
        effect: &VisualEffectData,
    ) -> Result<(), RendererError>;
    fn set_effect_progress(&mut self, effect_id: &str, progress: f32);
    fn remove_effect(&mut self, effect_id: &str);

    /// Advances all scene actors / VFX / Live2D physics/motions by one deterministic substep (`delta_ms` <= 20ms).
    fn tick_scene(&mut self, delta_ms: f64, now_ms: f64);
}

#[derive(Debug, Clone)]
enum AnimateTarget {
    ModelAlpha {
        model_key: String,
        start: f32,
        end: f32,
        detach_on_end: bool,
    },
    ModelMove {
        model_key: String,
        from: PositionData,
        to: PositionData,
    },
    ModelParam {
        model_key: String,
        param_id: String,
        start: f32,
        end: f32,
        curve: Curve,
    },
    DialogueBgFade {
        start: f32,
        end: f32,
        hide_on_end: bool,
    },
    DialogueTypewriter {
        full_utf16: Vec<u16>,
    },
    TelopShow,
    TelopHide,
    ScreenFade {
        start: f32,
        end: f32,
        hide_on_end: bool,
    },
    EffectProgress {
        effect_id: String,
        from: f32,
        to: f32,
        remove_on_end: bool,
    },
}

#[derive(Debug)]
enum CoroutineState {
    /// Delay before executing `snippet` body.
    PreDelay {
        wait_task: TaskId,
        snippet: SnippetData,
    },
    /// Sequential slice executing child `index`, waiting on child coroutine `current`.
    Sequence {
        snippets: Vec<SnippetData>,
        index: usize,
        current: Option<Box<CoroutineState>>,
    },
    /// Parallel set of child coroutines; resolves when all are finished.
    Parallel {
        children: Vec<CoroutineState>,
    },
    /// Leaf waiting for one or more clock tasks / motion finish / voice finish.
    Wait {
        clock_tasks: Vec<TaskId>,
        wait_motions_model: Option<String>,
        wait_voice_end_ms: Option<f64>,
        next_phase: Box<AfterWaitPhase>,
    },
    Finished,
}

#[derive(Debug)]
enum AfterWaitPhase {
    Done,
    LayoutAppearDelayedMotion {
        model_key: String,
        motion: Option<String>,
        facial: Option<String>,
    },
    TalkShowContent {
        content_utf16: Vec<u16>,
        model_key: Option<String>,
        voice_key: Option<String>,
    },
    TelopHold {
        duration_ms: f64,
    },
    TelopHide,
}

/// Deterministic story executor driving snippets synchronously in step with `DeterministicClock`.
#[derive(Debug)]
pub struct StoryRunner {
    clock: DeterministicClock,
    root: CoroutineState,
    pending_actions: Vec<CoroutineState>,
    animations: HashMap<TaskId, AnimateTarget>,
    story_completed: bool,
    all_actions_completed: bool,
}

impl StoryRunner {
    pub fn new(story: StoryData) -> Self {
        let root = CoroutineState::Sequence {
            snippets: story.snippets,
            index: 0,
            current: None,
        };
        Self {
            clock: DeterministicClock::new(),
            root,
            pending_actions: Vec::new(),
            animations: HashMap::new(),
            story_completed: false,
            all_actions_completed: false,
        }
    }

    pub fn now_ms(&self) -> f64 {
        self.clock.now_ms()
    }

    pub fn is_story_finished(&self) -> bool {
        self.story_completed
    }

    pub fn is_fully_idle(&self) -> bool {
        self.all_actions_completed
    }

    /// Initializes the runner before rendering frame 0 (runs synchronous pre-wait steps at `t = 0`).
    pub fn initialize(&mut self, scene: &mut impl SceneDriver) -> Result<(), RendererError> {
        self.drain_coroutines(scene)
    }

    /// Advances simulation for one rendered frame (`frame_dt_ms = 1000.0 / fps`) using uniform substeps `<= 16.6667ms`.
    pub fn step_frame(
        &mut self,
        frame_dt_ms: f64,
        scene: &mut impl SceneDriver,
    ) -> Result<(), RendererError> {
        let substeps = DeterministicClock::substeps_for_frame(frame_dt_ms);
        let substep_ms = frame_dt_ms / substeps as f64;
        for _ in 0..substeps {
            let events = self.clock.advance_substep(substep_ms);
            scene.tick_scene(substep_ms.clamp(0.0, 20.0), self.clock.now_ms());
            self.apply_clock_events(events, scene)?;
            self.drain_coroutines(scene)?;
        }
        Ok(())
    }

    fn apply_clock_events(
        &mut self,
        events: Vec<ClockEvent>,
        scene: &mut impl SceneDriver,
    ) -> Result<(), RendererError> {
        let now_ms = self.clock.now_ms();
        for ev in events {
            match ev {
                ClockEvent::AnimateTick { id, progress } => {
                    if let Some(target) = self.animations.get(&id).cloned() {
                        Self::apply_animation_progress(&target, progress, scene)?;
                    }
                }
                ClockEvent::TaskCompleted { id } => {
                    if let Some(target) = self.animations.remove(&id) {
                        Self::apply_animation_progress(&target, 1.0, scene)?;
                        Self::finalize_animation(&target, scene);
                    }
                    Self::notify_task_completed(&mut self.root, id, now_ms);
                    for action in &mut self.pending_actions {
                        Self::notify_task_completed(action, id, now_ms);
                    }
                }
            }
        }
        Ok(())
    }

    fn notify_task_completed(node: &mut CoroutineState, task_id: TaskId, _now_ms: f64) {
        match node {
            CoroutineState::PreDelay { wait_task, .. } => {
                if *wait_task == task_id {
                    *wait_task = 0;
                }
            }
            CoroutineState::Sequence {
                current: Some(child),
                ..
            } => Self::notify_task_completed(child, task_id, _now_ms),
            CoroutineState::Parallel { children } => {
                for c in children {
                    Self::notify_task_completed(c, task_id, _now_ms);
                }
            }
            CoroutineState::Wait { clock_tasks, .. } => {
                clock_tasks.retain(|&id| id != task_id);
            }
            _ => {}
        }
    }

    fn drain_coroutines(&mut self, scene: &mut impl SceneDriver) -> Result<(), RendererError> {
        // Iterate until no node can make synchronous progress at current `now_ms`.
        loop {
            let mut progressed = false;
            let mut root = std::mem::replace(&mut self.root, CoroutineState::Finished);
            progressed |= self.advance_node(&mut root, scene)?;
            self.root = root;

            let pending_count = self.pending_actions.len();
            for i in 0..pending_count {
                let mut action =
                    std::mem::replace(&mut self.pending_actions[i], CoroutineState::Finished);
                progressed |= self.advance_node(&mut action, scene)?;
                self.pending_actions[i] = action;
            }
            self.pending_actions
                .retain(|node| !matches!(node, CoroutineState::Finished));

            if matches!(self.root, CoroutineState::Finished) {
                self.story_completed = true;
                if self.pending_actions.is_empty() {
                    self.all_actions_completed = true;
                }
            }

            if !progressed {
                break;
            }
        }
        Ok(())
    }

    fn advance_node(
        &mut self,
        node: &mut CoroutineState,
        scene: &mut impl SceneDriver,
    ) -> Result<bool, RendererError> {
        match node {
            CoroutineState::Finished => Ok(false),
            CoroutineState::PreDelay { wait_task, .. } => {
                if *wait_task != 0 {
                    return Ok(false);
                }
                let prev = std::mem::replace(node, CoroutineState::Finished);
                if let CoroutineState::PreDelay { snippet, .. } = prev {
                    *node = self.start_snippet_body(snippet, scene)?;
                    return Ok(true);
                }
                Ok(false)
            }
            CoroutineState::Sequence {
                snippets,
                index,
                current,
            } => {
                if let Some(child) = current.as_mut() {
                    let progressed = self.advance_node(child, scene)?;
                    if matches!(child.as_ref(), CoroutineState::Finished) {
                        *current = None;
                        *index += 1;
                        return Ok(true);
                    }
                    return Ok(progressed);
                }
                if *index >= snippets.len() {
                    *node = CoroutineState::Finished;
                    return Ok(true);
                }
                let next_snippet = snippets[*index].clone();
                let delay_ms = next_snippet.delay_ms();
                let child = if delay_ms > 0.0 {
                    if let Some(wait_task) = self.clock.schedule_delay(delay_ms) {
                        CoroutineState::PreDelay {
                            wait_task,
                            snippet: next_snippet,
                        }
                    } else {
                        self.start_snippet_body(next_snippet, scene)?
                    }
                } else {
                    self.start_snippet_body(next_snippet, scene)?
                };
                *current = Some(Box::new(child));
                Ok(true)
            }
            CoroutineState::Parallel { children } => {
                let mut progressed = false;
                for child in children.iter_mut() {
                    if !matches!(child, CoroutineState::Finished) {
                        progressed |= self.advance_node(child, scene)?;
                    }
                }
                if children
                    .iter()
                    .all(|child| matches!(child, CoroutineState::Finished))
                {
                    *node = CoroutineState::Finished;
                    return Ok(true);
                }
                Ok(progressed)
            }
            CoroutineState::Wait {
                clock_tasks,
                wait_motions_model,
                wait_voice_end_ms,
                ..
            } => {
                if !clock_tasks.is_empty() {
                    return Ok(false);
                }
                if let Some(model_key) = wait_motions_model.as_deref() {
                    if !scene.is_model_motion_finished(model_key) {
                        return Ok(false);
                    }
                }
                if let Some(end_ms) = *wait_voice_end_ms {
                    if self.clock.now_ms() + 1e-6 < end_ms {
                        return Ok(false);
                    }
                }
                let prev = std::mem::replace(node, CoroutineState::Finished);
                if let CoroutineState::Wait { next_phase, .. } = prev {
                    *node = self.transition_after_wait(*next_phase, scene)?;
                    return Ok(true);
                }
                Ok(false)
            }
        }
    }

    fn start_snippet_body(
        &mut self,
        snippet: SnippetData,
        scene: &mut impl SceneDriver,
    ) -> Result<CoroutineState, RendererError> {
        match snippet {
            SnippetData::Parallel { snippets, .. } => {
                let mut children = Vec::with_capacity(snippets.len());
                for child in snippets {
                    let delay_ms = child.delay_ms();
                    if delay_ms > 0.0 {
                        if let Some(wait_task) = self.clock.schedule_delay(delay_ms) {
                            children.push(CoroutineState::PreDelay {
                                wait_task,
                                snippet: child,
                            });
                            continue;
                        }
                    }
                    children.push(self.start_snippet_body(child, scene)?);
                }
                Ok(CoroutineState::Parallel { children })
            }
            SnippetData::ChangeLayoutMode { data, .. } => {
                scene.set_layout_mode(data.mode);
                Ok(CoroutineState::Finished)
            }
            SnippetData::ChangeBackgroundImage { data, .. } => {
                scene.set_background(&data.background)?;
                Ok(CoroutineState::Finished)
            }
            SnippetData::LayoutAppear { data, .. } => {
                scene.attach_or_show_model(
                    &data.model,
                    &data.position,
                    data.hologram,
                    data.motion.as_deref(),
                    data.facial.as_deref(),
                )?;
                let show_task = self.schedule_animation(
                    MODEL_SHOW_TIME_MS,
                    AnimateTarget::ModelAlpha {
                        model_key: data.model.clone(),
                        start: 0.0,
                        end: 1.0,
                        detach_on_end: false,
                    },
                    scene,
                )?;
                if data.motion.is_some() {
                    scene.close_model_eyes(&data.model);
                    let delay_task = self.clock.schedule_delay(MOTION_START_DELAY_MS);
                    let mut pending = match delay_task {
                        Some(id) => CoroutineState::Wait {
                            clock_tasks: vec![id],
                            wait_motions_model: None,
                            wait_voice_end_ms: None,
                            next_phase: Box::new(AfterWaitPhase::LayoutAppearDelayedMotion {
                                model_key: data.model,
                                motion: data.motion,
                                facial: data.facial,
                            }),
                        },
                        None => self.transition_after_wait(
                            AfterWaitPhase::LayoutAppearDelayedMotion {
                                model_key: data.model,
                                motion: data.motion,
                                facial: data.facial,
                            },
                            scene,
                        )?,
                    };
                    let _ = self.advance_node(&mut pending, scene)?;
                    if !matches!(pending, CoroutineState::Finished) {
                        self.pending_actions.push(pending);
                    }
                }
                match show_task {
                    Some(id) => Ok(CoroutineState::Wait {
                        clock_tasks: vec![id],
                        wait_motions_model: None,
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::Done),
                    }),
                    None => Ok(CoroutineState::Finished),
                }
            }
            SnippetData::LayoutClear { data, .. } => {
                let Some(start_alpha) = scene.model_alpha(&data.model) else {
                    return Ok(CoroutineState::Finished);
                };
                let task = self.schedule_animation(
                    MODEL_HIDE_TIME_MS,
                    AnimateTarget::ModelAlpha {
                        model_key: data.model,
                        start: start_alpha,
                        end: 0.0,
                        detach_on_end: true,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::Move { data, .. } => {
                scene.set_model_position(&data.model, &data.from, &data.from, 0.0)?;
                let duration_ms = data.move_speed.duration_ms();
                let task = self.schedule_animation(
                    duration_ms,
                    AnimateTarget::ModelMove {
                        model_key: data.model,
                        from: data.from,
                        to: data.to,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::Motion { data, .. } => {
                if data.motion.is_none() && data.facial.is_none() {
                    return Ok(CoroutineState::Finished);
                }
                scene.start_model_motion(
                    &data.model,
                    data.motion.as_deref(),
                    data.facial.as_deref(),
                    true,
                )?;
                if scene.is_model_motion_finished(&data.model) {
                    Ok(CoroutineState::Finished)
                } else {
                    Ok(CoroutineState::Wait {
                        clock_tasks: Vec::new(),
                        wait_motions_model: Some(data.model),
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::Done),
                    })
                }
            }
            SnippetData::Talk { data, .. } => {
                scene.prepare_dialogue(&data.speaker, &data.content);
                let content_utf16: Vec<u16> = data.content.encode_utf16().collect();
                if !scene.is_talk_shown() {
                    let task = self.schedule_animation(
                        DIALOGUE_SHOW_TIME_MS,
                        AnimateTarget::DialogueBgFade {
                            start: 0.0,
                            end: 1.0,
                            hide_on_end: false,
                        },
                        scene,
                    )?;
                    if let Some(id) = task {
                        return Ok(CoroutineState::Wait {
                            clock_tasks: vec![id],
                            wait_motions_model: None,
                            wait_voice_end_ms: None,
                            next_phase: Box::new(AfterWaitPhase::TalkShowContent {
                                content_utf16,
                                model_key: data.model,
                                voice_key: data.voice,
                            }),
                        });
                    }
                }
                self.transition_after_wait(
                    AfterWaitPhase::TalkShowContent {
                        content_utf16,
                        model_key: data.model,
                        voice_key: data.voice,
                    },
                    scene,
                )
            }
            SnippetData::HideTalk { .. } => {
                if !scene.is_talk_shown() {
                    return Ok(CoroutineState::Finished);
                }
                let task = self.schedule_animation(
                    DIALOGUE_HIDE_TIME_MS,
                    AnimateTarget::DialogueBgFade {
                        start: 1.0,
                        end: 0.0,
                        hide_on_end: true,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::Telop { data, .. } => {
                scene.prepare_telop(&data.content);
                let task = self.schedule_animation(
                    TELOP_SHOW_TIME_MS,
                    AnimateTarget::TelopShow,
                    scene,
                )?;
                match task {
                    Some(id) => Ok(CoroutineState::Wait {
                        clock_tasks: vec![id],
                        wait_motions_model: None,
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::TelopHold {
                            duration_ms: TELOP_HOLD_TIME_MS,
                        }),
                    }),
                    None => self.transition_after_wait(
                        AfterWaitPhase::TelopHold {
                            duration_ms: TELOP_HOLD_TIME_MS,
                        },
                        scene,
                    ),
                }
            }
            SnippetData::DoParam { data, .. } => {
                let mut tasks = Vec::new();
                for param in data.params {
                    let duration_ms = (param.duration.max(0.0)) * 1000.0;
                    if let Some(id) = self.schedule_animation(
                        duration_ms,
                        AnimateTarget::ModelParam {
                            model_key: data.model.clone(),
                            param_id: param.param_id,
                            start: param.start,
                            end: param.end,
                            curve: param.curve,
                        },
                        scene,
                    )? {
                        tasks.push(id);
                    }
                }
                if tasks.is_empty() {
                    Ok(CoroutineState::Finished)
                } else {
                    Ok(CoroutineState::Wait {
                        clock_tasks: tasks,
                        wait_motions_model: None,
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::Done),
                    })
                }
            }
            SnippetData::ScreenFadeOut { data, .. } => {
                let rgba = parse_hex_color(&data.color)?;
                let start = scene.current_fade_alpha();
                scene.set_fade_state(Some(rgba), true, start);
                let task = self.schedule_animation(
                    data.duration.max(0.0) * 1000.0,
                    AnimateTarget::ScreenFade {
                        start,
                        end: 1.0,
                        hide_on_end: false,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::ScreenFadeIn { data, .. } => {
                let start = scene.current_fade_alpha();
                let task = self.schedule_animation(
                    data.duration.max(0.0) * 1000.0,
                    AnimateTarget::ScreenFade {
                        start,
                        end: 0.0,
                        hide_on_end: true,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::ApplyEffect { data, .. } => {
                scene.apply_effect(&data.effect_id, &data.target, &data.effect)?;
                let task = self.schedule_animation(
                    data.duration.max(0.0) * 1000.0,
                    AnimateTarget::EffectProgress {
                        effect_id: data.effect_id,
                        from: 0.0,
                        to: 1.0,
                        remove_on_end: false,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
            SnippetData::RemoveEffect { data, .. } => {
                if !scene.has_effect(&data.effect_id) {
                    return Ok(CoroutineState::Finished);
                }
                let task = self.schedule_animation(
                    data.duration.max(0.0) * 1000.0,
                    AnimateTarget::EffectProgress {
                        effect_id: data.effect_id,
                        from: 1.0,
                        to: 0.0,
                        remove_on_end: true,
                    },
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
        }
    }

    fn transition_after_wait(
        &mut self,
        phase: AfterWaitPhase,
        scene: &mut impl SceneDriver,
    ) -> Result<CoroutineState, RendererError> {
        match phase {
            AfterWaitPhase::Done => Ok(CoroutineState::Finished),
            AfterWaitPhase::LayoutAppearDelayedMotion {
                model_key,
                motion,
                facial,
            } => {
                scene.start_model_motion(
                    &model_key,
                    motion.as_deref(),
                    facial.as_deref(),
                    true,
                )?;
                if scene.is_model_motion_finished(&model_key) {
                    Ok(CoroutineState::Finished)
                } else {
                    Ok(CoroutineState::Wait {
                        clock_tasks: Vec::new(),
                        wait_motions_model: Some(model_key),
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::Done),
                    })
                }
            }
            AfterWaitPhase::TalkShowContent {
                content_utf16,
                model_key,
                voice_key,
            } => {
                let mut clock_tasks = Vec::new();
                let type_duration_ms = (content_utf16.len() as f64) * DIALOGUE_CHAR_TIME_MS;
                if let Some(id) = self.schedule_animation(
                    type_duration_ms,
                    AnimateTarget::DialogueTypewriter {
                        full_utf16: content_utf16,
                    },
                    scene,
                )? {
                    clock_tasks.push(id);
                }

                let mut wait_voice_end_ms = None;
                if let (Some(m_key), Some(v_key)) = (model_key.as_deref(), voice_key.as_deref()) {
                    if let Some(duration_ms) =
                        scene.start_voice(Some(m_key), v_key, self.clock.now_ms())?
                    {
                        if duration_ms > 0.0 {
                            wait_voice_end_ms = Some(self.clock.now_ms() + duration_ms);
                        }
                    }
                }

                if clock_tasks.is_empty() && wait_voice_end_ms.is_none() {
                    Ok(CoroutineState::Finished)
                } else {
                    Ok(CoroutineState::Wait {
                        clock_tasks,
                        wait_motions_model: None,
                        wait_voice_end_ms,
                        next_phase: Box::new(AfterWaitPhase::Done),
                    })
                }
            }
            AfterWaitPhase::TelopHold { duration_ms } => {
                if let Some(id) = self.clock.schedule_delay(duration_ms) {
                    Ok(CoroutineState::Wait {
                        clock_tasks: vec![id],
                        wait_motions_model: None,
                        wait_voice_end_ms: None,
                        next_phase: Box::new(AfterWaitPhase::TelopHide),
                    })
                } else {
                    self.transition_after_wait(AfterWaitPhase::TelopHide, scene)
                }
            }
            AfterWaitPhase::TelopHide => {
                let task = self.schedule_animation(
                    TELOP_HIDE_TIME_MS,
                    AnimateTarget::TelopHide,
                    scene,
                )?;
                Ok(Self::wait_single_task(task))
            }
        }
    }

    fn wait_single_task(task: Option<TaskId>) -> CoroutineState {
        match task {
            Some(id) => CoroutineState::Wait {
                clock_tasks: vec![id],
                wait_motions_model: None,
                wait_voice_end_ms: None,
                next_phase: Box::new(AfterWaitPhase::Done),
            },
            None => CoroutineState::Finished,
        }
    }

    fn schedule_animation(
        &mut self,
        duration_ms: f64,
        target: AnimateTarget,
        scene: &mut impl SceneDriver,
    ) -> Result<Option<TaskId>, RendererError> {
        Self::apply_animation_progress(&target, 0.0, scene)?;
        if let Some(id) = self.clock.schedule_animate(duration_ms) {
            self.animations.insert(id, target);
            Ok(Some(id))
        } else {
            Self::apply_animation_progress(&target, 1.0, scene)?;
            Self::finalize_animation(&target, scene);
            Ok(None)
        }
    }

    fn apply_animation_progress(
        target: &AnimateTarget,
        progress: f32,
        scene: &mut impl SceneDriver,
    ) -> Result<(), RendererError> {
        match target {
            AnimateTarget::ModelAlpha {
                model_key,
                start,
                end,
                ..
            } => {
                let value = start + (end - start) * progress;
                scene.set_model_alpha(model_key, value);
            }
            AnimateTarget::ModelMove {
                model_key,
                from,
                to,
            } => {
                scene.set_model_position(model_key, from, to, progress)?;
            }
            AnimateTarget::ModelParam {
                model_key,
                param_id,
                start,
                end,
                curve,
            } => {
                let eased = curve.apply(progress);
                let value = start + (end - start) * eased;
                scene.set_model_parameter(model_key, param_id, value);
            }
            AnimateTarget::DialogueBgFade { start, end, .. } => {
                let value = start + (end - start) * progress;
                scene.set_dialogue_visibility(true, value);
            }
            AnimateTarget::DialogueTypewriter { full_utf16 } => {
                let len = full_utf16.len();
                let chars = ((progress as f64) * (len as f64)).floor().clamp(0.0, len as f64) as usize;
                let partial = String::from_utf16_lossy(&full_utf16[..chars]);
                scene.set_dialogue_text(&partial);
            }
            AnimateTarget::TelopShow => {
                scene.set_telop_state(true, progress, -10.0 + 10.0 * progress);
            }
            AnimateTarget::TelopHide => {
                scene.set_telop_state(true, 1.0 - progress, 10.0 * progress);
            }
            AnimateTarget::ScreenFade { start, end, .. } => {
                let value = start + (end - start) * progress;
                scene.set_fade_state(None, true, value);
            }
            AnimateTarget::EffectProgress {
                effect_id,
                from,
                to,
                ..
            } => {
                let value = from + (to - from) * progress;
                scene.set_effect_progress(effect_id, value);
            }
        }
        Ok(())
    }

    fn finalize_animation(target: &AnimateTarget, scene: &mut impl SceneDriver) {
        match target {
            AnimateTarget::ModelAlpha {
                model_key,
                detach_on_end: true,
                ..
            } => {
                scene.detach_model(model_key);
            }
            AnimateTarget::DialogueBgFade {
                hide_on_end: true, ..
            } => {
                scene.set_dialogue_visibility(false, 0.0);
            }
            AnimateTarget::TelopHide => {
                scene.set_telop_state(false, 0.0, 0.0);
            }
            AnimateTarget::ScreenFade {
                hide_on_end: true, ..
            } => {
                scene.set_fade_state(None, false, 0.0);
            }
            AnimateTarget::EffectProgress {
                effect_id,
                remove_on_end: true,
                ..
            } => {
                scene.remove_effect(effect_id);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::story::*;

    #[derive(Default)]
    struct MockScene {
        bg: Option<String>,
        models: HashMap<String, f32>,
        talk_shown: bool,
        dialogue_text: String,
        fade_alpha: f32,
        effects: HashMap<String, f32>,
        telop_visible: bool,
        ticks: usize,
    }

    impl SceneDriver for MockScene {
        fn set_layout_mode(&mut self, _mode: LayoutMode) {}
        fn set_background(&mut self, bg_key: &str) -> Result<(), RendererError> {
            self.bg = Some(bg_key.to_string());
            Ok(())
        }
        fn attach_or_show_model(
            &mut self,
            model_key: &str,
            _position: &PositionData,
            _hologram: bool,
            _motion: Option<&str>,
            _facial: Option<&str>,
        ) -> Result<(), RendererError> {
            self.models.insert(model_key.to_string(), 0.0);
            Ok(())
        }
        fn model_alpha(&self, model_key: &str) -> Option<f32> {
            self.models.get(model_key).copied()
        }
        fn set_model_alpha(&mut self, model_key: &str, alpha: f32) {
            self.models.insert(model_key.to_string(), alpha);
        }
        fn detach_model(&mut self, model_key: &str) {
            self.models.remove(model_key);
        }
        fn set_model_position(
            &mut self,
            _model_key: &str,
            _from: &PositionData,
            _to: &PositionData,
            _progress: f32,
        ) -> Result<(), RendererError> {
            Ok(())
        }
        fn start_model_motion(
            &mut self,
            _model_key: &str,
            _motion: Option<&str>,
            _facial: Option<&str>,
            _ignore_eye_params: bool,
        ) -> Result<(), RendererError> {
            Ok(())
        }
        fn is_model_motion_finished(&self, _model_key: &str) -> bool {
            true
        }
        fn close_model_eyes(&mut self, _model_key: &str) {}
        fn set_model_parameter(&mut self, _model_key: &str, _param_id: &str, _value: f32) {}
        fn is_talk_shown(&self) -> bool {
            self.talk_shown
        }
        fn prepare_dialogue(&mut self, _speaker: &str, _content: &str) {
            self.dialogue_text.clear();
        }
        fn set_dialogue_visibility(&mut self, visible: bool, _alpha: f32) {
            self.talk_shown = visible;
        }
        fn set_dialogue_text(&mut self, partial_text: &str) {
            self.dialogue_text = partial_text.to_string();
        }
        fn start_voice(
            &mut self,
            _model_key: Option<&str>,
            _voice_key: &str,
            _now_ms: f64,
        ) -> Result<Option<f64>, RendererError> {
            Ok(Some(500.0))
        }
        fn prepare_telop(&mut self, _content: &str) {}
        fn set_telop_state(&mut self, visible: bool, _alpha: f32, _x_offset: f32) {
            self.telop_visible = visible;
        }
        fn current_fade_alpha(&self) -> f32 {
            self.fade_alpha
        }
        fn set_fade_state(&mut self, _color: Option<[f32; 4]>, _visible: bool, alpha: f32) {
            self.fade_alpha = alpha;
        }
        fn has_effect(&self, effect_id: &str) -> bool {
            self.effects.contains_key(effect_id)
        }
        fn apply_effect(
            &mut self,
            effect_id: &str,
            _target: &EffectTargetData,
            _effect: &VisualEffectData,
        ) -> Result<(), RendererError> {
            self.effects.insert(effect_id.to_string(), 0.0);
            Ok(())
        }
        fn set_effect_progress(&mut self, effect_id: &str, progress: f32) {
            self.effects.insert(effect_id.to_string(), progress);
        }
        fn remove_effect(&mut self, effect_id: &str) {
            self.effects.remove(effect_id);
        }
        fn tick_scene(&mut self, _delta_ms: f64, _now_ms: f64) {
            self.ticks += 1;
        }
    }

    #[test]
    fn talk_waits_for_bg_fade_then_max_of_voice_and_typewriter() {
        // 3 chars * 70ms = 210ms typewriter < 500ms voice, after 200ms bg fade = 700ms total.
        let story = StoryData {
            version: 1,
            snippets: vec![
                SnippetData::ChangeBackgroundImage {
                    id: None,
                    delay: 0.0,
                    data: ChangeBackgroundImageData {
                        background: "bg".into(),
                    },
                },
                SnippetData::Talk {
                    id: None,
                    delay: 0.0,
                    data: TalkData {
                        speaker: "S".into(),
                        content: "你好！".into(),
                        model: Some("m1".into()),
                        voice: Some("v1".into()),
                    },
                },
            ],
        };
        let mut runner = StoryRunner::new(story);
        let mut scene = MockScene::default();
        runner.initialize(&mut scene).unwrap();
        assert_eq!(scene.bg.as_deref(), Some("bg"));
        assert!(!runner.is_story_finished());

        let dt = 1000.0 / 30.0;
        let mut frames = 0;
        while !runner.is_fully_idle() && frames < 100 {
            runner.step_frame(dt, &mut scene).unwrap();
            frames += 1;
        }
        assert!(runner.is_fully_idle());
        assert_eq!(scene.dialogue_text, "你好！");
        // Expect 700ms at 30fps = 21 frames (700 / 33.333 = 21.0)
        assert_eq!(frames, 21);
    }

    #[test]
    fn telop_takes_exactly_2400ms() {
        let story = StoryData {
            version: 1,
            snippets: vec![SnippetData::Telop {
                id: None,
                delay: 0.0,
                data: TelopData {
                    content: "Ep 1".into(),
                },
            }],
        };
        let mut runner = StoryRunner::new(story);
        let mut scene = MockScene::default();
        runner.initialize(&mut scene).unwrap();
        let dt = 1000.0 / 60.0;
        let mut frames = 0;
        while !runner.is_fully_idle() && frames < 300 {
            runner.step_frame(dt, &mut scene).unwrap();
            frames += 1;
        }
        assert!(runner.is_fully_idle());
        assert!(!scene.telop_visible);
        // 200ms + 2000ms + 200ms = 2400ms => 144 frames at 60fps.
        assert_eq!(frames, 144);
    }
}
