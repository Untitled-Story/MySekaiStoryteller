use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::{
    default_assets_json, project_path, read_project_json_or_default, resolve_project_file,
    update_assets_summary, write_project_json, STORY_FILE,
};
use crate::commands::project::model_registry::get_model_registry;

const BACKGROUND_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const VOICE_EXTENSIONS: &[&str] = &["ogg", "mp3", "wav", "m4a"];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectAssetKind {
    Models,
    Backgrounds,
    Voices,
}

impl ProjectAssetKind {
    fn collection_key(self) -> &'static str {
        match self {
            Self::Models => "models",
            Self::Backgrounds => "backgrounds",
            Self::Voices => "voices",
        }
    }

    fn asset_folder(self) -> Option<&'static str> {
        match self {
            Self::Backgrounds => Some("backgrounds"),
            Self::Voices => Some("voices"),
            Self::Models => None,
        }
    }

    fn allowed_extensions(self) -> Option<&'static [&'static str]> {
        match self {
            Self::Backgrounds => Some(BACKGROUND_EXTENSIONS),
            Self::Voices => Some(VOICE_EXTENSIONS),
            Self::Models => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetMutationResult {
    pub key: String,
    pub assets: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetReference {
    pub snippet_id: Option<String>,
    pub snippet_type: String,
    pub path: String,
}

#[tauri::command]
pub fn get_project_assets(app: AppHandle, project_name: String) -> Result<Value, String> {
    let project_path = project_path(&app, &project_name)?;
    let assets = read_project_json_or_default(&project_path, "assets.json", default_assets_json())?;
    validate_assets(&assets)?;
    Ok(assets)
}

#[tauri::command]
pub fn set_project_assets(
    app: AppHandle,
    project_name: String,
    assets: Value,
) -> Result<(), String> {
    validate_assets(&assets)?;
    let project_path = project_path(&app, &project_name)?;
    write_project_json(&project_path, "assets.json", &assets)?;
    update_assets_summary(&project_path, &assets)
}

#[tauri::command]
pub fn import_project_asset(
    app: AppHandle,
    project_name: String,
    asset_kind: ProjectAssetKind,
    source_path: String,
) -> Result<ProjectAssetMutationResult, String> {
    let folder = asset_kind
        .asset_folder()
        .ok_or_else(|| "模型不能通过文件导入，请从模型注册表添加".to_string())?;
    let allowed_extensions = asset_kind
        .allowed_extensions()
        .ok_or_else(|| "资源类型不支持导入".to_string())?;
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("选择的文件不存在或不是普通文件".into());
    }

    let extension = file_extension(&source)?;
    if !allowed_extensions.contains(&extension.as_str()) {
        return Err(format!("不支持 .{extension} 文件"));
    }

    let project_path = project_path(&app, &project_name)?;
    let mut assets = read_assets(&project_path)?;
    let key = next_import_key(&assets, asset_kind, &source, &project_path)?;
    let relative_path = format!("assets/{folder}/{key}.{extension}");
    let destination = resolve_project_file(&project_path, &relative_path)?;
    if destination.exists() {
        return Err("导入目标已存在，请重试".into());
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建资源目录失败: {error}"))?;
    }
    fs::copy(&source, &destination).map_err(|error| format!("复制资源文件失败: {error}"))?;

    let name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&key)
        .to_string();
    let mutation = match asset_kind {
        ProjectAssetKind::Backgrounds | ProjectAssetKind::Voices => json!({
            "name": name,
            "path": relative_path,
        }),
        ProjectAssetKind::Models => unreachable!("models are rejected above"),
    };

    if let Err(error) = insert_asset(&mut assets, asset_kind, key.clone(), mutation)
        .and_then(|_| write_project_json(&project_path, "assets.json", &assets))
        .and_then(|_| update_assets_summary(&project_path, &assets))
    {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }

    Ok(ProjectAssetMutationResult { key, assets })
}

#[tauri::command]
pub fn register_project_model(
    app: AppHandle,
    project_name: String,
    model_id: String,
    key: Option<String>,
    name: Option<String>,
) -> Result<ProjectAssetMutationResult, String> {
    let registry = get_model_registry(app.clone())?;
    let registry_entry = registry
        .get("models")
        .and_then(Value::as_object)
        .and_then(|models| models.get(&model_id))
        .ok_or_else(|| "全局模型注册表中不存在该模型".to_string())?;
    let default_name = registry_entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&model_id);
    let project_path = project_path(&app, &project_name)?;
    let mut assets = read_assets(&project_path)?;
    let resolved_key = match key {
        Some(value) if !value.trim().is_empty() => {
            validate_asset_key(&value)?;
            ensure_asset_missing(&assets, ProjectAssetKind::Models, &value)?;
            value
        }
        _ => next_key_for_base(
            &assets,
            ProjectAssetKind::Models,
            &normalize_asset_key(&model_id),
        ),
    };
    let asset_name = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_name.to_string());

    insert_asset(
        &mut assets,
        ProjectAssetKind::Models,
        resolved_key.clone(),
        json!({
            "name": asset_name,
            "modelId": model_id,
            "normalScale": 2.1,
            "smallScale": 1.8,
            "anchor": 0.5,
        }),
    )?;
    write_project_json(&project_path, "assets.json", &assets)?;
    update_assets_summary(&project_path, &assets)?;

    Ok(ProjectAssetMutationResult {
        key: resolved_key,
        assets,
    })
}

#[tauri::command]
pub fn get_project_asset_references(
    app: AppHandle,
    project_name: String,
    asset_kind: ProjectAssetKind,
    key: String,
) -> Result<Vec<ProjectAssetReference>, String> {
    validate_asset_key(&key)?;
    let project_path = project_path(&app, &project_name)?;
    let story =
        read_project_json_or_default(&project_path, STORY_FILE, super::default_story_json())?;
    Ok(find_asset_references(&story, asset_kind, &key))
}

#[tauri::command]
pub fn rename_project_asset(
    app: AppHandle,
    project_name: String,
    asset_kind: ProjectAssetKind,
    old_key: String,
    new_key: String,
) -> Result<Value, String> {
    validate_asset_key(&old_key)?;
    validate_asset_key(&new_key)?;
    if old_key == new_key {
        return get_project_assets(app, project_name);
    }

    let project_path = project_path(&app, &project_name)?;
    let mut assets = read_assets(&project_path)?;
    ensure_asset_missing(&assets, asset_kind, &new_key)?;
    let mut asset = remove_asset(&mut assets, asset_kind, &old_key)?;
    let mut story =
        read_project_json_or_default(&project_path, STORY_FILE, super::default_story_json())?;
    rewrite_asset_references(&mut story, asset_kind, &old_key, &new_key);

    let file_move = rename_managed_asset_file(&project_path, asset_kind, &mut asset, &new_key)?;
    insert_asset(&mut assets, asset_kind, new_key, asset)?;

    if let Some((from, to)) = &file_move {
        fs::rename(from, to).map_err(|error| format!("重命名资源文件失败: {error}"))?;
    }

    let write_result = write_json_transaction(
        &project_path,
        &[("assets.json", &assets), (STORY_FILE, &story)],
    );
    if let Err(error) = write_result {
        if let Some((from, to)) = &file_move {
            let _ = fs::rename(to, from);
        }
        return Err(error);
    }

    update_assets_summary(&project_path, &assets)?;
    Ok(assets)
}

#[tauri::command]
pub fn delete_project_asset(
    app: AppHandle,
    project_name: String,
    asset_kind: ProjectAssetKind,
    key: String,
) -> Result<Value, String> {
    validate_asset_key(&key)?;
    let project_path = project_path(&app, &project_name)?;
    let story =
        read_project_json_or_default(&project_path, STORY_FILE, super::default_story_json())?;
    let references = find_asset_references(&story, asset_kind, &key);
    if !references.is_empty() {
        let locations = references
            .iter()
            .map(|reference| format!("{} ({})", reference.path, reference.snippet_type))
            .collect::<Vec<String>>()
            .join(", ");
        return Err(format!(
            "资源仍被 {} 个片段引用: {locations}",
            references.len()
        ));
    }

    let mut assets = read_assets(&project_path)?;
    let asset = remove_asset(&mut assets, asset_kind, &key)?;
    let file_to_remove = managed_asset_file(&project_path, asset_kind, &asset)?;
    let staged_file = file_to_remove.as_ref().map(|path| {
        path.with_extension(format!(
            "{}.deleting",
            file_extension(path).unwrap_or_default()
        ))
    });

    if let (Some(file), Some(staged)) = (&file_to_remove, &staged_file) {
        if file.exists() {
            fs::rename(file, staged).map_err(|error| format!("暂存资源文件失败: {error}"))?;
        }
    }

    if let Err(error) = write_project_json(&project_path, "assets.json", &assets)
        .and_then(|_| update_assets_summary(&project_path, &assets))
    {
        if let (Some(file), Some(staged)) = (&file_to_remove, &staged_file) {
            if staged.exists() {
                let _ = fs::rename(staged, file);
            }
        }
        return Err(error);
    }

    if let Some(staged) = staged_file {
        if staged.exists() {
            fs::remove_file(staged).map_err(|error| format!("删除资源文件失败: {error}"))?;
        }
    }

    Ok(assets)
}

fn read_assets(project_path: &Path) -> Result<Value, String> {
    let assets = read_project_json_or_default(project_path, "assets.json", default_assets_json())?;
    validate_assets(&assets)?;
    Ok(assets)
}

fn validate_assets(assets: &Value) -> Result<(), String> {
    let root = assets
        .as_object()
        .ok_or_else(|| "assets.json 必须是对象".to_string())?;

    for kind in [
        ProjectAssetKind::Models,
        ProjectAssetKind::Backgrounds,
        ProjectAssetKind::Voices,
    ] {
        let collection = root
            .get(kind.collection_key())
            .and_then(Value::as_object)
            .ok_or_else(|| format!("assets.json 缺少 {} 集合", kind.collection_key()))?;
        for (key, asset) in collection {
            validate_asset_key(key)?;
            validate_asset(kind, asset)?;
        }
    }

    Ok(())
}

fn validate_asset(kind: ProjectAssetKind, asset: &Value) -> Result<(), String> {
    let object = asset
        .as_object()
        .ok_or_else(|| "资源记录必须是对象".to_string())?;
    match kind {
        ProjectAssetKind::Models => {
            let model_id = object
                .get("modelId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if model_id.trim().is_empty() {
                return Err("模型资源缺少 modelId".into());
            }
            for key in ["normalScale", "smallScale", "anchor"] {
                if let Some(value) = object.get(key) {
                    if !value.is_number() {
                        return Err(format!("模型资源字段 {key} 必须是数字"));
                    }
                }
            }
        }
        ProjectAssetKind::Backgrounds | ProjectAssetKind::Voices => {
            let path = object
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if path.trim().is_empty() {
                return Err("文件资源缺少 path".into());
            }
            let parsed = Path::new(path);
            if parsed.is_absolute()
                || parsed
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err("资源 path 必须位于项目目录内".into());
            }
        }
    }
    Ok(())
}

fn insert_asset(
    assets: &mut Value,
    kind: ProjectAssetKind,
    key: String,
    asset: Value,
) -> Result<(), String> {
    let collection = asset_collection_mut(assets, kind)?;
    if collection.contains_key(&key) {
        return Err("资源键已存在".into());
    }
    collection.insert(key, asset);
    Ok(())
}

fn remove_asset(assets: &mut Value, kind: ProjectAssetKind, key: &str) -> Result<Value, String> {
    let collection = asset_collection_mut(assets, kind)?;
    collection
        .remove(key)
        .ok_or_else(|| format!("资源不存在: {key}"))
}

fn ensure_asset_missing(assets: &Value, kind: ProjectAssetKind, key: &str) -> Result<(), String> {
    let collection = asset_collection(assets, kind)?;
    if collection.contains_key(key) {
        return Err("资源键已存在".into());
    }
    Ok(())
}

fn asset_collection(assets: &Value, kind: ProjectAssetKind) -> Result<&Map<String, Value>, String> {
    assets
        .get(kind.collection_key())
        .and_then(Value::as_object)
        .ok_or_else(|| format!("assets.json 缺少 {} 集合", kind.collection_key()))
}

fn asset_collection_mut(
    assets: &mut Value,
    kind: ProjectAssetKind,
) -> Result<&mut Map<String, Value>, String> {
    assets
        .get_mut(kind.collection_key())
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("assets.json 缺少 {} 集合", kind.collection_key()))
}

fn next_import_key(
    assets: &Value,
    kind: ProjectAssetKind,
    source: &Path,
    project_path: &Path,
) -> Result<String, String> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let base = normalize_asset_key(stem);
    let extension = file_extension(source)?;
    let collection = asset_collection(assets, kind)?;
    let mut index: u32 = 1;
    loop {
        let key = if index == 1 {
            base.clone()
        } else {
            format!("{base}-{index}")
        };
        let path = project_path.join(format!(
            "assets/{}/{}.{}",
            kind.asset_folder().unwrap_or_default(),
            key,
            extension
        ));
        if !collection.contains_key(&key) && !path.exists() {
            return Ok(key);
        }
        index = index.saturating_add(1);
    }
}

fn next_key_for_base(assets: &Value, kind: ProjectAssetKind, base: &str) -> String {
    let collection = asset_collection(assets, kind).expect("assets were validated");
    let mut index: u32 = 1;
    loop {
        let key = if index == 1 {
            base.to_string()
        } else {
            format!("{base}-{index}")
        };
        if !collection.contains_key(&key) {
            return key;
        }
        index = index.saturating_add(1);
    }
}

fn normalize_asset_key(value: &str) -> String {
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

    let normalized = normalized.trim_matches(['-', '_']);
    if normalized.is_empty() {
        "asset".to_string()
    } else {
        normalized.chars().take(128).collect()
    }
}

fn validate_asset_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err("资源键长度必须在 1 到 128 个字符之间".into());
    }
    if normalize_asset_key(key) != key {
        return Err("资源键只能使用小写字母、数字、连字符和下划线".into());
    }
    Ok(())
}

fn file_extension(path: &Path) -> Result<String, String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "文件没有扩展名".to_string())
}

fn find_asset_references(
    story: &Value,
    kind: ProjectAssetKind,
    key: &str,
) -> Vec<ProjectAssetReference> {
    let mut references = Vec::new();
    if let Some(snippets) = story.get("snippets").and_then(Value::as_array) {
        collect_asset_references(snippets, kind, key, &mut Vec::new(), &mut references);
    }
    references
}

fn collect_asset_references(
    snippets: &[Value],
    kind: ProjectAssetKind,
    key: &str,
    path: &mut Vec<usize>,
    references: &mut Vec<ProjectAssetReference>,
) {
    for (index, snippet) in snippets.iter().enumerate() {
        path.push(index);
        let snippet_type = snippet
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("Unknown");
        if snippet_references_asset(snippet, kind, key) {
            references.push(ProjectAssetReference {
                snippet_id: snippet
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                snippet_type: snippet_type.to_string(),
                path: path
                    .iter()
                    .map(|part| (part + 1).to_string())
                    .collect::<Vec<String>>()
                    .join("."),
            });
        }
        if snippet_type == "Parallel" {
            if let Some(children) = snippet.get("snippets").and_then(Value::as_array) {
                collect_asset_references(children, kind, key, path, references);
            }
        }
        path.pop();
    }
}

fn snippet_references_asset(snippet: &Value, kind: ProjectAssetKind, key: &str) -> bool {
    let snippet_type = snippet
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = snippet.get("data").and_then(Value::as_object);
    let field_matches = |field: &str| {
        data.and_then(|object| object.get(field))
            .and_then(Value::as_str)
            .is_some_and(|value| value == key)
    };
    let effect_model_matches = || {
        data.and_then(|object| object.get("target"))
            .and_then(Value::as_object)
            .filter(|target| target.get("type").and_then(Value::as_str) == Some("Model"))
            .and_then(|target| target.get("model"))
            .and_then(Value::as_str)
            .is_some_and(|value| value == key)
    };

    match kind {
        ProjectAssetKind::Backgrounds => {
            snippet_type == "ChangeBackgroundImage" && field_matches("background")
        }
        ProjectAssetKind::Voices => snippet_type == "Talk" && field_matches("voice"),
        ProjectAssetKind::Models => {
            (matches!(
                snippet_type,
                "LayoutAppear" | "LayoutClear" | "Move" | "Motion" | "DoParam" | "Talk"
            ) && field_matches("model"))
                || (snippet_type == "ApplyEffect" && effect_model_matches())
        }
    }
}

fn rewrite_asset_references(
    story: &mut Value,
    kind: ProjectAssetKind,
    old_key: &str,
    new_key: &str,
) {
    let Some(snippets) = story.get_mut("snippets").and_then(Value::as_array_mut) else {
        return;
    };
    rewrite_asset_references_in_list(snippets, kind, old_key, new_key);
}

fn rewrite_asset_references_in_list(
    snippets: &mut [Value],
    kind: ProjectAssetKind,
    old_key: &str,
    new_key: &str,
) {
    for snippet in snippets {
        let snippet_type = snippet
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(data) = snippet.get_mut("data").and_then(Value::as_object_mut) {
            if kind == ProjectAssetKind::Models && snippet_type == "ApplyEffect" {
                if let Some(target) = data.get_mut("target").and_then(Value::as_object_mut) {
                    if target.get("type").and_then(Value::as_str) == Some("Model")
                        && target.get("model").and_then(Value::as_str) == Some(old_key)
                    {
                        target.insert("model".to_string(), Value::String(new_key.to_string()));
                    }
                }
            }
            let field = match kind {
                ProjectAssetKind::Backgrounds if snippet_type == "ChangeBackgroundImage" => {
                    Some("background")
                }
                ProjectAssetKind::Voices if snippet_type == "Talk" => Some("voice"),
                ProjectAssetKind::Models
                    if matches!(
                        snippet_type.as_str(),
                        "LayoutAppear" | "LayoutClear" | "Move" | "Motion" | "DoParam" | "Talk"
                    ) =>
                {
                    Some("model")
                }
                _ => None,
            };
            if let Some(field) = field {
                if data.get(field).and_then(Value::as_str) == Some(old_key) {
                    data.insert(field.to_string(), Value::String(new_key.to_string()));
                }
            }
        }
        if snippet_type == "Parallel" {
            if let Some(children) = snippet.get_mut("snippets").and_then(Value::as_array_mut) {
                rewrite_asset_references_in_list(children, kind, old_key, new_key);
            }
        }
    }
}

fn rename_managed_asset_file(
    project_path: &Path,
    kind: ProjectAssetKind,
    asset: &mut Value,
    new_key: &str,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let Some(folder) = kind.asset_folder() else {
        return Ok(None);
    };
    let path = asset
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "文件资源缺少 path".to_string())?;
    let extension = file_extension(Path::new(path))?;
    let expected_prefix = format!("assets/{folder}/");
    if !path.starts_with(&expected_prefix) || Path::new(path).components().count() != 3 {
        return Err("只能重命名由项目管理的资源文件".into());
    }
    let from = resolve_project_file(project_path, path)?;
    if !from.exists() {
        return Err("受管资源文件不存在".into());
    }
    let new_relative_path = format!("assets/{folder}/{new_key}.{extension}");
    let to = resolve_project_file(project_path, &new_relative_path)?;
    if to.exists() {
        return Err("新资源键对应的文件已存在".into());
    }
    let object = asset
        .as_object_mut()
        .ok_or_else(|| "资源记录必须是对象".to_string())?;
    object.insert("path".to_string(), Value::String(new_relative_path));
    Ok(Some((from, to)))
}

fn managed_asset_file(
    project_path: &Path,
    kind: ProjectAssetKind,
    asset: &Value,
) -> Result<Option<PathBuf>, String> {
    let Some(folder) = kind.asset_folder() else {
        return Ok(None);
    };
    let Some(path) = asset.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let expected_prefix = format!("assets/{folder}/");
    if !path.starts_with(&expected_prefix) || Path::new(path).components().count() != 3 {
        return Ok(None);
    }
    Ok(Some(resolve_project_file(project_path, path)?))
}

fn write_json_transaction(project_path: &Path, entries: &[(&str, &Value)]) -> Result<(), String> {
    let transaction_id = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    );
    let mut prepared: Vec<(PathBuf, PathBuf, Option<Vec<u8>>)> = Vec::new();

    for (relative_path, value) in entries {
        let target = resolve_project_file(project_path, relative_path)?;
        let temporary = target.with_extension(format!("json.{transaction_id}.tmp"));
        let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        fs::write(&temporary, serialized)
            .map_err(|error| format!("写入事务临时文件失败: {error}"))?;
        let original = if target.exists() {
            Some(fs::read(&target).map_err(|error| format!("读取事务备份失败: {error}"))?)
        } else {
            None
        };
        prepared.push((target, temporary, original));
    }

    let mut committed = 0usize;
    for (target, temporary, _) in &prepared {
        if let Err(error) = fs::rename(temporary, target) {
            for (restore_target, _, original) in prepared.iter().take(committed) {
                match original {
                    Some(content) => {
                        let _ = fs::write(restore_target, content);
                    }
                    None => {
                        let _ = fs::remove_file(restore_target);
                    }
                }
            }
            for (_, pending_temporary, _) in prepared.iter().skip(committed) {
                let _ = fs::remove_file(pending_temporary);
            }
            return Err(format!("提交资源重命名事务失败: {error}"));
        }
        committed += 1;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_keys_are_normalized_and_stable() {
        assert_eq!(normalize_asset_key("My Background 01"), "my-background-01");
        assert_eq!(normalize_asset_key("中文背景"), "asset");
        assert!(validate_asset_key("bg_f001201").is_ok());
        assert!(validate_asset_key("Not Valid").is_err());
    }

    #[test]
    fn finds_nested_story_asset_references() {
        let story = json!({
            "version": 1,
            "snippets": [
                {
                    "id": "f6e5e9d4-bce5-4c44-bca9-92f529e3fcd2",
                    "type": "Parallel",
                    "delay": 0,
                    "snippets": [
                        {
                            "id": "43a588ca-e5ca-4a7c-9e00-f1547fa4b35a",
                            "type": "Talk",
                            "delay": 0,
                            "data": { "speaker": "A", "content": "B", "model": "miku", "voice": "line-1" }
                        }
                    ]
                }
            ]
        });

        let references = find_asset_references(&story, ProjectAssetKind::Voices, "line-1");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].path, "1.1");
        assert_eq!(references[0].snippet_type, "Talk");
    }

    #[test]
    fn rewrites_only_matching_asset_reference_kind() {
        let mut story = json!({
            "version": 1,
            "snippets": [
                {
                    "type": "Talk",
                    "delay": 0,
                    "data": { "speaker": "A", "content": "B", "model": "miku", "voice": "miku" }
                },
                {
                    "type": "ChangeBackgroundImage",
                    "delay": 0,
                    "data": { "background": "miku" }
                },
                {
                    "type": "ApplyEffect",
                    "delay": 0,
                    "data": {
                        "effectId": "model-blur",
                        "target": { "type": "Model", "model": "miku" },
                        "effect": { "type": "Blur", "strength": 8, "quality": 2, "kernelSize": 5 },
                        "duration": 0.3
                    }
                }
            ]
        });

        let model_references = find_asset_references(&story, ProjectAssetKind::Models, "miku");
        assert_eq!(model_references.len(), 2);

        rewrite_asset_references(&mut story, ProjectAssetKind::Models, "miku", "miku-2");

        assert_eq!(story["snippets"][0]["data"]["model"], "miku-2");
        assert_eq!(story["snippets"][0]["data"]["voice"], "miku");
        assert_eq!(story["snippets"][1]["data"]["background"], "miku");
        assert_eq!(story["snippets"][2]["data"]["target"]["model"], "miku-2");
    }
}
