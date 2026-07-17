use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

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
    #[serde(default)]
    pub font: PlaybackFontSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub key: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub control: bool,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorShortcutSettings {
    #[serde(default = "default_editor_save_shortcut")]
    pub save: ShortcutBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerShortcutSettings {
    #[serde(default = "default_player_reload_shortcut")]
    pub reload: ShortcutBinding,
    #[serde(default = "default_player_enter_fullscreen_shortcut")]
    pub enter_fullscreen: ShortcutBinding,
    #[serde(default = "default_player_exit_fullscreen_shortcut")]
    pub exit_fullscreen: ShortcutBinding,
    #[serde(default = "default_player_close_shortcut")]
    pub close: ShortcutBinding,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    #[serde(default)]
    pub editor: EditorShortcutSettings,
    #[serde(default)]
    pub player: PlayerShortcutSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSettings {
    #[serde(default)]
    pub main_tour_version: u32,
    #[serde(default)]
    pub editor_tour_version: u32,
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
#[serde(tag = "source", rename_all = "camelCase")]
pub enum PlaybackFontSettings {
    Default,
    Data { family: String, path: String },
    System { family: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub playback: PlaybackSettings,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default)]
    pub onboarding: OnboardingSettings,
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
            font: PlaybackFontSettings::default(),
        }
    }
}

impl Default for EditorShortcutSettings {
    fn default() -> Self {
        Self {
            save: default_editor_save_shortcut(),
        }
    }
}

impl Default for PlayerShortcutSettings {
    fn default() -> Self {
        Self {
            reload: default_player_reload_shortcut(),
            enter_fullscreen: default_player_enter_fullscreen_shortcut(),
            exit_fullscreen: default_player_exit_fullscreen_shortcut(),
            close: default_player_close_shortcut(),
        }
    }
}

impl Default for RenderPrecision {
    fn default() -> Self {
        Self::Auto(RenderPrecisionAuto::Auto)
    }
}

impl Default for PlaybackFontSettings {
    fn default() -> Self {
        Self::Default
    }
}

fn default_follow_system() -> bool {
    true
}

fn default_language() -> String {
    "system".to_string()
}

fn default_manual_theme() -> String {
    "light".to_string()
}

fn default_memory_size_mb() -> u32 {
    128
}

fn shortcut(key: &str, primary: bool) -> ShortcutBinding {
    ShortcutBinding {
        key: key.to_string(),
        primary,
        control: false,
        meta: false,
        alt: false,
        shift: false,
    }
}

fn default_editor_save_shortcut() -> ShortcutBinding {
    shortcut("s", true)
}

fn default_player_reload_shortcut() -> ShortcutBinding {
    shortcut("r", true)
}

fn default_player_enter_fullscreen_shortcut() -> ShortcutBinding {
    shortcut("F11", false)
}

fn default_player_exit_fullscreen_shortcut() -> ShortcutBinding {
    shortcut("Escape", false)
}

fn default_player_close_shortcut() -> ShortcutBinding {
    shortcut("w", true)
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
    let started_at = Instant::now();
    let path = config_path(&app);
    if !path.exists() {
        log::info!(target: "backend::settings", "settings.load not_found");
        return None;
    }
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            log::error!(target: "backend::settings", "settings.load read_failed error={error}");
            return None;
        }
    };
    match serde_json::from_str(&raw) {
        Ok(settings) => {
            log::debug!(
                target: "backend::settings",
                "settings.load completed duration_ms={}",
                started_at.elapsed().as_millis()
            );
            Some(settings)
        }
        Err(error) => {
            log::error!(target: "backend::settings", "settings.load parse_failed error={error}");
            None
        }
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let started_at = Instant::now();
    let path = config_path(&app);
    ensure_parent(&path);
    let json = serde_json::to_string_pretty(&settings).map_err(|error| {
        log::error!(target: "backend::settings", "settings.save serialize_failed error={error}");
        error.to_string()
    })?;
    fs::write(&path, json).map_err(|error| {
        log::error!(target: "backend::settings", "settings.save write_failed error={error}");
        error.to_string()
    })?;
    if let Err(error) = app.emit("settings-changed", &settings) {
        log::warn!(target: "backend::settings", "settings.save emit_failed error={error}");
    }
    log::debug!(
        target: "backend::settings",
        "settings.save completed duration_ms={}",
        started_at.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn legacy_settings_receive_default_shortcuts() {
        let settings: AppSettings = serde_json::from_str("{}").expect("settings should parse");

        assert_eq!(settings.shortcuts.editor.save.key, "s");
        assert!(settings.shortcuts.editor.save.primary);
        assert_eq!(settings.shortcuts.player.reload.key, "r");
        assert_eq!(settings.shortcuts.player.enter_fullscreen.key, "F11");
        assert_eq!(settings.shortcuts.player.exit_fullscreen.key, "Escape");
        assert_eq!(settings.shortcuts.player.close.key, "w");
        assert_eq!(settings.language, "system");
        assert_eq!(settings.onboarding.main_tour_version, 0);
        assert_eq!(settings.onboarding.editor_tour_version, 0);
    }

    #[test]
    fn partial_shortcut_settings_keep_other_defaults() {
        let settings: AppSettings = serde_json::from_str(
            r#"{
                "shortcuts": {
                    "player": {
                        "reload": {
                            "key": "p",
                            "primary": true,
                            "alt": true,
                            "shift": false
                        }
                    }
                }
            }"#,
        )
        .expect("settings should parse");

        assert_eq!(settings.shortcuts.player.reload.key, "p");
        assert!(settings.shortcuts.player.reload.primary);
        assert!(!settings.shortcuts.player.reload.control);
        assert!(!settings.shortcuts.player.reload.meta);
        assert!(settings.shortcuts.player.reload.alt);
        assert_eq!(settings.shortcuts.player.enter_fullscreen.key, "F11");
        assert_eq!(settings.shortcuts.editor.save.key, "s");
    }
}
