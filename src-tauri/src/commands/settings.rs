use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub follow_system: bool,
    pub manual_theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSettings {
    pub memory_size_mb: u32,
    pub render_precision: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub appearance: AppearanceSettings,
    pub playback: PlaybackSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
}

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    dir.join("config.json")
}

fn ensure_parent(path: &PathBuf) {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).ok();
        }
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Option<AppSettings> {
    let path = config_path(&app);
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = config_path(&app);
    ensure_parent(&path);
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
