use mocari::expression::ExpressionManager;
use mocari::json::{Expression3, ExpressionReference};
use mocari::runtime::ModelRuntime;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::renderer::error::RendererError;

/// Manages named Cubism `.exp3.json` expressions loaded for a model.
#[derive(Debug, Clone)]
pub struct ModelExpressionBank {
    expressions: HashMap<String, Expression3>,
    order: Vec<String>,
    manager: ExpressionManager,
}

impl ModelExpressionBank {
    pub fn load(model_dir: &Path, refs: &[ExpressionReference]) -> Result<Self, RendererError> {
        let mut expressions = HashMap::with_capacity(refs.len());
        let mut order = Vec::with_capacity(refs.len());

        for item in refs {
            let exp_path = model_dir.join(item.file());
            let source = fs::read_to_string(&exp_path).map_err(|e| {
                RendererError::ModelLoad(format!(
                    "Failed to read expression '{}': {e}",
                    exp_path.display()
                ))
            })?;
            let parsed = Expression3::from_json_str(&source).map_err(|e| {
                RendererError::ModelLoad(format!(
                    "Failed to parse expression '{}': {e}",
                    exp_path.display()
                ))
            })?;
            expressions.insert(item.name().to_string(), parsed);
            order.push(item.name().to_string());
        }

        Ok(Self {
            expressions,
            order,
            manager: ExpressionManager::new(),
        })
    }

    pub fn set_expression(&mut self, name: &str) -> Result<(), RendererError> {
        let Some(expr) = self.expressions.get(name) else {
            return Err(RendererError::ModelLoad(format!(
                "Unknown expression '{name}'"
            )));
        };
        self.manager.play(expr.clone());
        Ok(())
    }

    pub fn set_expression_by_index(&mut self, index: usize) -> Result<(), RendererError> {
        let Some(name) = self.order.get(index).cloned() else {
            return Err(RendererError::ModelLoad(format!(
                "Expression index out of bounds: {index}"
            )));
        };
        self.set_expression(&name)
    }

    pub fn reset_expression(&mut self) {
        self.manager.stop_all();
    }

    pub fn update(&mut self, runtime: &mut ModelRuntime, delta_seconds: f32) {
        if self.manager.is_empty() {
            return;
        }
        self.manager.tick(delta_seconds.max(0.0));
        self.manager.apply(runtime);
    }
}
