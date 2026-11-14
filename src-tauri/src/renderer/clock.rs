use std::collections::BTreeMap;

pub type TaskId = u64;

/// Deterministic discrete playback clock matching `StoryPlaybackClock` (`src/story/playbackClock.ts`).
///
/// Crucially:
/// - `animate(time_ms < 30.0)` resolves immediately (progress 0 -> 1) without advancing frames.
/// - `delay(time_ms <= 0.0)` resolves immediately.
/// - Single `advance(raw_delta_ms)` clamps to `[0.0, 20.0]`, while `advance_frame(frame_dt_ms)` substeps
///   uniformly at `<= 16.6667ms` so real-time speed stays exact at any FPS (30/60/120).
#[derive(Debug)]
pub struct DeterministicClock {
    next_id: TaskId,
    now_ms: f64,
    tasks: BTreeMap<TaskId, ClockTask>,
}

#[derive(Debug)]
enum ClockTaskKind {
    Delay {
        elapsed_ms: f64,
        duration_ms: f64,
    },
    Animate {
        elapsed_ms: f64,
        duration_ms: f64,
        progress: f32,
        callback_id: TaskId,
    },
    WaitUntil,
}

#[derive(Debug)]
struct ClockTask {
    kind: ClockTaskKind,
    completed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClockEvent {
    AnimateTick { id: TaskId, progress: f32 },
    TaskCompleted { id: TaskId },
}

impl Default for DeterministicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl DeterministicClock {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            now_ms: 0.0,
            tasks: BTreeMap::new(),
        }
    }

    pub fn now_ms(&self) -> f64 {
        self.now_ms
    }

    pub fn active_task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Schedules a delay task. Returns `None` if `duration_ms <= 0.0` (resolves synchronously).
    pub fn schedule_delay(&mut self, duration_ms: f64) -> Option<TaskId> {
        if !duration_ms.is_finite() || duration_ms <= 0.0 {
            return None;
        }
        let id = self.alloc_id();
        self.tasks.insert(
            id,
            ClockTask {
                kind: ClockTaskKind::Delay {
                    elapsed_ms: 0.0,
                    duration_ms,
                },
                completed: false,
            },
        );
        Some(id)
    }

    /// Schedules an animation task (`StoryPlaybackClock.animate`).
    /// Note that `duration_ms < 30.0` snaps 0 -> 1 synchronously and returns `None`.
    pub fn schedule_animate(&mut self, duration_ms: f64) -> Option<TaskId> {
        if !duration_ms.is_finite() || duration_ms < 30.0 {
            return None;
        }
        let id = self.alloc_id();
        self.tasks.insert(
            id,
            ClockTask {
                kind: ClockTaskKind::Animate {
                    elapsed_ms: 0.0,
                    duration_ms,
                    progress: 0.0,
                    callback_id: id,
                },
                completed: false,
            },
        );
        Some(id)
    }

    /// Registers a polling `waitUntil` task checked after each substep by the dispatcher.
    pub fn schedule_wait_until(&mut self) -> TaskId {
        let id = self.alloc_id();
        self.tasks.insert(
            id,
            ClockTask {
                kind: ClockTaskKind::WaitUntil,
                completed: false,
            },
        );
        id
    }

    pub fn complete_wait_until(&mut self, id: TaskId) {
        self.tasks.remove(&id);
    }

    pub fn cancel_task(&mut self, id: TaskId) {
        self.tasks.remove(&id);
    }

    /// Advances the clock by a single clamped step `min(max(raw_delta_ms, 0), 20)` matching `StoryPlaybackClock`.
    pub fn advance_substep(&mut self, raw_delta_ms: f64) -> Vec<ClockEvent> {
        let delta_ms = raw_delta_ms.clamp(0.0, 20.0);
        self.now_ms += delta_ms;

        let ids: Vec<TaskId> = self.tasks.keys().copied().collect();
        let mut events = Vec::new();
        let mut finished = Vec::new();

        for id in ids {
            let Some(task) = self.tasks.get_mut(&id) else {
                continue;
            };
            match &mut task.kind {
                ClockTaskKind::Delay {
                    elapsed_ms,
                    duration_ms,
                } => {
                    *elapsed_ms += delta_ms;
                    if *elapsed_ms + 1e-6 >= *duration_ms {
                        task.completed = true;
                        finished.push(id);
                    }
                }
                ClockTaskKind::Animate {
                    elapsed_ms,
                    duration_ms,
                    progress,
                    callback_id,
                } => {
                    *elapsed_ms = (*elapsed_ms + delta_ms).min(*duration_ms);
                    let next = if *elapsed_ms + 1e-6 >= *duration_ms {
                        1.0
                    } else {
                        (*elapsed_ms / *duration_ms) as f32
                    };
                    *progress = next.clamp(0.0, 1.0);
                    events.push(ClockEvent::AnimateTick {
                        id: *callback_id,
                        progress: *progress,
                    });
                    if *progress >= 1.0 {
                        task.completed = true;
                        finished.push(id);
                    }
                }
                ClockTaskKind::WaitUntil => {}
            }
        }

        for id in finished {
            self.tasks.remove(&id);
            events.push(ClockEvent::TaskCompleted { id });
        }

        events
    }

    /// Computes uniform substep count for a frame duration `1000.0 / fps` so each substep is `<= 16.6667ms`.
    pub fn substeps_for_frame(frame_dt_ms: f64) -> u32 {
        if frame_dt_ms <= 0.0 {
            return 1;
        }
        (frame_dt_ms / 16.666_666_666_666_668).ceil().max(1.0) as u32
    }

    fn alloc_id(&mut self) -> TaskId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_30ms_animation_resolves_synchronously() {
        let mut clock = DeterministicClock::new();
        assert!(clock.schedule_animate(0.0).is_none());
        assert!(clock.schedule_animate(29.9).is_none());
        assert!(clock.schedule_animate(30.0).is_some());
    }

    #[test]
    fn delay_completes_exactly_after_accumulated_substeps() {
        let mut clock = DeterministicClock::new();
        let id = clock.schedule_delay(100.0).unwrap();
        let dt = 1000.0 / 60.0;
        let mut completed = false;
        for step in 0..6 {
            let events = clock.advance_substep(dt);
            if events.contains(&ClockEvent::TaskCompleted { id }) {
                assert_eq!(step, 5);
                completed = true;
            }
        }
        assert!(completed);
    }

    #[test]
    fn substep_count_matches_30fps_and_60fps() {
        assert_eq!(DeterministicClock::substeps_for_frame(1000.0 / 60.0), 1);
        assert_eq!(DeterministicClock::substeps_for_frame(1000.0 / 30.0), 2);
    }
}
