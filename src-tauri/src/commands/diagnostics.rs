use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const DIAGNOSTIC_DIR: &str = "diagnostics";
const MAX_LOG_FILES: usize = 10;
const MAX_LOG_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BUNDLE_AGE_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundle {
    id: String,
    file_name: String,
}

#[tauri::command]
pub async fn prepare_diagnostic_bundle(
    app: AppHandle,
    report: Value,
) -> Result<DiagnosticBundle, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_diagnostic_bundle_blocking(app, report))
        .await
        .map_err(|error| format!("诊断包任务失败: {error}"))?
}

fn prepare_diagnostic_bundle_blocking(
    app: AppHandle,
    report: Value,
) -> Result<DiagnosticBundle, String> {
    let cache_dir = diagnostic_cache_dir(&app)?;
    prune_old_bundles(&cache_dir);

    let timestamp = unix_seconds();
    let id = format!("{}-{}", std::process::id(), timestamp_millis());
    let file_name = format!("MySekaiStoryteller-diagnostics-{timestamp}.zip");
    let bundle_path = cache_dir.join(format!("{id}.zip"));
    let temporary_path = cache_dir.join(format!(".{id}.tmp"));

    if let Err(error) = write_diagnostic_archive(&app, &temporary_path, report, timestamp) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    fs::rename(&temporary_path, &bundle_path)
        .map_err(|error| format!("保存诊断包失败: {error}"))?;

    log::info!(
        target: "backend::diagnostics",
        "diagnostic bundle prepared id={} path={}",
        id,
        bundle_path.display()
    );
    Ok(DiagnosticBundle { id, file_name })
}

#[tauri::command]
pub async fn export_diagnostic_bundle(
    app: AppHandle,
    bundle_id: String,
    destination_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_diagnostic_bundle_blocking(app, bundle_id, destination_path)
    })
    .await
    .map_err(|error| format!("诊断包导出任务失败: {error}"))?
}

fn export_diagnostic_bundle_blocking(
    app: AppHandle,
    bundle_id: String,
    destination_path: String,
) -> Result<(), String> {
    validate_bundle_id(&bundle_id)?;
    let bundle_path = diagnostic_cache_dir(&app)?.join(format!("{bundle_id}.zip"));
    if !bundle_path.is_file() {
        return Err("诊断包不存在或已经导出".into());
    }

    crate::commands::project::write_picked_destination(&app, &destination_path, &bundle_path)?;
    let _ = fs::remove_file(&bundle_path);
    log::info!(
        target: "backend::diagnostics",
        "diagnostic bundle exported id={}",
        bundle_id
    );
    Ok(())
}

fn write_diagnostic_archive(
    app: &AppHandle,
    destination: &Path,
    report: Value,
    timestamp: u64,
) -> Result<(), String> {
    let output = File::create(destination).map_err(|error| format!("创建诊断包失败: {error}"))?;
    let mut archive = ZipWriter::new(output);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let manifest = json!({
        "format": "my-sekai-storyteller-diagnostics",
        "formatVersion": 1,
        "timestamp": timestamp,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "report": report,
    });
    archive
        .start_file("diagnostics.json", options)
        .map_err(|error| format!("写入诊断清单失败: {error}"))?;
    archive
        .write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|error| format!("生成诊断清单失败: {error}"))?
                .as_bytes(),
        )
        .map_err(|error| format!("写入诊断清单失败: {error}"))?;

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("获取日志目录失败: {error}"))?;
    for path in collect_log_files(&log_dir)? {
        append_log_file(&mut archive, options, &path)?;
    }
    archive
        .finish()
        .map_err(|error| format!("完成诊断包失败: {error}"))?;
    Ok(())
}

fn collect_log_files(log_dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !log_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<(SystemTime, PathBuf)> = fs::read_dir(log_dir)
        .map_err(|error| format!("读取日志目录失败: {error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("backend") && !name.starts_with("frontend") {
                return None;
            }
            Some((metadata.modified().unwrap_or(UNIX_EPOCH), entry.path()))
        })
        .collect();
    files.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(files
        .into_iter()
        .take(MAX_LOG_FILES)
        .map(|(_, path)| path)
        .collect())
}

fn append_log_file(
    archive: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    path: &Path,
) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "日志文件名无效".to_string())?;
    archive
        .start_file(format!("logs/{file_name}"), options)
        .map_err(|error| format!("写入日志文件失败: {error}"))?;
    let source = File::open(path).map_err(|error| format!("读取日志文件失败: {error}"))?;
    std::io::copy(&mut Read::take(source, MAX_LOG_FILE_BYTES), archive)
        .map_err(|error| format!("复制日志文件失败: {error}"))?;
    Ok(())
}

fn diagnostic_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?
        .join(DIAGNOSTIC_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("创建诊断缓存目录失败: {error}"))?;
    Ok(dir)
}

fn validate_bundle_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
    {
        return Err("诊断包 ID 无效".into());
    }
    Ok(())
}

fn prune_old_bundles(cache_dir: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if metadata.is_file()
            && now
                .duration_since(modified)
                .is_ok_and(|age| age.as_secs() > MAX_BUNDLE_AGE_SECONDS)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::validate_bundle_id;

    #[test]
    fn validates_generated_bundle_ids() {
        assert!(validate_bundle_id("1234-5678").is_ok());
        assert!(validate_bundle_id("../frontend").is_err());
        assert!(validate_bundle_id("content://logs").is_err());
    }
}
