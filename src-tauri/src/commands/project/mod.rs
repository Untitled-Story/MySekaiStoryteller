pub mod assets;
pub mod metadata;
pub mod model_registry;
pub mod paths;
pub mod story;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

use super::settings::get_settings;

const STORY_FILE: &str = "story.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsSummary {
    pub models: u64,
    pub backgrounds: u64,
    pub voices: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub title: String,
    pub last_modified: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_summary: Option<AssetsSummary>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = get_settings(app.clone());
    let dir = settings
        .and_then(|s| s.workspace_dir)
        .ok_or_else(|| "数据保存路径未设置".to_string())?;
    Ok(PathBuf::from(dir))
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("projects"))
}

fn validate_project_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("项目名称不能为空".into());
    }
    if name.contains(|c: char| "<>:\"/\\|?*".contains(c)) {
        return Err("项目名称不能包含特殊字符: < > : \" / \\ | ? *".into());
    }
    if name.len() > 255 {
        return Err("项目名称过长(最多255个字符)".into());
    }
    Ok(())
}

fn read_metadata(project_path: &Path) -> Option<ProjectMetadata> {
    let meta_path = project_path.join("metadata.json");
    let raw = fs::read_to_string(&meta_path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_metadata(project_path: &Path, metadata: &ProjectMetadata) -> Result<(), String> {
    let meta_path = project_path.join("metadata.json");
    let json = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())
}

fn write_default_project_files(project_path: &Path) -> Result<(), String> {
    write_project_json(project_path, "assets.json", &default_assets_json())?;
    write_project_json(project_path, STORY_FILE, &default_story_json())
}

fn default_assets_json() -> serde_json::Value {
    serde_json::json!({
        "models": {},
        "backgrounds": {},
        "voices": {}
    })
}

fn default_story_json() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "snippets": []
    })
}

fn write_project_json(
    project_path: &Path,
    relative_path: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let file_path = resolve_project_file(project_path, relative_path)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&file_path, json).map_err(|e| e.to_string())
}

fn read_project_json_or_default(
    project_path: &Path,
    relative_path: &str,
    default_value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let file_path = resolve_project_file(project_path, relative_path)?;
    if !file_path.exists() {
        return Ok(default_value);
    }

    read_json_file(&file_path)
}

fn read_json_file(file_path: &Path) -> Result<serde_json::Value, String> {
    let raw = fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败 {}: {e}", file_path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败 {}: {e}", file_path.display()))
}

fn resolve_project_file(project_path: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("项目文件路径不能是绝对路径".into());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("项目文件路径不能越过项目目录".into());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("项目文件路径不能为空".into());
    }

    Ok(project_path.join(normalized))
}

fn project_path(app: &AppHandle, project_name: &str) -> Result<PathBuf, String> {
    validate_project_name(project_name)?;
    let dir = projects_dir(app)?;
    let path = dir.join(project_name);
    if !path.exists() {
        return Err("项目不存在".into());
    }
    Ok(path)
}

fn touch_metadata(project_path: &Path) -> Result<(), String> {
    if let Some(mut metadata) = read_metadata(project_path) {
        metadata.last_modified = now_millis();
        write_metadata(project_path, &metadata)?;
    }
    Ok(())
}

fn count_json_object_keys(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|v| v.as_object())
        .map(|v| v.len() as u64)
        .unwrap_or(0)
}

fn update_assets_summary(project_path: &Path, assets: &serde_json::Value) -> Result<(), String> {
    if let Some(mut metadata) = read_metadata(project_path) {
        metadata.last_modified = now_millis();
        metadata.assets_summary = Some(AssetsSummary {
            models: count_json_object_keys(assets, "models"),
            backgrounds: count_json_object_keys(assets, "backgrounds"),
            voices: count_json_object_keys(assets, "voices"),
        });
        write_metadata(project_path, &metadata)?;
    }
    Ok(())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
