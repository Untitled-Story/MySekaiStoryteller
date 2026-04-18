use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::settings::get_settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub title: String,
    pub last_modified: u64,
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = get_settings(app.clone());
    let dir = settings
        .and_then(|s| s.workspace_dir)
        .ok_or_else(|| "工作目录未设置".to_string())?;
    Ok(PathBuf::from(dir))
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tauri::command]
pub fn get_default_workspace_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_workspace(app: AppHandle) -> Option<String> {
    let settings = get_settings(app);
    settings.and_then(|s| s.workspace_dir)
}

#[tauri::command]
pub fn get_projects(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = workspace_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let projects: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .filter(|e| e.path().join("metadata.json").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    Ok(projects)
}

#[tauri::command]
pub fn get_project_metadata(app: AppHandle, project_name: String) -> Result<Option<ProjectMetadata>, String> {
    let dir = workspace_dir(&app)?;
    let project_path = dir.join(&project_name);
    Ok(read_metadata(&project_path))
}

#[tauri::command]
pub fn set_project_metadata(
    app: AppHandle,
    project_name: String,
    metadata: ProjectMetadata,
) -> Result<(), String> {
    let dir = workspace_dir(&app)?;
    let project_path = dir.join(&project_name);
    if !project_path.exists() {
        return Err("项目不存在".into());
    }
    write_metadata(&project_path, &metadata)
}

#[tauri::command]
pub fn create_project(app: AppHandle, project_name: String) -> Result<(), String> {
    validate_project_name(&project_name)?;
    let dir = workspace_dir(&app)?;
    let project_path = dir.join(&project_name);

    if project_path.exists() {
        return Err("该项目名称已存在".into());
    }

    fs::create_dir_all(&project_path).map_err(|e| format!("创建项目失败: {e}"))?;

    let metadata = ProjectMetadata {
        title: project_name,
        last_modified: now_millis(),
    };
    write_metadata(&project_path, &metadata)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, project_name: String) -> Result<(), String> {
    validate_project_name(&project_name)?;
    let dir = workspace_dir(&app)?;
    let project_path = dir.join(&project_name);

    if !project_path.exists() {
        return Err("项目不存在".into());
    }

    fs::remove_dir_all(&project_path).map_err(|e| format!("删除项目失败: {e}"))
}

#[tauri::command]
pub fn rename_project(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    validate_project_name(&old_name)?;
    validate_project_name(&new_name)?;
    let dir = workspace_dir(&app)?;
    let old_path = dir.join(&old_name);
    let new_path = dir.join(&new_name);

    if !old_path.exists() {
        return Err("原项目不存在".into());
    }
    if new_path.exists() {
        return Err("该项目名称已存在".into());
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("重命名项目失败: {e}"))?;

    if let Some(mut metadata) = read_metadata(&new_path) {
        metadata.title = new_name;
        metadata.last_modified = now_millis();
        write_metadata(&new_path, &metadata)?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_project_path(app: AppHandle, project_name: String) -> Result<String, String> {
    let dir = workspace_dir(&app)?;
    let project_path = dir.join(&project_name);
    if !project_path.exists() {
        return Err("项目不存在".into());
    }
    Ok(project_path.to_string_lossy().to_string())
}
