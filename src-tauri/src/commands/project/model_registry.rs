use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use zip::ZipArchive;

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
        let (motions, facials): (Vec<String>, Vec<String>) = if is_image_entry_name(&model_entry) {
            Default::default()
        } else {
            read_json_file(&entry.path().join(&model_entry))
                .map(|entry_json: Value| motion_catalog_from_json(&entry_json))
                .unwrap_or_default()
        };
        models.insert(
            model_id,
            serde_json::json!({
                "entry": model_entry,
                "motions": motions,
                "facials": facials,
            }),
        );
    }

    Ok(Value::Object(serde_json::Map::from_iter([
        ("version".to_string(), serde_json::json!(1)),
        ("models".to_string(), Value::Object(models)),
    ])))
}

/// Lists the root files of a model directory accepted by `predicate`, sorted by name.
fn root_files_matching(
    model_dir: &Path,
    predicate: fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(model_dir).map_err(|error| error.to_string())?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let file_name: String = entry.file_name().to_string_lossy().to_string();
            predicate(&file_name).then_some(file_name)
        })
        .collect();
    names.sort();
    Ok(names)
}

/// A Live2D model directory also holds texture images at its root, so a static image is only
/// the entry when no Live2D entry exists.
pub(crate) fn find_unique_model_entry_file(model_dir: &Path) -> Result<String, String> {
    let mut model_entries = root_files_matching(model_dir, is_live2d_entry_name)?;
    if model_entries.is_empty() {
        model_entries = root_files_matching(model_dir, is_image_entry_name)?;
    }
    match model_entries.len() {
        1 => Ok(model_entries.remove(0)),
        0 => Err(format!("模型目录缺少模型入口: {}", model_dir.display())),
        _ => Err(format!(
            "模型目录包含多个模型入口，无法确定要使用的模型: {}",
            model_dir.display()
        )),
    }
}

pub(crate) fn find_model_entry_file(model_dir: &Path) -> Result<Option<String>, String> {
    let live2d_entries = root_files_matching(model_dir, is_live2d_entry_name)?;
    if let Some(entry) = live2d_entries.into_iter().next() {
        return Ok(Some(entry));
    }
    Ok(root_files_matching(model_dir, is_image_entry_name)?
        .into_iter()
        .next())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModelResult {
    pub model_id: String,
    pub registry: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArchiveCandidate {
    pub path: String,
    pub recognized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArchiveInspection {
    pub candidates: Vec<ModelArchiveCandidate>,
}

const MAX_ARCHIVE_FILES: usize = 20_000;

enum ModelSource {
    Archive(String),
    Directory(PathBuf),
    Image(PathBuf),
}
const MAX_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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
        let Some(stored_entry) = stored_models.and_then(|models| models.get(model_id)) else {
            continue;
        };
        let Some(entry) = scanned_entry.as_object_mut() else {
            continue;
        };
        if let Some(name) = stored_entry.get("name").and_then(Value::as_str) {
            entry.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(selected_entry) = stored_entry.get("entry").and_then(Value::as_str) {
            let selected_path = models_dir.join(model_id).join(selected_entry);
            if is_live2d_entry_name(selected_entry) && selected_path.is_file() {
                let selected_json = read_json_file(&selected_path)?;
                if is_model_entry_json(&selected_json) {
                    let (motions, facials) = motion_catalog_from_json(&selected_json);
                    entry.insert(
                        "entry".to_string(),
                        Value::String(selected_entry.to_string()),
                    );
                    entry.insert("motions".to_string(), serde_json::json!(motions));
                    entry.insert("facials".to_string(), serde_json::json!(facials));
                }
            }
        }
    }
    Ok(scanned)
}

#[tauri::command]
pub fn inspect_model_archive(
    app: AppHandle,
    source_path: String,
) -> Result<ModelArchiveInspection, String> {
    let started_at = Instant::now();
    log::info!(
        target: "backend::model",
        "model.archive_inspect started source_kind={}",
        picked_source_kind(&source_path)
    );
    let source = super::materialize_picked_file(&app, &source_path, Some("zip"))?;
    let copied_from_picker = source.copied;
    let inspection = inspect_archive(&source.path)?;
    log::info!(
        target: "backend::model",
        "model.archive_inspect completed candidates={} recognized={} copied_from_picker={} duration_ms={}",
        inspection.candidates.len(),
        inspection
            .candidates
            .iter()
            .filter(|candidate| candidate.recognized)
            .count(),
        copied_from_picker,
        started_at.elapsed().as_millis()
    );
    Ok(inspection)
}

#[tauri::command]
pub fn import_global_model(
    app: AppHandle,
    source_path: String,
    name: Option<String>,
    archive_entry: Option<String>,
) -> Result<ImportedModelResult, String> {
    let started_at = Instant::now();
    log::info!(
        target: "backend::model",
        "model.import started source_kind={} custom_name={} selected_entry={}",
        picked_source_kind(&source_path),
        name.as_ref().is_some_and(|value| !value.trim().is_empty()),
        archive_entry.is_some()
    );
    let materialized = super::materialize_picked_file(&app, &source_path, None)?;
    let copied_from_picker = materialized.copied;
    let source_entry = materialized.path;
    if !source_entry.is_file() {
        return Err("选择的模型入口不存在或不是普通文件".into());
    }
    if fs::symlink_metadata(&source_entry)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("模型入口不能是符号链接".into());
    }

    let models_dir = data_dir(&app)?.join("models");
    fs::create_dir_all(&models_dir).map_err(|error| format!("创建全局模型目录失败: {error}"))?;
    let canonical_models_dir = models_dir
        .canonicalize()
        .map_err(|error| format!("读取全局模型目录失败: {error}"))?;

    let is_archive = is_zip_archive(&source_entry)?;
    let image_extension = if is_archive {
        None
    } else {
        image_extension_from_signature(&source_entry)?
    };
    let (entry_name, directory_name, source) = if let Some(extension) = image_extension {
        let directory_name = source_entry
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("portrait")
            .to_string();
        (
            format!("portrait.{extension}"),
            directory_name,
            ModelSource::Image(source_entry.clone()),
        )
    } else if is_archive {
        let inspection = inspect_archive(&source_entry)?;
        let selected = select_archive_entry(&inspection, archive_entry.as_deref())?;
        let selected_entry_name = selected
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ZIP 模型入口路径无效".to_string())?;
        if !is_live2d_entry_name(selected_entry_name) {
            return Err("ZIP 中请选择有效的 Live2D 模型入口".into());
        }
        let entry_json = read_archive_json(&source_entry, &selected)?;
        if !is_model_entry_json(&entry_json) {
            return Err(format!(
                "所选 JSON 不是可识别的 Live2D 模型入口: {selected}"
            ));
        }
        let entry_name = selected_entry_name.to_string();
        let directory_name = selected
            .rsplit_once('/')
            .and_then(|(parent, _)| parent.rsplit('/').next())
            .filter(|value| !value.is_empty())
            .or_else(|| source_entry.file_stem().and_then(|value| value.to_str()))
            .unwrap_or("model")
            .to_string();
        (entry_name, directory_name, ModelSource::Archive(selected))
    } else {
        if materialized.copied {
            return Err(
                "移动端无法从单个 JSON 取得模型贴图和动作文件，请将完整模型目录打包为 ZIP 后导入"
                    .into(),
            );
        }
        let entry_name = source_entry
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "模型入口文件名无效".to_string())?
            .to_string();
        if !is_live2d_entry_name(&entry_name) {
            return Err(
                "请选择 *.model3.json、*.model.json、model.json、*.zip 或 PNG/JPEG/WebP 图片"
                    .into(),
            );
        }
        let raw_entry = fs::read_to_string(&source_entry)
            .map_err(|error| format!("读取模型入口失败: {error}"))?;
        let entry_json: Value = serde_json::from_str(&raw_entry)
            .map_err(|error| format!("模型入口 JSON 无效: {error}"))?;
        if !entry_json.is_object() {
            return Err("模型入口 JSON 必须是对象".into());
        }
        let source_dir = source_entry
            .parent()
            .ok_or_else(|| "无法确定模型目录".to_string())?
            .canonicalize()
            .map_err(|error| format!("读取模型目录失败: {error}"))?;
        if source_dir.starts_with(&canonical_models_dir) {
            return Err("该模型已位于全局 models 目录，请从已有模型中选择".into());
        }
        let directory_name = source_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("model")
            .to_string();
        (
            entry_name,
            directory_name,
            ModelSource::Directory(source_dir),
        )
    };

    let model_id = next_model_id(&models_dir, &normalize_model_id(&directory_name));
    let destination = models_dir.join(&model_id);
    let temporary = models_dir.join(format!(".import-{}", unique_suffix()));
    let mut registry = get_model_registry(app.clone())?;
    let models = registry
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "全局模型注册表格式无效".to_string())?;
    let mut registry_entry =
        serde_json::Map::from_iter([("entry".to_string(), Value::String(entry_name.clone()))]);
    if let Some(display_name) = name.filter(|value| !value.trim().is_empty()) {
        registry_entry.insert("name".to_string(), Value::String(display_name));
    }
    models.insert(model_id.clone(), Value::Object(registry_entry));

    let prepare_result = match &source {
        ModelSource::Archive(selected) => {
            extract_archive_model(&source_entry, selected, &entry_name, &temporary)
        }
        ModelSource::Directory(source_dir) => copy_model_directory(source_dir, &temporary),
        ModelSource::Image(image) => copy_static_portrait(image, &entry_name, &temporary),
    };
    if let Err(error) = prepare_result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!("保存全局模型失败: {error}"));
    }

    if let Err(error) = write_model_registry(&models_dir, &registry) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }

    // Re-read after extraction so the response includes the selected entry's
    // live motion and facial catalog instead of the temporary index entry.
    let registry = get_model_registry(app)?;

    log::info!(
        target: "backend::model",
        "model.import completed model_id={} archive={} copied_from_picker={} duration_ms={}",
        model_id,
        is_archive,
        copied_from_picker,
        started_at.elapsed().as_millis()
    );
    Ok(ImportedModelResult { model_id, registry })
}

/// Names of the projects whose `assets.json` registers the global model.
#[tauri::command]
pub fn get_model_references(app: AppHandle, model_id: String) -> Result<Vec<String>, String> {
    validate_model_id(&model_id)?;
    projects_referencing_model(&super::projects_dir(&app)?, &model_id)
}

#[tauri::command]
pub fn rename_global_model(
    app: AppHandle,
    model_id: String,
    name: String,
) -> Result<Value, String> {
    validate_model_id(&model_id)?;
    let display_name = validate_model_name(&name)?;

    let models_dir = data_dir(&app)?.join("models");
    let mut registry = get_model_registry(app.clone())?;
    registry
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .and_then(|models| models.get_mut(&model_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "全局模型注册表中不存在该模型".to_string())?
        .insert("name".to_string(), Value::String(display_name));
    write_model_registry(&models_dir, &registry)?;
    log::info!(target: "backend::model", "model.rename completed model_id={model_id}");
    get_model_registry(app)
}

/// Deletes a global model. A model a project still registers is refused, because removing its
/// files would leave that project with an asset that can no longer be loaded.
#[tauri::command]
pub fn delete_global_model(app: AppHandle, model_id: String) -> Result<Value, String> {
    let models_dir = data_dir(&app)?.join("models");
    delete_model_files(&models_dir, &super::projects_dir(&app)?, &model_id)?;

    // The directory scan is the source of truth, so rewriting the index from it drops the entry.
    let registry = get_model_registry(app)?;
    write_model_registry(&models_dir, &registry)?;
    log::info!(target: "backend::model", "model.delete completed model_id={model_id}");
    Ok(registry)
}

fn delete_model_files(
    models_dir: &Path,
    projects_dir: &Path,
    model_id: &str,
) -> Result<(), String> {
    validate_model_id(model_id)?;
    let referencing = projects_referencing_model(projects_dir, model_id)?;
    if !referencing.is_empty() {
        return Err(format!("模型正被项目使用: {}", referencing.join("、")));
    }

    let model_dir = models_dir.join(model_id);
    let metadata = fs::symlink_metadata(&model_dir).map_err(|_| "模型不存在".to_string())?;
    if !metadata.is_dir() {
        return Err("模型目录无效".into());
    }
    fs::remove_dir_all(&model_dir).map_err(|error| format!("删除模型失败: {error}"))
}

fn projects_referencing_model(projects_dir: &Path, model_id: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(projects_dir)
        .map_err(|error| format!("读取项目目录失败: {error}"))?
        .filter_map(|entry| entry.ok())
    {
        let assets_path = entry.path().join("assets.json");
        if !assets_path.is_file() {
            continue;
        }
        let project_name = entry.file_name().to_string_lossy().to_string();
        // An unreadable project could still register the model, so it must not be skipped.
        let assets = read_json_file(&assets_path)
            .map_err(|error| format!("无法确认项目“{project_name}”是否使用该模型: {error}"))?;
        let references = assets
            .get("models")
            .and_then(Value::as_object)
            .is_some_and(|models| {
                models
                    .values()
                    .any(|model| model.get("modelId").and_then(Value::as_str) == Some(model_id))
            });
        if references {
            names.push(project_name);
        }
    }
    names.sort();
    Ok(names)
}

pub(crate) fn validate_model_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) || id.contains('\0') {
        return Err(format!("模型 ID 无效: {id}"));
    }
    Ok(())
}

const MAX_MODEL_NAME_CHARS: usize = 100;

fn validate_model_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("模型名称不能为空".into());
    }
    if name.chars().count() > MAX_MODEL_NAME_CHARS {
        return Err(format!("模型名称不能超过 {MAX_MODEL_NAME_CHARS} 个字符"));
    }
    if name.chars().any(char::is_control) {
        return Err("模型名称不能包含控制字符".into());
    }
    Ok(name.to_string())
}

fn picked_source_kind(source_path: &str) -> &'static str {
    let normalized = source_path.to_ascii_lowercase();
    if normalized.starts_with("content://") {
        "content_uri"
    } else if normalized.starts_with("file://") {
        "file_uri"
    } else {
        "local_path"
    }
}

fn is_zip_archive(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| format!("读取模型文件失败: {error}"))?;
    let mut signature = [0_u8; 4];
    let read = file
        .read(&mut signature)
        .map_err(|error| format!("读取模型文件失败: {error}"))?;
    Ok(read == signature.len()
        && matches!(
            signature,
            [0x50, 0x4b, 0x03, 0x04] | [0x50, 0x4b, 0x05, 0x06] | [0x50, 0x4b, 0x07, 0x08]
        ))
}

fn inspect_archive(source: &Path) -> Result<ModelArchiveInspection, String> {
    if !source.is_file() {
        return Err("选择的 ZIP 不存在或不是普通文件".into());
    }

    let file = File::open(source).map_err(|error| format!("打开模型 ZIP 失败: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("模型 ZIP 无效: {error}"))?;
    if archive.len() > MAX_ARCHIVE_FILES {
        return Err(format!("模型 ZIP 文件数量超过限制: {}", archive.len()));
    }

    let mut candidates = Vec::new();
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("读取模型 ZIP 失败: {error}"))?;
        let path = validate_archive_name(entry.name())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("模型 ZIP 不能包含符号链接: {path}"));
        }
        total_size = total_size.saturating_add(entry.size());
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err("模型 ZIP 解压后超过 2 GiB 限制".into());
        }
        if entry.is_dir() {
            continue;
        }
        if !path.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        let file_name = path.rsplit('/').next().unwrap_or(&path);
        candidates.push(ModelArchiveCandidate {
            recognized: is_live2d_entry_name(file_name),
            path,
        });
    }
    candidates.sort_by(|left, right| {
        right
            .recognized
            .cmp(&left.recognized)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.dedup_by(|left, right| left.path == right.path);
    if candidates.is_empty() {
        return Err("模型 ZIP 中没有 JSON 文件".into());
    }
    Ok(ModelArchiveInspection { candidates })
}

fn select_archive_entry(
    inspection: &ModelArchiveInspection,
    selected: Option<&str>,
) -> Result<String, String> {
    if let Some(selected) = selected {
        let normalized = normalize_archive_name(selected);
        if inspection
            .candidates
            .iter()
            .any(|candidate| candidate.path == normalized)
        {
            return Ok(normalized);
        }
        return Err("选择的模型入口不属于该 ZIP".into());
    }

    let recognized: Vec<&ModelArchiveCandidate> = inspection
        .candidates
        .iter()
        .filter(|candidate| candidate.recognized)
        .collect();
    if recognized.len() == 1 {
        return Ok(recognized[0].path.clone());
    }
    Err("该 ZIP 需要先选择模型入口".into())
}

fn read_archive_json(source: &Path, selected: &str) -> Result<Value, String> {
    let file = File::open(source).map_err(|error| format!("打开模型 ZIP 失败: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("模型 ZIP 无效: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取模型 ZIP 失败: {error}"))?;
        if validate_archive_name(entry.name())? != selected {
            continue;
        }
        if entry.size() > 32 * 1024 * 1024 {
            return Err("模型入口 JSON 超过 32 MiB 限制".into());
        }
        let mut raw = String::new();
        entry
            .read_to_string(&mut raw)
            .map_err(|error| format!("读取 ZIP 模型入口失败: {error}"))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("ZIP 模型入口 JSON 无效: {error}"))?;
        if !value.is_object() {
            return Err("ZIP 模型入口 JSON 必须是对象".into());
        }
        return Ok(value);
    }
    Err("ZIP 中找不到所选模型入口".into())
}

fn extract_archive_model(
    source: &Path,
    selected: &str,
    output_entry_name: &str,
    destination: &Path,
) -> Result<(), String> {
    let file = File::open(source).map_err(|error| format!("打开模型 ZIP 失败: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("模型 ZIP 无效: {error}"))?;
    let prefix = selected
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/"))
        .unwrap_or_default();
    let mut total_size = 0_u64;
    let mut extracted_paths = HashSet::new();
    let mut extracted_entry = false;
    fs::create_dir(destination).map_err(|error| format!("创建模型导入目录失败: {error}"))?;

    let result = (|| -> Result<(), String> {
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("读取模型 ZIP 失败: {error}"))?;
            let path = validate_archive_name(entry.name())?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(format!("模型 ZIP 不能包含符号链接: {}", entry.name()));
            }

            let Some(relative) = path.strip_prefix(&prefix) else {
                continue;
            };
            if relative.is_empty() {
                continue;
            }
            total_size = total_size.saturating_add(entry.size());
            if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
                return Err("模型 ZIP 解压后超过 2 GiB 限制".into());
            }

            let output = if path == selected {
                destination.join(output_entry_name)
            } else {
                destination.join(relative)
            };
            if !extracted_paths.insert(output.clone()) {
                return Err(format!("模型 ZIP 包含重复路径: {relative}"));
            }
            if entry.is_dir() {
                fs::create_dir_all(&output)
                    .map_err(|error| format!("创建模型目录失败: {error}"))?;
                continue;
            }
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建模型目录失败: {error}"))?;
            }
            let mut output_file =
                File::create(&output).map_err(|error| format!("创建模型文件失败: {error}"))?;
            io::copy(&mut entry, &mut output_file)
                .map_err(|error| format!("解压模型文件失败: {error}"))?;
            if path == selected {
                extracted_entry = true;
            }
        }
        if !extracted_entry {
            return Err("ZIP 中没有解压出所选模型入口".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

fn normalize_archive_name(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn validate_archive_name(value: &str) -> Result<String, String> {
    let normalized = normalize_archive_name(value);
    let path = normalized.trim_end_matches('/');
    let invalid = path.is_empty()
        || path.starts_with('/')
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || path
            .split('/')
            .next()
            .is_some_and(|component| component.ends_with(':'));
    if invalid {
        return Err(format!("模型 ZIP 包含不安全路径: {value}"));
    }
    Ok(path.to_string())
}

pub(crate) fn is_live2d_entry_name(file_name: &str) -> bool {
    let normalized = file_name.to_ascii_lowercase();
    normalized.ends_with(".model3.json")
        || normalized == "model.json"
        || normalized.ends_with(".model.json")
}

pub(crate) fn is_image_entry_name(file_name: &str) -> bool {
    let normalized = file_name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp"]
        .iter()
        .any(|extension| normalized.ends_with(extension))
}

pub(crate) fn is_model_entry_name(file_name: &str) -> bool {
    is_live2d_entry_name(file_name) || is_image_entry_name(file_name)
}

/// Identifies a static portrait by its signature instead of its name, because files picked on
/// Android arrive with provider-generated names that may lack an extension.
fn image_extension_from_signature(path: &Path) -> Result<Option<&'static str>, String> {
    let mut file = File::open(path).map_err(|error| format!("读取立绘文件失败: {error}"))?;
    let mut header = [0_u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("读取立绘文件失败: {error}"))?;
    let header = &header[..read];
    Ok(
        if header.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            Some("png")
        } else if header.starts_with(&[0xff, 0xd8, 0xff]) {
            Some("jpg")
        } else if header.len() == 12 && &header[..4] == b"RIFF" && &header[8..] == b"WEBP" {
            Some("webp")
        } else {
            None
        },
    )
}

pub(crate) fn is_model_entry_json(entry: &Value) -> bool {
    entry
        .get("FileReferences")
        .and_then(|references| references.get("Moc"))
        .and_then(Value::as_str)
        .is_some()
        || entry.get("model").and_then(Value::as_str).is_some()
        || entry.get("moc").and_then(Value::as_str).is_some()
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

fn copy_static_portrait(source: &Path, entry_name: &str, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|error| format!("创建模型导入目录失败: {error}"))?;
    fs::copy(source, destination.join(entry_name)).map_err(|error| {
        let _ = fs::remove_dir_all(destination);
        format!("复制立绘文件失败: {error}")
    })?;
    Ok(())
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

pub(crate) fn write_model_registry(models_dir: &Path, registry: &Value) -> Result<(), String> {
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
    use super::{
        delete_model_files, extract_archive_model, find_model_entry_file,
        image_extension_from_signature, inspect_archive, is_image_entry_name, is_live2d_entry_name,
        is_model_entry_json, is_zip_archive, motion_catalog_from_json, next_model_id,
        normalize_model_id, projects_referencing_model, read_archive_json, select_archive_entry,
        validate_model_name,
    };
    use serde_json::json;
    use std::fs;
    use std::fs::File;
    use std::io::Write;
    use std::path::Path;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn accepts_live2d_entry_names() {
        assert!(is_live2d_entry_name("Hatsune.model3.json"));
        assert!(is_live2d_entry_name("model.json"));
        assert!(!is_live2d_entry_name("settings.json"));
        assert!(!is_live2d_entry_name("portrait.png"));
    }

    #[test]
    fn accepts_static_image_entry_names() {
        assert!(is_image_entry_name("portrait.PNG"));
        assert!(is_image_entry_name("a.webp"));
        assert!(!is_image_entry_name("model3.json"));
    }

    #[test]
    fn detects_image_format_from_signature() {
        let root = std::env::temp_dir().join(format!("mss-image-test-{}", super::unique_suffix()));
        fs::create_dir_all(&root).expect("create image test directory");
        let write = |name: &str, bytes: &[u8]| {
            let path = root.join(name);
            fs::write(&path, bytes).expect("write image fixture");
            path
        };
        let png = write(
            "no-extension",
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0],
        );
        let jpeg = write("b.bin", &[0xff, 0xd8, 0xff, 0xe0, 0, 0]);
        let webp = write("c", b"RIFF\0\0\0\0WEBPVP8 ");
        let text = write("d.png", b"not an image");
        assert_eq!(image_extension_from_signature(&png).unwrap(), Some("png"));
        assert_eq!(image_extension_from_signature(&jpeg).unwrap(), Some("jpg"));
        assert_eq!(image_extension_from_signature(&webp).unwrap(), Some("webp"));
        assert_eq!(image_extension_from_signature(&text).unwrap(), None);
        fs::remove_dir_all(root).expect("remove image test directory");
    }

    #[test]
    fn finds_projects_referencing_a_model() {
        let root = std::env::temp_dir().join(format!("mss-refs-test-{}", super::unique_suffix()));
        let write_assets = |project: &str, body: &str| {
            fs::create_dir_all(root.join(project)).expect("create project directory");
            fs::write(root.join(project).join("assets.json"), body).expect("write assets");
        };
        write_assets("b-uses", r#"{"models":{"k":{"modelId":"hero"}}}"#);
        write_assets(
            "a-uses",
            r#"{"models":{"x":{"modelId":"hero"},"y":{"modelId":"villain"}}}"#,
        );
        write_assets("other", r#"{"models":{"k":{"modelId":"villain"}}}"#);
        fs::create_dir_all(root.join("no-assets")).expect("create project without assets");

        assert_eq!(
            projects_referencing_model(&root, "hero").unwrap(),
            vec!["a-uses".to_string(), "b-uses".to_string()]
        );
        assert!(projects_referencing_model(&root, "unused")
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).expect("remove references test directory");
    }

    #[test]
    fn deletes_an_unused_model_and_refuses_a_used_or_invalid_one() {
        let root = std::env::temp_dir().join(format!("mss-delete-test-{}", super::unique_suffix()));
        let models = root.join("models");
        let projects = root.join("projects");
        for id in ["free", "used"] {
            fs::create_dir_all(models.join(id)).expect("create model directory");
            fs::write(models.join(id).join("portrait.png"), "png").expect("write portrait");
        }
        fs::create_dir_all(projects.join("story")).expect("create project directory");
        fs::write(
            projects.join("story").join("assets.json"),
            r#"{"models":{"k":{"modelId":"used"}}}"#,
        )
        .expect("write assets");

        let used = delete_model_files(&models, &projects, "used").unwrap_err();
        assert!(used.contains("story"), "names the project: {used}");
        assert!(models.join("used").exists());

        delete_model_files(&models, &projects, "free").expect("delete unused model");
        assert!(!models.join("free").exists());
        assert!(delete_model_files(&models, &projects, "free").is_err());
        assert!(delete_model_files(&models, &projects, "../models").is_err());

        fs::write(models.join("index.json"), "{}").expect("write index file");
        assert!(delete_model_files(&models, &projects, "index.json").is_err());
        assert!(models.join("index.json").exists());
        fs::remove_dir_all(root).expect("remove delete test directory");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_delete_a_symlinked_model_directory() {
        let root = std::env::temp_dir().join(format!("mss-link-test-{}", super::unique_suffix()));
        let models = root.join("models");
        let outside = root.join("outside");
        fs::create_dir_all(&models).expect("create models directory");
        fs::create_dir_all(root.join("projects")).expect("create projects directory");
        fs::create_dir_all(&outside).expect("create outside directory");
        fs::write(outside.join("keep.txt"), "keep").expect("write outside file");
        std::os::unix::fs::symlink(&outside, models.join("linked")).expect("create symlink");

        assert!(delete_model_files(&models, &root.join("projects"), "linked").is_err());
        assert!(outside.join("keep.txt").exists());
        fs::remove_dir_all(root).expect("remove link test directory");
    }

    #[test]
    fn reports_which_project_cannot_be_checked() {
        let root = std::env::temp_dir().join(format!("mss-broken-test-{}", super::unique_suffix()));
        fs::create_dir_all(root.join("broken")).expect("create project directory");
        fs::write(root.join("broken").join("assets.json"), "{ not json").expect("write assets");

        let error = projects_referencing_model(&root, "hero").unwrap_err();
        assert!(error.contains("broken"), "names the project: {error}");
        fs::remove_dir_all(root).expect("remove broken test directory");
    }

    #[test]
    fn validates_model_names() {
        assert_eq!(validate_model_name("  Shiho  ").unwrap(), "Shiho");
        assert!(validate_model_name("   ").is_err());
        assert!(validate_model_name("line\nbreak").is_err());
        assert!(validate_model_name(&"a".repeat(101)).is_err());
        assert!(validate_model_name(&"志".repeat(100)).is_ok());
    }

    #[test]
    fn prefers_live2d_entry_over_root_textures() {
        let root = std::env::temp_dir().join(format!("mss-entry-test-{}", super::unique_suffix()));
        fs::create_dir_all(&root).expect("create entry test directory");
        fs::write(root.join("texture_00.png"), "png").expect("write texture");
        assert_eq!(
            find_model_entry_file(&root).unwrap().as_deref(),
            Some("texture_00.png")
        );
        fs::write(root.join("z.model3.json"), "{}").expect("write entry");
        assert_eq!(
            find_model_entry_file(&root).unwrap().as_deref(),
            Some("z.model3.json")
        );
        fs::remove_dir_all(root).expect("remove entry test directory");
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
        let mut groups = serde_json::Map::new();
        for index in 1..=100 {
            groups.insert(
                format!("motion_test_{index:03}"),
                json!([{ "File": format!("motions/motion_test_{index:03}.motion3.json") }]),
            );
            groups.insert(
                format!("face_test_{index:03}"),
                json!([{ "File": format!("motions/face_test_{index:03}.motion3.json") }]),
            );
        }

        let entry = json!({
            "FileReferences": {
                "Motions": groups
            }
        });
        let (motions, facials) = motion_catalog_from_json(&entry);
        let expected_motions: Vec<String> = (1..=100)
            .map(|index| format!("motion_test_{index:03}"))
            .collect();
        let expected_facials: Vec<String> = (1..=100)
            .map(|index| format!("face_test_{index:03}"))
            .collect();

        assert_eq!(motions, expected_motions);
        assert_eq!(facials, expected_facials);
    }

    #[test]
    fn inspects_and_extracts_single_archive_model() {
        let root = std::env::temp_dir().join(format!("mss-zip-test-{}", super::unique_suffix()));
        fs::create_dir_all(&root).expect("create zip test directory");
        let archive_path = root.join("model.zip");
        write_test_zip(
            &archive_path,
            &[
                (
                    "wrapper/character.model3.json",
                    r#"{"FileReferences":{"Moc":"character.moc3"}}"#,
                ),
                ("wrapper/character.moc3", "moc"),
                ("wrapper/settings.json", "{}"),
            ],
        );
        let extensionless_archive = root.join("model-content");
        fs::copy(&archive_path, &extensionless_archive).expect("copy extensionless zip fixture");
        assert!(is_zip_archive(&extensionless_archive).expect("detect extensionless zip content"));

        let inspection = inspect_archive(&archive_path).expect("inspect archive");
        assert_eq!(inspection.candidates.len(), 2);
        let extensionless_inspection =
            inspect_archive(&extensionless_archive).expect("inspect extensionless archive");
        assert_eq!(
            extensionless_inspection.candidates.len(),
            inspection.candidates.len()
        );
        let selected = select_archive_entry(&inspection, None).expect("select unique entry");
        assert_eq!(selected, "wrapper/character.model3.json");
        let entry = read_archive_json(&archive_path, &selected).expect("read archive entry");
        assert!(is_model_entry_json(&entry));

        let destination = root.join("extracted");
        extract_archive_model(
            &archive_path,
            &selected,
            "character.model3.json",
            &destination,
        )
        .expect("extract model directory");
        assert!(destination.join("character.model3.json").is_file());
        assert!(destination.join("character.moc3").is_file());
        assert!(!destination.join("wrapper").exists());
        fs::remove_dir_all(root).expect("remove zip test directory");
    }

    #[test]
    fn requires_selection_for_multiple_or_unrecognized_entries() {
        let root = std::env::temp_dir().join(format!("mss-zip-test-{}", super::unique_suffix()));
        fs::create_dir_all(&root).expect("create zip test directory");

        let multiple_path = root.join("multiple.zip");
        write_test_zip(
            &multiple_path,
            &[
                ("a/a.model3.json", r#"{"FileReferences":{"Moc":"a.moc3"}}"#),
                ("b/model.json", r#"{"model":"b.moc"}"#),
            ],
        );
        let multiple = inspect_archive(&multiple_path).expect("inspect multiple archive");
        assert!(select_archive_entry(&multiple, None).is_err());

        let unknown_path = root.join("unknown.zip");
        write_test_zip(
            &unknown_path,
            &[(
                "character/entry.json",
                r#"{"FileReferences":{"Moc":"a.moc3"}}"#,
            )],
        );
        let unknown = inspect_archive(&unknown_path).expect("inspect unknown archive");
        assert!(!unknown.candidates[0].recognized);
        assert!(select_archive_entry(&unknown, None).is_err());
        let selected = select_archive_entry(&unknown, Some("character/entry.json"))
            .expect("select unknown json");
        assert_eq!(selected, "character/entry.json");
        let destination = root.join("unknown-extracted");
        extract_archive_model(&unknown_path, &selected, "model.json", &destination)
            .expect("extract renamed unknown entry");
        assert!(destination.join("model.json").is_file());

        let unsafe_path = root.join("unsafe.zip");
        write_test_zip(
            &unsafe_path,
            &[
                (
                    "safe/model.model3.json",
                    r#"{"FileReferences":{"Moc":"model.moc3"}}"#,
                ),
                ("../outside.txt", "unsafe"),
            ],
        );
        assert!(inspect_archive(&unsafe_path).is_err());
        fs::remove_dir_all(root).expect("remove zip test directory");
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = File::create(path).expect("create test zip");
        let mut writer = ZipWriter::new(file);
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start zip entry");
            writer
                .write_all(content.as_bytes())
                .expect("write zip entry");
        }
        writer.finish().expect("finish test zip");
    }
}
