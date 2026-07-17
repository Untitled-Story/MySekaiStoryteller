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
use std::str::FromStr;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

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
    if let Some(dir) = settings.and_then(|s| s.workspace_dir).filter(|value| !value.trim().is_empty())
    {
        return Ok(PathBuf::from(dir));
    }

    // Mobile / first-run after clear-data: settings may not have workspaceDir yet while the
    // frontend is still auto-confirming the default app data directory. Fall back so import
    // and other project commands remain usable.
    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("数据保存路径未设置，且无法获取默认目录: {error}"))?;
    log::warn!(
        target: "backend::project",
        "workspace_dir missing; falling back to app_data_dir={}",
        fallback.display()
    );
    fs::create_dir_all(&fallback).map_err(|error| format!("创建默认数据目录失败: {error}"))?;
    Ok(fallback)
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("projects");
    fs::create_dir_all(&dir).map_err(|error| format!("创建项目目录失败: {error}"))?;
    Ok(dir)
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

/// Resolve a picker path that may be a local file path or an Android `content://` URI.
/// When the source is a content URI (or otherwise not a regular local file), copy it into
/// the app cache so subsequent filesystem APIs can open it as a normal path.
pub(crate) fn materialize_picked_file(
    app: &AppHandle,
    source_path: &str,
    preferred_extension: Option<&str>,
) -> Result<PathBuf, String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err("选择的文件路径为空".into());
    }

    log::info!(
        target: "backend::fs",
        "materialize_picked_file begin source={}",
        trimmed
    );

    // Prefer a direct local path only when this process can actually open it.
    // On Android 10+, /sdcard paths may exist (is_file=true) but still return EACCES.
    let local = PathBuf::from(trimmed);
    if local.is_file() {
        match fs::File::open(&local) {
            Ok(_) => return Ok(local),
            Err(error) => {
                log::warn!(
                    target: "backend::fs",
                    "materialize_picked_file local path unreadable path={} error={}; trying alternate open",
                    local.display(),
                    error
                );
            }
        }
    }

    // Android Downloads often returns:
    // content://.../document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FTest.sest
    // Decode that embedded absolute path and try it first.
    if let Some(decoded_local) = decode_android_raw_content_path(trimmed) {
        if decoded_local.is_file() {
            // On Android 11+, apps often cannot open /storage/... even when the path
            // string is known. Only short-circuit when the process can actually read it.
            match fs::File::open(&decoded_local) {
                Ok(_) => {
                    log::info!(
                        target: "backend::fs",
                        "materialize_picked_file using decoded local path={}",
                        decoded_local.display()
                    );
                    return Ok(decoded_local);
                }
                Err(error) => {
                    log::warn!(
                        target: "backend::fs",
                        "materialize_picked_file decoded local path unreadable path={} error={}",
                        decoded_local.display(),
                        error
                    );
                }
            }
        } else {
            log::warn!(
                target: "backend::fs",
                "materialize_picked_file decoded local path missing path={}",
                decoded_local.display()
            );
        }
    }

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?
        .join("picked-files");
    fs::create_dir_all(&cache_root).map_err(|error| format!("创建缓存目录失败: {error}"))?;

    let file_name = guessed_picked_file_name(trimmed, preferred_extension);
    let destination = cache_root.join(format!("{}-{}", now_millis(), file_name));

    // Prefer bulk read via the FS plugin (handles content:// descriptors reliably),
    // then fall back to streaming copy if needed.
    let copied_len = match app.fs().read(FilePath::from_str(trimmed).map_err(|error| {
        format!("解析选择的文件路径失败: {error}")
    })?) {
        Ok(bytes) => {
            fs::write(&destination, &bytes).map_err(|error| format!("写入临时文件失败: {error}"))?;
            bytes.len() as u64
        }
        Err(read_error) => {
            log::warn!(
                target: "backend::fs",
                "materialize_picked_file fs.read failed source={} error={}; fallback to stream copy",
                trimmed,
                read_error
            );
            let mut open_options = OpenOptions::new();
            open_options.read(true);
            let mut source = open_picked_path(app, trimmed, open_options).map_err(|error| {
                format!("无法打开选择的文件 ({error}; read_error={read_error}; source={trimmed})")
            })?;
            let mut target = fs::File::create(&destination)
                .map_err(|error| format!("创建临时文件失败: {error}"))?;
            let written = std::io::copy(&mut source, &mut target)
                .map_err(|error| format!("复制选择的文件失败: {error}"))?;
            target
                .sync_all()
                .map_err(|error| format!("刷新临时文件失败: {error}"))?;
            written
        }
    };

    // Reject empty materializations early. Android SAVE_DOCUMENT creates a 0-byte
    // content URI; re-importing that empty placeholder must fail with a clear error.
    if copied_len == 0 {
        let _ = fs::remove_file(&destination);
        return Err(format!(
            "选择的文件为空或无法读取，请重新导出后再导入 (source={trimmed})"
        ));
    }

    log::info!(
        target: "backend::fs",
        "materialized picked file source={} destination={} bytes={}",
        trimmed,
        destination.display(),
        copied_len
    );
    Ok(destination)
}

/// Write bytes to a save-dialog destination that may be a local path or content URI.
pub(crate) fn write_picked_destination(
    app: &AppHandle,
    destination_path: &str,
    source_file: &Path,
) -> Result<(), String> {
    let trimmed = destination_path.trim();
    if trimmed.is_empty() {
        return Err("导出路径不能为空".into());
    }
    if !source_file.is_file() {
        return Err("导出临时文件不存在".into());
    }

    let local = PathBuf::from(trimmed);
    if !is_uri_like_path(trimmed) {
        if let Some(parent) = local.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建导出目录失败: {error}"))?;
        }
        fs::copy(source_file, &local).map_err(|error| format!("写入导出文件失败: {error}"))?;
        if let Ok(file) = fs::File::open(&local) {
            let _ = file.sync_all();
        }
        log::info!(
            target: "backend::fs",
            "wrote export destination path={} bytes={}",
            local.display(),
            fs::metadata(&local).map(|m| m.len()).unwrap_or(0)
        );
        return Ok(());
    }

    let mut open_options = OpenOptions::new();
    open_options.write(true).truncate(true).create(true);
    let mut target = open_picked_path(app, trimmed, open_options)?;
    let mut source =
        fs::File::open(source_file).map_err(|error| format!("打开导出临时文件失败: {error}"))?;
    let written = std::io::copy(&mut source, &mut target)
        .map_err(|error| format!("写入导出文件失败: {error}"))?;
    target
        .sync_all()
        .map_err(|error| format!("刷新导出文件失败: {error}"))?;
    if written == 0 {
        return Err("导出文件写入为空".into());
    }
    log::info!(
        target: "backend::fs",
        "wrote export destination uri={} bytes={}",
        trimmed,
        written
    );
    Ok(())
}

fn open_picked_path(
    app: &AppHandle,
    path: &str,
    options: OpenOptions,
) -> Result<fs::File, String> {
    let file_path =
        FilePath::from_str(path).map_err(|error| format!("解析文件路径失败: {error}"))?;
    match app.fs().open(file_path.clone(), options.clone()) {
        Ok(file) => Ok(file),
        Err(primary_error) => {
            // Android providers are picky about mode strings ("r", "w", "wt", "rw" ...).
            let mut attempts: Vec<OpenOptions> = Vec::new();
            let mut read_only = OpenOptions::new();
            read_only.read(true);
            attempts.push(read_only);
            let mut write_only = OpenOptions::new();
            write_only.write(true).truncate(true);
            attempts.push(write_only);
            let mut read_write = OpenOptions::new();
            read_write.read(true).write(true).truncate(true);
            attempts.push(read_write);
            for attempt in attempts {
                if let Ok(file) = app.fs().open(file_path.clone(), attempt) {
                    return Ok(file);
                }
            }
            Err(format!("打开文件失败: {primary_error}"))
        }
    }
}

fn is_uri_like_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.starts_with("content://")
        || lowered.starts_with("file://")
        || (lowered.contains("://") && !Path::new(path).exists())
}


fn decode_android_raw_content_path(source_path: &str) -> Option<PathBuf> {
    let lowered = source_path.to_ascii_lowercase();
    if !lowered.starts_with("content://") {
        return None;
    }
    // Common patterns:
    // .../document/raw%3A%2Fstorage%2F...
    // .../document/raw:/storage/...
    let marker = if source_path.contains("raw%3A") {
        "raw%3A"
    } else if source_path.contains("raw:") {
        "raw:"
    } else {
        return None;
    };
    let encoded = source_path.split(marker).nth(1)?;
    let encoded = encoded
        .split('&')
        .next()?
        .split('#')
        .next()?
        .trim_matches('/');
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?
        .into_owned();
    let decoded = decoded.trim_start_matches("raw:");
    let path = PathBuf::from(decoded);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

fn guessed_picked_file_name(source_path: &str, preferred_extension: Option<&str>) -> String {
    let fallback = preferred_extension
        .map(|extension| format!("picked.{extension}"))
        .unwrap_or_else(|| "picked.bin".to_string());

    let candidate = source_path
        .rsplit(['/', '\\', ':'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(fallback.as_str());

    let sanitized: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return fallback;
    }

    if let Some(extension) = preferred_extension {
        let has_extension = Path::new(&sanitized)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension));
        if !has_extension {
            return format!("{sanitized}.{extension}");
        }
    }

    sanitized
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
