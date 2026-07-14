use tauri::AppHandle;

use super::{
    default_story_json, project_path, read_project_json_or_backup, touch_metadata,
    write_project_json_with_backup, STORY_FILE,
};

#[tauri::command]
pub fn get_project_story(
    app: AppHandle,
    project_name: String,
) -> Result<serde_json::Value, String> {
    let project_path = project_path(&app, &project_name)?;
    read_project_json_or_backup(
        &project_path,
        STORY_FILE,
        "story.json.bak",
        default_story_json(),
    )
}

#[tauri::command]
pub fn set_project_story(
    app: AppHandle,
    project_name: String,
    story: serde_json::Value,
) -> Result<(), String> {
    let project_path = project_path(&app, &project_name)?;
    write_project_json_with_backup(&project_path, STORY_FILE, "story.json.bak", &story)?;
    touch_metadata(&project_path)
}
