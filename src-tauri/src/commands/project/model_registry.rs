use std::fs;
use std::path::Path;
use tauri::AppHandle;

use super::{data_dir, read_json_file};

fn default_model_registry_json() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "models": {}
    })
}

fn model_registry_from_dirs(models_dir: &Path) -> Result<serde_json::Value, String> {
    let mut models = serde_json::Map::new();

    if !models_dir.exists() {
        return Ok(default_model_registry_json());
    }

    let entries = fs::read_dir(models_dir).map_err(|e| e.to_string())?;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let model_id = entry.file_name().to_string_lossy().to_string();
        let Some(model_entry) = find_model_entry_file(&entry.path())? else {
            continue;
        };

        models.insert(
            model_id,
            serde_json::json!({
                "entry": model_entry
            }),
        );
    }

    Ok(serde_json::Value::Object(serde_json::Map::from_iter([
        ("version".to_string(), serde_json::json!(1)),
        ("models".to_string(), serde_json::Value::Object(models)),
    ])))
}

fn find_model_entry_file(model_dir: &Path) -> Result<Option<String>, String> {
    let entries = fs::read_dir(model_dir).map_err(|e| e.to_string())?;
    let mut model_entries: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            file_name.ends_with(".model3.json").then_some(file_name)
        })
        .collect();

    model_entries.sort();
    Ok(model_entries.into_iter().next())
}

#[tauri::command]
pub fn get_model_registry(app: AppHandle) -> Result<serde_json::Value, String> {
    let models_dir = data_dir(&app)?.join("models");
    let file_path = models_dir.join("index.json");
    if !file_path.exists() {
        return model_registry_from_dirs(&models_dir);
    }

    read_json_file(&file_path)
}
