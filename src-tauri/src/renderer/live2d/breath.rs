use mocari::runtime::ModelRuntime;
use std::f32::consts::TAU;

use super::BREATH_DEPTH;

#[derive(Debug, Clone)]
pub struct BreathParameter {
    pub param_id: String,
    pub offset: f32,
    pub peak: f32,
    pub cycle: f32,
    pub weight: f32,
}

/// Deterministic port of `CubismBreath` initialized with `breathDepth: 0.0` as configured in `src/lib/live2d.ts`.
#[derive(Debug, Clone)]
pub struct CubismBreath {
    current_time: f32,
    params: Vec<BreathParameter>,
}

impl CubismBreath {
    pub fn with_default_sekai_params() -> Self {
        let depth = BREATH_DEPTH;
        Self {
            current_time: 0.0,
            params: vec![
                BreathParameter {
                    param_id: "ParamAngleX".to_string(),
                    offset: 0.0,
                    peak: 15.0 * depth,
                    cycle: 6.5345,
                    weight: 0.5,
                },
                BreathParameter {
                    param_id: "ParamAngleY".to_string(),
                    offset: 0.0,
                    peak: 8.0 * depth,
                    cycle: 3.5345,
                    weight: 0.5,
                },
                BreathParameter {
                    param_id: "ParamAngleZ".to_string(),
                    offset: 0.0,
                    peak: 10.0 * depth,
                    cycle: 5.5345,
                    weight: 0.5,
                },
                BreathParameter {
                    param_id: "ParamBodyAngleX".to_string(),
                    offset: 0.0,
                    peak: 4.0 * depth,
                    cycle: 15.5345,
                    weight: 0.5,
                },
                BreathParameter {
                    param_id: "ParamBreath".to_string(),
                    offset: 0.0,
                    peak: 0.5,
                    cycle: 3.2345,
                    weight: 0.5,
                },
            ],
        }
    }

    pub fn update_parameters(&mut self, runtime: &mut ModelRuntime, delta_seconds: f32) {
        if delta_seconds > 0.0 {
            self.current_time += delta_seconds;
        }
        let t = self.current_time * TAU;
        for param in &self.params {
            let Some(idx) = runtime.parameter_index(&param.param_id) else {
                continue;
            };
            let current = runtime.parameter_value_by_index(idx).unwrap_or(0.0);
            let min = runtime.parameter_minimum_by_index(idx).unwrap_or(-30.0);
            let max = runtime.parameter_maximum_by_index(idx).unwrap_or(30.0);
            let delta = param.offset + param.peak * (t / param.cycle).sin();
            let next = (current + delta * param.weight).clamp(min, max);
            runtime.set_parameter_by_index(idx, next);
        }
    }
}
