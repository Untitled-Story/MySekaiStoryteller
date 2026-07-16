use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::{data_dir, read_json_file};

fn default_model_registry_json() -> Value {
    serde_json::json!({
        "version": 1,
        "models": {}
    })
}

fn model_registry_from_dirs(models_dir: &Path) -> Result<Value, String> {
    let mut models = serde_json::Map::new();

    if !models_dir.exists() {
        return Ok(default_model_registry_json());
    }

    let entries = fs::read_dir(models_dir).map_err(|error| error.to_string())?;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let model_id = entry.file_name().to_string_lossy().to_string();
        let Some(model_entry) = find_model_entry_file(&entry.path())? else {
            continue;
        };
        let (motions, facials) = read_json_file(&entry.path().join(&model_entry))
            .map(|entry_json| motion_catalog_from_json(&entry_json))
            .unwrap_or_default();

        models.insert(
            model_id,
            serde_json::json!({
                "entry": model_entry,
                "motions": motions,
                "facials": facials
            }),
        );
    }

    Ok(Value::Object(serde_json::Map::from_iter([
        ("version".to_string(), serde_json::json!(1)),
        ("models".to_string(), Value::Object(models)),
    ])))
}

fn find_model_entry_file(model_dir: &Path) -> Result<Option<String>, String> {
    let entries = fs::read_dir(model_dir).map_err(|error| error.to_string())?;
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
            is_model_entry_name(&file_name).then_some(file_name)
        })
        .collect();

    model_entries.sort();
    Ok(model_entries.into_iter().next())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModelResult {
    pub model_id: String,
    pub registry: Value,
}

#[tauri::command]
pub fn get_model_registry(app: AppHandle) -> Result<Value, String> {
    let models_dir = data_dir(&app)?.join("models");
    let file_path = models_dir.join("index.json");
    let mut scanned = model_registry_from_dirs(&models_dir)?;
    if !file_path.exists() {
        return Ok(scanned);
    }

    let stored = read_json_file(&file_path)?;
    let stored_models = stored.get("models").and_then(Value::as_object);
    let scanned_models = scanned
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "全局模型注册表格式无效".to_string())?;
    for (model_id, scanned_entry) in scanned_models.iter_mut() {
        let stored_name = stored_models
            .and_then(|models| models.get(model_id))
            .and_then(|entry| entry.get("name"))
            .and_then(Value::as_str);
        if let (Some(name), Some(entry)) = (stored_name, scanned_entry.as_object_mut()) {
            entry.insert("name".to_string(), Value::String(name.to_string()));
        }
    }
    Ok(scanned)
}

#[tauri::command]
pub fn import_global_model(
    app: AppHandle,
    source_path: String,
    name: Option<String>,
) -> Result<ImportedModelResult, String> {
    let source_entry = PathBuf::from(source_path);
    if !source_entry.is_file() {
        return Err("选择的模型入口不存在或不是普通文件".into());
    }
    if fs::symlink_metadata(&source_entry)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("模型入口不能是符号链接".into());
    }

    let entry_name = source_entry
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "模型入口文件名无效".to_string())?;
    if !is_model_entry_name(entry_name) {
        return Err("请选择 *.model3.json 或 *.model.json".into());
    }
    let raw_entry =
        fs::read_to_string(&source_entry).map_err(|error| format!("读取模型入口失败: {error}"))?;
    let entry_json: Value =
        serde_json::from_str(&raw_entry).map_err(|error| format!("模型入口 JSON 无效: {error}"))?;
    if !entry_json.is_object() {
        return Err("模型入口 JSON 必须是对象".into());
    }

    let source_dir = source_entry
        .parent()
        .ok_or_else(|| "无法确定模型目录".to_string())?
        .canonicalize()
        .map_err(|error| format!("读取模型目录失败: {error}"))?;
    let models_dir = data_dir(&app)?.join("models");
    fs::create_dir_all(&models_dir).map_err(|error| format!("创建全局模型目录失败: {error}"))?;
    let canonical_models_dir = models_dir
        .canonicalize()
        .map_err(|error| format!("读取全局模型目录失败: {error}"))?;
    if source_dir.starts_with(&canonical_models_dir) {
        return Err("该模型已位于全局 models 目录，请从已有模型中选择".into());
    }

    let directory_name = source_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("model");
    let model_id = next_model_id(&models_dir, &normalize_model_id(directory_name));
    let destination = models_dir.join(&model_id);
    let temporary = models_dir.join(format!(".import-{}", unique_suffix()));
    let mut registry = get_model_registry(app)?;
    let models = registry
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "全局模型注册表格式无效".to_string())?;
    let mut registry_entry =
        serde_json::Map::from_iter([("entry".to_string(), Value::String(entry_name.to_string()))]);
    let (motions, facials) = motion_catalog_from_json(&entry_json);
    registry_entry.insert("motions".to_string(), serde_json::json!(motions));
    registry_entry.insert("facials".to_string(), serde_json::json!(facials));
    if let Some(display_name) = name.filter(|value| !value.trim().is_empty()) {
        registry_entry.insert("name".to_string(), Value::String(display_name));
    }
    models.insert(model_id.clone(), Value::Object(registry_entry));

    copy_model_directory(&source_dir, &temporary)?;

    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!("保存全局模型失败: {error}"));
    }

    if let Err(error) = write_model_registry(&models_dir, &registry) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }

    Ok(ImportedModelResult { model_id, registry })
}

fn is_model_entry_name(file_name: &str) -> bool {
    let normalized = file_name.to_ascii_lowercase();
    normalized.ends_with(".model3.json")
        || normalized == "model.json"
        || normalized.ends_with(".model.json")
}

fn motion_catalog_from_json(entry: &Value) -> (Vec<String>, Vec<String>) {
    let groups = entry
        .get("FileReferences")
        .and_then(|references| references.get("Motions"))
        .or_else(|| entry.get("Motions"))
        .or_else(|| entry.get("motions"))
        .and_then(Value::as_object);
    let Some(groups) = groups else {
        return (Vec::new(), Vec::new());
    };

    let mut motions = Vec::new();
    let mut facials = Vec::new();
    for name in groups.keys() {
        if name.to_ascii_lowercase().starts_with("face_") {
            facials.push(name.clone());
        } else {
            motions.push(name.clone());
        }
    }
    motions.sort();
    facials.sort();
    (motions, facials)
}

fn normalize_model_id(value: &str) -> String {
    let mut normalized = String::new();
    let mut previous_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            previous_separator = false;
        } else if matches!(character, '-' | '_') {
            normalized.push(character);
            previous_separator = false;
        } else if !previous_separator {
            normalized.push('-');
            previous_separator = true;
        }
    }

    let trimmed = normalized.trim_matches(['-', '_']);
    if trimmed.is_empty() {
        "model".to_string()
    } else {
        trimmed.chars().take(128).collect()
    }
}

fn next_model_id(models_dir: &Path, base: &str) -> String {
    let mut index: u32 = 1;
    loop {
        let candidate = if index == 1 {
            base.to_string()
        } else {
            format!("{base}-{index}")
        };
        if !models_dir.join(&candidate).exists() {
            return candidate;
        }
        index = index.saturating_add(1);
    }
}

fn copy_model_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|error| format!("创建模型导入目录失败: {error}"))?;
    let result = (|| -> Result<(), String> {
        for entry in fs::read_dir(source).map_err(|error| format!("读取模型目录失败: {error}"))?
        {
            let entry = entry.map_err(|error| format!("读取模型文件失败: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("读取模型文件类型失败: {error}"))?;
            let target = destination.join(entry.file_name());
            if file_type.is_symlink() {
                return Err(format!(
                    "模型目录不能包含符号链接: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                copy_model_directory(&entry.path(), &target)?;
            } else if file_type.is_file() {
                fs::copy(entry.path(), target)
                    .map_err(|error| format!("复制模型文件失败: {error}"))?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

fn write_model_registry(models_dir: &Path, registry: &Value) -> Result<(), String> {
    let index_path = models_dir.join("index.json");
    let suffix = unique_suffix();
    let temporary_path = models_dir.join(format!(".index-{suffix}.json"));
    let backup_path = models_dir.join(format!(".index-{suffix}.backup"));
    let serialized = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("序列化模型注册表失败: {error}"))?;
    fs::write(&temporary_path, serialized)
        .map_err(|error| format!("写入模型注册表失败: {error}"))?;
    let had_existing_index = index_path.exists();
    if had_existing_index {
        fs::rename(&index_path, &backup_path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            format!("替换模型注册表失败: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&temporary_path, &index_path) {
        if had_existing_index {
            let _ = fs::rename(&backup_path, &index_path);
        }
        return Err(format!("保存模型注册表失败: {error}"));
    }
    if had_existing_index {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

fn unique_suffix() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{timestamp}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::{is_model_entry_name, motion_catalog_from_json, next_model_id, normalize_model_id};
    use serde_json::json;
    use std::fs;

    #[test]
    fn accepts_live2d_entry_names() {
        assert!(is_model_entry_name("Hatsune.model3.json"));
        assert!(is_model_entry_name("model.json"));
        assert!(!is_model_entry_name("settings.json"));
    }

    #[test]
    fn normalizes_and_resolves_model_id_conflicts() {
        let root = std::env::temp_dir().join(format!("mss-model-test-{}", super::unique_suffix()));
        fs::create_dir_all(root.join("my-model")).expect("create test model directory");
        assert_eq!(normalize_model_id("My Model!"), "my-model");
        assert_eq!(next_model_id(&root, "my-model"), "my-model-2");
        fs::remove_dir_all(root).expect("remove test model directory");
    }

    #[test]
    fn indexes_motion_and_facial_groups() {
        let entry = json!({
            "FileReferences": {
                "Motions": {
                    "w-adult-think01": [{ "File": "motions/body.motion3.json" }],
                    "face_smile_01": [{ "File": "motions/face.motion3.json" }]
                }
            }
        });
        let (motions, facials) = motion_catalog_from_json(&entry);
        assert_eq!(motions, vec!["w-adult-think01"]);
        assert_eq!(facials, vec!["face_smile_01"]);
    }
}
