use tauri::{AppHandle, Manager};

use crate::commands::settings::get_settings;

use super::{data_dir, project_path};

#[tauri::command]
pub fn get_default_workspace_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_workspace(app: AppHandle) -> Option<String> {
    let settings = get_settings(app);
    settings.and_then(|s| s.workspace_dir)
}

#[tauri::command]
pub fn get_data_path(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_project_path(app: AppHandle, project_name: String) -> Result<String, String> {
    let project_path = project_path(&app, &project_name)?;
    Ok(project_path.to_string_lossy().to_string())
}
