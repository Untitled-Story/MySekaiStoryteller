pub mod archive;
pub mod assets;
pub mod metadata;
pub mod model_registry;
pub mod paths;
pub mod story;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
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

fn write_project_json_with_backup(
    project_path: &Path,
    relative_path: &str,
    backup_relative_path: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let file_path = resolve_project_file(project_path, relative_path)?;
    let backup_path = resolve_project_file(project_path, backup_relative_path)?;
    let parent = file_path
        .parent()
        .ok_or_else(|| "项目文件缺少父目录".to_string())?;
    if backup_path.parent() != Some(parent) {
        return Err("项目文件与备份文件必须位于同一目录".into());
    }
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "项目文件名无效".to_string())?;
    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", unique_write_suffix()));
    let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut temporary_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("创建项目临时文件失败: {error}"))?;
    if let Err(error) = temporary_file
        .write_all(&serialized)
        .and_then(|_| temporary_file.sync_all())
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("写入项目临时文件失败: {error}"));
    }
    drop(temporary_file);

    if file_path.exists() {
        if backup_path.exists() {
            if let Err(error) = fs::remove_file(&backup_path) {
                let _ = fs::remove_file(&temporary_path);
                return Err(format!("清理旧项目备份失败: {error}"));
            }
        }
        if let Err(error) = fs::rename(&file_path, &backup_path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("创建项目备份失败: {error}"));
        }
    }

    if let Err(error) = fs::rename(&temporary_path, &file_path) {
        let restore_error = if backup_path.exists() {
            fs::rename(&backup_path, &file_path).err()
        } else {
            None
        };
        let _ = fs::remove_file(&temporary_path);
        return match restore_error {
            Some(restore_error) => Err(format!(
                "替换项目文件失败: {error}; 恢复备份也失败: {restore_error}"
            )),
            None => Err(format!("替换项目文件失败: {error}")),
        };
    }

    Ok(())
}

fn unique_write_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
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

fn read_project_json_or_backup(
    project_path: &Path,
    relative_path: &str,
    backup_relative_path: &str,
    default_value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let file_path = resolve_project_file(project_path, relative_path)?;
    let backup_path = resolve_project_file(project_path, backup_relative_path)?;

    if file_path.exists() {
        match read_json_file(&file_path) {
            Ok(value) => return Ok(value),
            Err(primary_error) if backup_path.exists() => {
                return read_json_file(&backup_path).map_err(|backup_error| {
                    format!("主项目文件与备份均无法读取: {primary_error}; 备份错误: {backup_error}")
                });
            }
            Err(error) => return Err(error),
        }
    }

    if backup_path.exists() {
        return read_json_file(&backup_path);
    }

    Ok(default_value)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_write_replaces_target_and_keeps_previous_backup() {
        let project_path =
            std::env::temp_dir().join(format!("mss-story-write-{}", unique_write_suffix()));
        fs::create_dir_all(&project_path).unwrap();
        let original = serde_json::json!({ "version": 1, "snippets": ["old"] });
        let updated = serde_json::json!({ "version": 1, "snippets": ["new"] });
        fs::write(
            project_path.join(STORY_FILE),
            serde_json::to_vec_pretty(&original).unwrap(),
        )
        .unwrap();

        write_project_json_with_backup(&project_path, STORY_FILE, "story.json.bak", &updated)
            .unwrap();

        assert_eq!(
            read_json_file(&project_path.join(STORY_FILE)).unwrap(),
            updated
        );
        assert_eq!(
            read_json_file(&project_path.join("story.json.bak")).unwrap(),
            original
        );
        assert!(!fs::read_dir(&project_path).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));

        fs::remove_file(project_path.join(STORY_FILE)).unwrap();
        assert_eq!(
            read_project_json_or_backup(
                &project_path,
                STORY_FILE,
                "story.json.bak",
                default_story_json(),
            )
            .unwrap(),
            original
        );

        fs::remove_dir_all(project_path).unwrap();
    }
}
