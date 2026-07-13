use std::fs;
use std::time::Instant;
use tauri::AppHandle;

use super::{
    now_millis, project_path, projects_dir, read_metadata, validate_project_name,
    write_default_project_files, write_metadata, AssetsSummary, ProjectMetadata,
};

#[tauri::command]
pub fn get_projects(app: AppHandle) -> Result<Vec<String>, String> {
    let started_at = Instant::now();
    let dir = projects_dir(&app)?;
    if !dir.exists() {
        log::info!(target: "backend::project", "projects.load completed count=0");
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&dir).map_err(|error| {
        log::error!(target: "backend::project", "projects.load read_dir_failed error={error}");
        error.to_string()
    })?;
    let projects: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .filter(|e| e.path().join("metadata.json").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    log::info!(
        target: "backend::project",
        "projects.load completed count={} duration_ms={}",
        projects.len(),
        started_at.elapsed().as_millis()
    );
    Ok(projects)
}

#[tauri::command]
pub fn get_project_metadata(
    app: AppHandle,
    project_name: String,
) -> Result<Option<ProjectMetadata>, String> {
    let project_path = project_path(&app, &project_name)?;
    Ok(read_metadata(&project_path))
}

#[tauri::command]
pub fn set_project_metadata(
    app: AppHandle,
    project_name: String,
    metadata: ProjectMetadata,
) -> Result<(), String> {
    let project_path = project_path(&app, &project_name)?;
    write_metadata(&project_path, &metadata)
}

#[tauri::command]
pub fn create_project(app: AppHandle, project_name: String) -> Result<(), String> {
    validate_project_name(&project_name)?;
    let dir = projects_dir(&app)?;
    let project_path = dir.join(&project_name);

    if project_path.exists() {
        return Err("该项目名称已存在".into());
    }

    fs::create_dir_all(&project_path).map_err(|e| format!("创建项目失败: {e}"))?;

    let metadata = ProjectMetadata {
        title: project_name,
        last_modified: now_millis(),
        assets_summary: Some(AssetsSummary {
            models: 0,
            backgrounds: 0,
            voices: 0,
        }),
    };
    write_metadata(&project_path, &metadata)?;
    write_default_project_files(&project_path)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, project_name: String) -> Result<(), String> {
    validate_project_name(&project_name)?;
    let dir = projects_dir(&app)?;
    let project_path = dir.join(&project_name);

    if !project_path.exists() {
        return Err("项目不存在".into());
    }

    fs::remove_dir_all(&project_path).map_err(|e| format!("删除项目失败: {e}"))
}

#[tauri::command]
pub fn rename_project(app: AppHandle, old_name: String, new_name: String) -> Result<(), String> {
    validate_project_name(&old_name)?;
    validate_project_name(&new_name)?;
    let dir = projects_dir(&app)?;
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
