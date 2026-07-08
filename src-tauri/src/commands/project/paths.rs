use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::commands::settings::get_settings;

use super::{data_dir, project_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFontInfo {
    pub family: String,
    pub file_name: String,
    pub path: String,
}

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
pub fn get_data_fonts(app: AppHandle) -> Result<Vec<DataFontInfo>, String> {
    let root = data_dir(&app)?;
    let mut fonts: Vec<DataFontInfo> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    let folder = root.join("fonts");
    collect_data_fonts(&root, &folder, &mut fonts, &mut seen_paths)?;

    fonts.sort_by(|left, right| {
        left.file_name
            .to_lowercase()
            .cmp(&right.file_name.to_lowercase())
    });
    Ok(fonts)
}

#[tauri::command]
pub fn get_project_path(app: AppHandle, project_name: String) -> Result<String, String> {
    let project_path = project_path(&app, &project_name)?;
    Ok(project_path.to_string_lossy().to_string())
}

fn collect_data_fonts(
    root: &Path,
    folder: &Path,
    fonts: &mut Vec<DataFontInfo>,
    seen_paths: &mut HashSet<String>,
) -> Result<(), String> {
    if !folder.exists() {
        return Ok(());
    }

    for entry_result in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let path: PathBuf = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        if metadata.is_dir() {
            collect_data_fonts(root, &path, fonts, seen_paths)?;
            continue;
        }

        if !metadata.is_file() || !is_font_file(&path) {
            continue;
        }

        let relative_path = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if !seen_paths.insert(relative_path.clone()) {
            continue;
        }

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| relative_path.clone());
        let family = path
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());

        fonts.push(DataFontInfo {
            family,
            file_name,
            path: relative_path,
        });
    }

    Ok(())
}

fn is_font_file(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "ttf" | "otf" | "woff" | "woff2"
    )
}
