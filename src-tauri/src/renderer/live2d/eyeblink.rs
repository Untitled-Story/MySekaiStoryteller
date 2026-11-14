use mocari::runtime::ModelRuntime;
use rand::Rng;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EyeState {
    First,
    Interval,
    Closing,
    Closed,
    Opening,
}

/// Deterministic port of `CubismEyeBlink` (closing 0.1s, closed 0.05s, opening 0.15s, interval 4s).
#[derive(Debug, Clone)]
pub struct CubismEyeBlink {
    state: EyeState,
    next_blinking_time: f32,
    state_start_time_seconds: f32,
    blinking_interval_seconds: f32,
    closing_seconds: f32,
    closed_seconds: f32,
    opening_seconds: f32,
    user_time_seconds: f32,
    parameter_ids: Vec<String>,
    rng: ChaCha8Rng,
}

impl CubismEyeBlink {
    pub fn new(parameter_ids: Vec<String>, seed: u64) -> Self {
        Self {
            state: EyeState::First,
            next_blinking_time: 0.0,
            state_start_time_seconds: 0.0,
            blinking_interval_seconds: 4.0,
            closing_seconds: 0.1,
            closed_seconds: 0.05,
            opening_seconds: 0.15,
            user_time_seconds: 0.0,
            parameter_ids,
            rng: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    pub fn parameter_ids(&self) -> &[String] {
        &self.parameter_ids
    }

    fn determine_next_blinking_timing(&mut self) -> f32 {
        let r: f32 = self.rng.random();
        self.user_time_seconds + r * (2.0 * self.blinking_interval_seconds - 1.0)
    }

    pub fn update_parameters(&mut self, runtime: &mut ModelRuntime, delta_seconds: f32) {
        self.user_time_seconds += delta_seconds.max(0.0);

        let parameter_value = match self.state {
            EyeState::Closing => {
                let mut t =
                    (self.user_time_seconds - self.state_start_time_seconds) / self.closing_seconds;
                if t >= 1.0 {
                    t = 1.0;
                    self.state = EyeState::Closed;
                    self.state_start_time_seconds = self.user_time_seconds;
                }
                1.0 - t
            }
            EyeState::Closed => {
                let t =
                    (self.user_time_seconds - self.state_start_time_seconds) / self.closed_seconds;
                if t >= 1.0 {
                    self.state = EyeState::Opening;
                    self.state_start_time_seconds = self.user_time_seconds;
                }
                0.0
            }
            EyeState::Opening => {
                let mut t =
                    (self.user_time_seconds - self.state_start_time_seconds) / self.opening_seconds;
                if t >= 1.0 {
                    t = 1.0;
                    self.state = EyeState::Interval;
                    self.next_blinking_time = self.determine_next_blinking_timing();
                }
                t
            }
            EyeState::Interval => {
                if self.next_blinking_time < self.user_time_seconds {
                    self.state = EyeState::Closing;
                    self.state_start_time_seconds = self.user_time_seconds;
                }
                1.0
            }
            EyeState::First => {
                self.state = EyeState::Interval;
                self.next_blinking_time = self.determine_next_blinking_timing();
                1.0
            }
        };

        for id in &self.parameter_ids {
            if let Some(idx) = runtime.parameter_index(id) {
                let min = runtime.parameter_minimum_by_index(idx).unwrap_or(0.0);
                let max = runtime.parameter_maximum_by_index(idx).unwrap_or(1.0);
                runtime.set_parameter_by_index(idx, parameter_value.clamp(min, max));
            }
        }
    }
}
