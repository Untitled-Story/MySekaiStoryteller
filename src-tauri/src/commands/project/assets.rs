use tauri::AppHandle;

use super::{
    default_assets_json, project_path, read_project_json_or_default, update_assets_summary,
    write_project_json,
};

#[tauri::command]
pub fn get_project_assets(
    app: AppHandle,
    project_name: String,
) -> Result<serde_json::Value, String> {
    let project_path = project_path(&app, &project_name)?;
    read_project_json_or_default(&project_path, "assets.json", default_assets_json())
}

#[tauri::command]
pub fn set_project_assets(
    app: AppHandle,
    project_name: String,
    assets: serde_json::Value,
) -> Result<(), String> {
    let project_path = project_path(&app, &project_name)?;
    write_project_json(&project_path, "assets.json", &assets)?;
    update_assets_summary(&project_path, &assets)
}
