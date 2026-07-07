use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default = "default_follow_system")]
    pub follow_system: bool,
    #[serde(default = "default_manual_theme")]
    pub manual_theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSettings {
    #[serde(default = "default_memory_size_mb")]
    pub memory_size_mb: u32,
    #[serde(default)]
    pub render_precision: RenderPrecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RenderPrecision {
    Number(f64),
    Auto(RenderPrecisionAuto),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RenderPrecisionAuto {
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub playback: PlaybackSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            follow_system: default_follow_system(),
            manual_theme: default_manual_theme(),
        }
    }
}

impl Default for PlaybackSettings {
    fn default() -> Self {
        Self {
            memory_size_mb: default_memory_size_mb(),
            render_precision: RenderPrecision::default(),
        }
    }
}

impl Default for RenderPrecision {
    fn default() -> Self {
        Self::Auto(RenderPrecisionAuto::Auto)
    }
}

fn default_follow_system() -> bool {
    true
}

fn default_manual_theme() -> String {
    "light".to_string()
}

fn default_memory_size_mb() -> u32 {
    128
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
