use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::assets::validate_assets;
use super::model_registry::{find_model_entry_file, is_model_entry_json};
use super::{
    data_dir, materialize_picked_file, now_millis, project_path, projects_dir, read_json_file,
    read_metadata, validate_project_name, write_metadata, AssetsSummary, ProjectMetadata,
};

const ARCHIVE_FORMAT: &str = "my-sekai-storyteller-project";
const ARCHIVE_VERSION: u32 = 1;
const MAX_ARCHIVE_FILES: usize = 50_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectArchiveManifest {
    format: String,
    format_version: u32,
    app_version: String,
    exported_at: u64,
    project: ArchiveProject,
    models: Vec<ArchiveModel>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ArchiveProject {
    title: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveModel {
    id: String,
    path: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveInspection {
    pub title: String,
    pub suggested_title: String,
    pub project_exists: bool,
    pub model_count: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectImportConflict {
    Rename,
    Replace,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProjectResult {
    pub project_name: String,
    pub renamed_models: usize,
}

#[tauri::command]
pub fn inspect_project_archive(
    app: AppHandle,
    source_path: String,
) -> Result<ProjectArchiveInspection, String> {
    (|| -> Result<ProjectArchiveInspection, String> {
        let source = resolve_archive_source(&app, &source_path)?;
        log::info!(
            target: "backend::project",
            "archive.inspect begin source={} materialized={}",
            source_path,
            source.display()
        );
        let mut archive = open_archive(&source)?;
        validate_archive_entries(&mut archive)?;
        let manifest = read_manifest(&mut archive)?;
        validate_manifest(&manifest)?;
        validate_project_name(&manifest.project.title)?;
        validate_project_documents(&mut archive)?;

        let project_exists = projects_dir(&app)?.join(&manifest.project.title).exists();
        let suggested_title = next_project_name(&app, &manifest.project.title)?;
        log::info!(
            target: "backend::project",
            "archive.inspect completed title={} exists={} models={}",
            manifest.project.title,
            project_exists,
            manifest.models.len()
        );
        Ok(ProjectArchiveInspection {
            title: manifest.project.title,
            suggested_title,
            project_exists,
            model_count: manifest.models.len(),
        })
    })()
    .map_err(|error| {
        log::error!(
            target: "backend::project",
            "archive.inspect failed source={} error={}",
            source_path,
            error
        );
        error
    })
}

#[tauri::command]
pub fn export_project_archive(
    app: AppHandle,
    project_name: String,
    destination_path: String,
) -> Result<(), String> {
    let source_project = project_path(&app, &project_name)?;
    let destination_raw = destination_path.trim();
    if destination_raw.is_empty() {
        return Err("导出路径不能为空".into());
    }

    // Local filesystem destinations still get a normalized .sest path.
    // Android save dialogs return content:// URIs and must be written via the FS plugin.
    let local_destination = if looks_like_uri(destination_raw) {
        None
    } else {
        let destination = normalized_sest_path(destination_raw)?;
        if destination.starts_with(&source_project) {
            return Err("导出文件不能保存在项目目录内".into());
        }
        Some(destination)
    };

    let assets = read_json_file(&source_project.join("assets.json"))?;
    validate_assets(&assets)?;
    let model_ids = project_model_ids(&assets)?;
    let models_root = data_dir(&app)?.join("models");
    let mut models: Vec<ArchiveModel> = Vec::with_capacity(model_ids.len());
    for model_id in model_ids {
        let model_path = models_root.join(&model_id);
        if !model_path.is_dir() {
            return Err(format!("项目引用的模型不存在: {model_id}"));
        }
        models.push(ArchiveModel {
            id: model_id.clone(),
            path: format!("models/{model_id}"),
            sha256: directory_digest(&model_path)?,
        });
    }

    let metadata =
        read_metadata(&source_project).ok_or_else(|| "项目 metadata.json 无效".to_string())?;
    let manifest = ProjectArchiveManifest {
        format: ARCHIVE_FORMAT.into(),
        format_version: ARCHIVE_VERSION,
        app_version: app.package_info().version.to_string(),
        exported_at: now_millis(),
        project: ArchiveProject {
            title: metadata.title,
        },
        models,
    };

    let temporary = export_temp_path(&app, &project_name)?;
    if let Err(error) = write_archive(&temporary, &manifest, &source_project, &models_root) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    let publish_result = if let Some(destination) = local_destination.as_ref() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建导出目录失败: {error}"))?;
        }
        replace_export_file(&temporary, destination)
    } else {
        let result = super::write_picked_destination(&app, destination_raw, &temporary);
        let _ = fs::remove_file(&temporary);
        result
    };

    if let Err(error) = publish_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    log::info!(
        target: "backend::project",
        "project.export completed project={} path={}",
        project_name,
        destination_raw
    );
    Ok(())
}

fn looks_like_uri(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.starts_with("content://")
        || lowered.starts_with("file://")
        || (lowered.contains("://") && !Path::new(path).exists())
}

fn export_temp_path(app: &AppHandle, project_name: &str) -> Result<PathBuf, String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?
        .join("exports");
    fs::create_dir_all(&cache_root).map_err(|error| format!("创建导出缓存目录失败: {error}"))?;
    let safe_name: String = project_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    Ok(cache_root.join(format!("{safe_name}-{}.sest", super::unique_write_suffix())))
}

#[tauri::command]
pub fn import_project_archive(
    app: AppHandle,
    source_path: String,
    conflict: ProjectImportConflict,
) -> Result<ImportedProjectResult, String> {
    let source = resolve_archive_source(&app, &source_path)?;
    let mut archive = open_archive(&source)?;
    validate_archive_entries(&mut archive)?;
    let manifest = read_manifest(&mut archive)?;
    validate_manifest(&manifest)?;
    validate_project_name(&manifest.project.title)?;
    validate_project_documents(&mut archive)?;

    let root = data_dir(&app)?;
    let staging_root = root.join(".imports");
    fs::create_dir_all(&staging_root).map_err(|error| format!("创建导入临时目录失败: {error}"))?;
    let staging = staging_root.join(format!("import-{}", super::unique_write_suffix()));
    fs::create_dir(&staging).map_err(|error| format!("创建导入临时目录失败: {error}"))?;

    let import_result = import_from_archive(&app, &mut archive, &manifest, &staging, conflict);
    let _ = fs::remove_dir_all(&staging);
    import_result
}

fn import_from_archive(
    app: &AppHandle,
    archive: &mut ZipArchive<File>,
    manifest: &ProjectArchiveManifest,
    staging: &Path,
    conflict: ProjectImportConflict,
) -> Result<ImportedProjectResult, String> {
    extract_archive(archive, staging)?;
    let staged_project = staging.join("project");
    let mut assets = read_json_file(&staged_project.join("assets.json"))?;
    validate_assets(&assets)?;
    validate_staged_project(&staged_project, &assets, manifest)?;

    let models_root = data_dir(app)?.join("models");
    fs::create_dir_all(&models_root).map_err(|error| format!("创建模型目录失败: {error}"))?;
    let mut model_rewrites: BTreeMap<String, String> = BTreeMap::new();
    let mut model_moves: Vec<(PathBuf, PathBuf)> = Vec::new();
    for model in &manifest.models {
        validate_model_id(&model.id)?;
        let staged_model = staging.join(&model.path);
        if !staged_model.is_dir() {
            return Err(format!("归档缺少模型目录: {}", model.id));
        }
        let staged_digest = directory_digest(&staged_model)?;
        if staged_digest != model.sha256 {
            return Err(format!("模型文件校验失败: {}", model.id));
        }
        validate_model_directory(&staged_model, &model.id)?;

        let existing = models_root.join(&model.id);
        if !existing.exists() {
            model_moves.push((staged_model, existing));
            continue;
        }
        if directory_digest(&existing)? == staged_digest {
            continue;
        }
        let replacement_id = next_model_id(&models_root, &model.id);
        model_rewrites.insert(model.id.clone(), replacement_id.clone());
        model_moves.push((staged_model, models_root.join(replacement_id)));
    }
    rewrite_model_ids(&mut assets, &model_rewrites)?;
    fs::write(
        staged_project.join("assets.json"),
        serde_json::to_vec_pretty(&assets).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("更新导入项目模型引用失败: {error}"))?;

    let target_name = match conflict {
        ProjectImportConflict::Rename => next_project_name(app, &manifest.project.title)?,
        ProjectImportConflict::Replace => manifest.project.title.clone(),
    };
    let target_project = projects_dir(app)?.join(&target_name);
    let mut metadata =
        read_metadata(&staged_project).ok_or_else(|| "归档中的 metadata.json 无效".to_string())?;
    metadata.title = target_name.clone();
    metadata.last_modified = now_millis();
    metadata.assets_summary = Some(AssetsSummary {
        models: assets["models"]
            .as_object()
            .map_or(0, |items| items.len() as u64),
        backgrounds: assets["backgrounds"]
            .as_object()
            .map_or(0, |items| items.len() as u64),
        voices: assets["voices"]
            .as_object()
            .map_or(0, |items| items.len() as u64),
    });
    write_metadata(&staged_project, &metadata)?;

    let backup = staging.join("replaced-project");
    if target_project.exists() {
        match conflict {
            ProjectImportConflict::Rename => {
                return Err("自动生成的项目名称发生冲突，请重试".into())
            }
            ProjectImportConflict::Replace => fs::rename(&target_project, &backup)
                .map_err(|error| format!("备份同名项目失败: {error}"))?,
        }
    }

    let mut installed_models: Vec<PathBuf> = Vec::new();
    for (from, to) in &model_moves {
        if let Err(error) = fs::rename(from, to) {
            for installed in installed_models.iter().rev() {
                let _ = fs::remove_dir_all(installed);
            }
            if backup.exists() {
                let _ = fs::rename(&backup, &target_project);
            }
            return Err(format!("安装模型失败: {error}"));
        }
        installed_models.push(to.clone());
    }

    if let Err(error) = fs::rename(&staged_project, &target_project) {
        for installed in installed_models.iter().rev() {
            let _ = fs::remove_dir_all(installed);
        }
        if backup.exists() {
            let _ = fs::rename(&backup, &target_project);
        }
        return Err(format!("安装项目失败: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }

    log::info!(
        target: "backend::project",
        "project.import completed project={} renamed_models={}",
        target_name,
        model_rewrites.len()
    );
    Ok(ImportedProjectResult {
        project_name: target_name,
        renamed_models: model_rewrites.len(),
    })
}

fn write_archive(
    path: &Path,
    manifest: &ProjectArchiveManifest,
    project: &Path,
    models_root: &Path,
) -> Result<(), String> {
    let file = File::create(path).map_err(|error| format!("创建导出文件失败: {error}"))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file("manifest.json", options)
        .map_err(|error| format!("写入归档清单失败: {error}"))?;
    writer
        .write_all(&serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?)
        .map_err(|error| format!("写入归档清单失败: {error}"))?;

    add_directory(&mut writer, project, Path::new("project"), options, true)?;
    for model in &manifest.models {
        add_directory(
            &mut writer,
            &models_root.join(&model.id),
            Path::new(&model.path),
            options,
            false,
        )?;
    }
    let file = writer
        .finish()
        .map_err(|error| format!("完成归档写入失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("刷新归档文件失败: {error}"))?;
    Ok(())
}

fn add_directory(
    writer: &mut ZipWriter<File>,
    source: &Path,
    archive_root: &Path,
    options: SimpleFileOptions,
    filter_project_files: bool,
) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| format!("读取导出目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取导出文件失败: {error}"))?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "导出内容不能包含符号链接: {}",
                entry.path().display()
            ));
        }
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if filter_project_files
            && (name_text == ".DS_Store"
                || name_text.ends_with(".bak")
                || name_text.ends_with(".tmp"))
        {
            continue;
        }
        let archive_path = archive_root.join(&name);
        if file_type.is_dir() {
            add_directory(
                writer,
                &entry.path(),
                &archive_path,
                options,
                filter_project_files,
            )?;
        } else if file_type.is_file() {
            let archive_name = path_to_archive_name(&archive_path)?;
            writer
                .start_file(archive_name, options)
                .map_err(|error| format!("创建归档条目失败: {error}"))?;
            let mut file = File::open(entry.path()).map_err(|error| error.to_string())?;
            std::io::copy(&mut file, writer)
                .map_err(|error| format!("写入归档条目失败: {error}"))?;
        }
    }
    Ok(())
}

fn resolve_archive_source(app: &AppHandle, source_path: &str) -> Result<PathBuf, String> {
    // Android document pickers usually return content:// URIs (sometimes without a
    // filename extension, e.g. .../document/msf%3A11372). Materialize first, then
    // validate that the bytes are a real .sest zip archive.
    log::info!(
        target: "backend::project",
        "archive.resolve_source source={}",
        source_path
    );
    if !looks_like_possible_archive_source(source_path) {
        return Err(format!("请选择 .sest 项目归档 (source={source_path})"));
    }
    let source = materialize_picked_file(app, source_path, Some("sest")).map_err(|error| {
        log::error!(
            target: "backend::project",
            "archive.resolve_source materialize_failed source={} error={}",
            source_path,
            error
        );
        format!("选择的 .sest 文件不存在: {error}")
    })?;
    if !source.path.is_file() {
        return Err(format!(
            "选择的 .sest 文件不存在 (materialized={})",
            source.path.display()
        ));
    }
    // Do not open the zip here. ZipArchive holds the file handle, and calling
    // open_archive again immediately after can fail on some Android filesystems.
    // Callers validate the archive contents after materialization.
    Ok(source.path)
}

fn looks_like_possible_archive_source(source_path: &str) -> bool {
    let lowered = source_path.to_ascii_lowercase();
    // SAF / MediaStore URIs often omit the original file name.
    if lowered.starts_with("content://") || lowered.starts_with("file://") {
        return true;
    }
    if lowered.contains(".sest") {
        return true;
    }
    Path::new(source_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sest"))
}

fn normalized_sest_path(destination_path: &str) -> Result<PathBuf, String> {
    let mut destination = PathBuf::from(destination_path);
    if destination.as_os_str().is_empty() {
        return Err("导出路径不能为空".into());
    }
    if !destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sest"))
    {
        destination.set_extension("sest");
    }
    Ok(destination)
}

fn open_archive(source: &Path) -> Result<ZipArchive<File>, String> {
    let file = File::open(source).map_err(|error| format!("打开项目归档失败: {error}"))?;
    ZipArchive::new(file).map_err(|error| format!(".sest 归档无效: {error}"))
}

fn validate_archive_entries(archive: &mut ZipArchive<File>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_FILES {
        return Err(format!("归档文件数量超过限制: {}", archive.len()));
    }
    let mut total_size = 0_u64;
    let mut paths: HashSet<PathBuf> = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = validate_archive_path(entry.name())?;
        if !paths.insert(path) {
            return Err("归档包含重复路径".into());
        }
        if entry.is_symlink() {
            return Err("归档不能包含符号链接".into());
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "归档解压大小溢出".to_string())?;
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err("归档解压后大小超过 4 GiB 限制".into());
        }
    }
    Ok(())
}

fn validate_archive_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    if normalized.as_bytes().get(1) == Some(&b':') {
        return Err("归档包含 Windows 绝对路径".into());
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("归档包含绝对路径".into());
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("归档路径试图越过目标目录".into());
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err("归档包含空路径".into());
    }
    Ok(result)
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<ProjectArchiveManifest, String> {
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| "归档缺少 manifest.json".to_string())?;
    let mut raw = String::new();
    entry
        .read_to_string(&mut raw)
        .map_err(|error| format!("读取归档清单失败: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("归档清单无效: {error}"))
}

fn validate_manifest(manifest: &ProjectArchiveManifest) -> Result<(), String> {
    if manifest.format != ARCHIVE_FORMAT {
        return Err("文件不是 MySekaiStoryteller 项目归档".into());
    }
    if manifest.format_version != ARCHIVE_VERSION {
        return Err(format!("不支持的项目归档版本: {}", manifest.format_version));
    }
    let mut model_ids: HashSet<&str> = HashSet::new();
    for model in &manifest.models {
        validate_model_id(&model.id)?;
        if !model_ids.insert(&model.id) {
            return Err(format!("归档清单包含重复模型: {}", model.id));
        }
        if model.path != format!("models/{}", model.id) {
            return Err(format!("模型归档路径无效: {}", model.id));
        }
        if model.sha256.len() != 64 || !model.sha256.chars().all(|value| value.is_ascii_hexdigit())
        {
            return Err(format!("模型摘要无效: {}", model.id));
        }
    }
    Ok(())
}

fn validate_project_documents(archive: &mut ZipArchive<File>) -> Result<(), String> {
    for name in [
        "project/metadata.json",
        "project/story.json",
        "project/assets.json",
    ] {
        let mut entry = archive
            .by_name(name)
            .map_err(|_| format!("归档缺少 {name}"))?;
        let mut raw = String::new();
        entry
            .read_to_string(&mut raw)
            .map_err(|error| error.to_string())?;
        let value: Value =
            serde_json::from_str(&raw).map_err(|error| format!("{name} 无效: {error}"))?;
        match name {
            "project/metadata.json" => {
                serde_json::from_value::<ProjectMetadata>(value)
                    .map_err(|error| format!("{name} 格式无效: {error}"))?;
            }
            "project/story.json" => {
                if value.get("version").and_then(Value::as_u64).is_none()
                    || value.get("snippets").and_then(Value::as_array).is_none()
                {
                    return Err("project/story.json 格式无效".into());
                }
            }
            "project/assets.json" => validate_assets(&value)?,
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn validate_staged_project(
    project: &Path,
    assets: &Value,
    manifest: &ProjectArchiveManifest,
) -> Result<(), String> {
    let manifest_models: HashSet<&str> = manifest
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    for model_id in project_model_ids(assets)? {
        if !manifest_models.contains(model_id.as_str()) {
            return Err(format!("归档没有包含项目引用的模型: {model_id}"));
        }
    }
    for (collection, folder, allowed_extensions) in [
        (
            "backgrounds",
            "backgrounds",
            &["png", "jpg", "jpeg", "webp"][..],
        ),
        ("voices", "voices", &["ogg", "mp3", "wav", "m4a"][..]),
    ] {
        let entries = assets
            .get(collection)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("assets.{collection} 格式无效"))?;
        for asset in entries.values() {
            let relative = asset
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("assets.{collection} 缺少 path"))?;
            let expected_prefix = format!("assets/{folder}/");
            let relative_path = Path::new(relative);
            let extension = relative_path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .ok_or_else(|| format!("项目资源缺少扩展名: {relative}"))?;
            if !relative.starts_with(&expected_prefix)
                || relative_path.components().count() != 3
                || !allowed_extensions.contains(&extension.as_str())
            {
                return Err(format!("项目资源路径不受管理: {relative}"));
            }
            let path = validate_archive_path(relative)?;
            if !project.join(path).is_file() {
                return Err(format!("归档缺少项目资源: {relative}"));
            }
        }
    }
    Ok(())
}

fn extract_archive(archive: &mut ZipArchive<File>, destination: &Path) -> Result<(), String> {
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative = validate_archive_path(entry.name())?;
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn project_model_ids(assets: &Value) -> Result<Vec<String>, String> {
    let models = assets
        .get("models")
        .and_then(Value::as_object)
        .ok_or_else(|| "assets.models 格式无效".to_string())?;
    let mut ids: Vec<String> = models
        .values()
        .filter_map(|model| model.get("modelId").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    for id in &ids {
        validate_model_id(id)?;
    }
    Ok(ids)
}

fn validate_model_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) || id.contains('\0') {
        return Err(format!("模型 ID 无效: {id}"));
    }
    Ok(())
}

fn validate_model_directory(directory: &Path, model_id: &str) -> Result<(), String> {
    let entry = find_model_entry_file(directory)?
        .ok_or_else(|| format!("模型缺少 model3.json 或 model.json 入口: {model_id}"))?;
    let entry_json = read_json_file(&directory.join(entry))?;
    if !is_model_entry_json(&entry_json) {
        return Err(format!("模型入口无法识别: {model_id}"));
    }
    Ok(())
}

fn rewrite_model_ids(
    assets: &mut Value,
    rewrites: &BTreeMap<String, String>,
) -> Result<(), String> {
    let models: &mut Map<String, Value> = assets
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "assets.models 格式无效".to_string())?;
    for model in models.values_mut() {
        let Some(current) = model.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        if let Some(replacement) = rewrites.get(current) {
            model["modelId"] = Value::String(replacement.clone());
        }
    }
    Ok(())
}

fn next_project_name(app: &AppHandle, title: &str) -> Result<String, String> {
    let projects = projects_dir(app)?;
    if !projects.join(title).exists() {
        return Ok(title.to_string());
    }
    for suffix in 2..=10_000 {
        let candidate = format!("{title} ({suffix})");
        if !projects.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err("无法生成可用的项目名称".into())
}

fn next_model_id(models_root: &Path, id: &str) -> String {
    for suffix in 2..=10_000 {
        let candidate = format!("{id}-{suffix}");
        if !models_root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{id}-{}", super::unique_write_suffix())
}

fn directory_digest(directory: &Path) -> Result<String, String> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(directory, directory, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let path = directory.join(&relative);
        hasher.update(path_to_archive_name(&relative)?.as_bytes());
        hasher.update([0]);
        let mut file = File::open(&path).map_err(|error| error.to_string())?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err(format!("模型不能包含符号链接: {}", entry.path().display()));
        }
        if file_type.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            files.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

fn path_to_archive_name(path: &Path) -> Result<String, String> {
    let parts: Result<Vec<&str>, String> = path
        .components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .ok_or_else(|| "归档路径必须是 UTF-8".to_string()),
            _ => Err("归档路径无效".to_string()),
        })
        .collect();
    Ok(parts?.join("/"))
}

fn temporary_sibling(path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or_else(|| "路径缺少父目录".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无效".to_string())?;
    Ok(parent.join(format!(
        ".{file_name}.{label}.{}.tmp",
        super::unique_write_suffix()
    )))
}

fn replace_export_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    // Prefer rename, but Android/app-cache -> shared storage often crosses mount points
    // (EXDEV). Fall back to copy+remove in that case.
    if !destination.exists() {
        return move_or_copy_file(temporary, destination)
            .map_err(|error| format!("完成导出失败: {error}"));
    }
    let backup = temporary_sibling(destination, "backup")?;
    move_or_copy_file(destination, &backup)
        .map_err(|error| format!("备份已有导出文件失败: {error}"))?;
    if let Err(error) = move_or_copy_file(temporary, destination) {
        let restore_error = move_or_copy_file(&backup, destination).err();
        return match restore_error {
            Some(restore_error) => Err(format!(
                "完成导出失败: {error}; 恢复原文件也失败: {restore_error}"
            )),
            None => Err(format!("完成导出失败: {error}")),
        };
    }
    if let Err(error) = fs::remove_file(&backup) {
        log::warn!(
            target: "backend::project",
            "project.export cleanup_backup_failed path={} error={error}",
            backup.display()
        );
    }
    Ok(())
}

fn move_or_copy_file(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == std::io::ErrorKind::CrossesDevices
                || error.raw_os_error() == Some(18) =>
        {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
            }
            fs::copy(from, to).map_err(|e| format!("复制导出文件失败: {e}"))?;
            let _ = fs::remove_file(from);
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(all(debug_assertions, target_os = "android"))]
pub fn run_android_debug_sest_smoke(app: &AppHandle) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;

    let files_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data dir: {error}"))?
        .join("files");
    // On Android, app_data_dir is usually the package root; files/ may also be a sibling.
    let marker_candidates = [
        files_dir.join("debug-run-sest-import"),
        app.path()
            .app_data_dir()
            .map_err(|error| format!("resolve app data dir: {error}"))?
            .join("debug-run-sest-import"),
        PathBuf::from(
            "/data/data/org.untitled_story.storyteller.android/files/debug-run-sest-import",
        ),
        PathBuf::from(
            "/data/user/0/org.untitled_story.storyteller.android/files/debug-run-sest-import",
        ),
    ];
    let marker = marker_candidates.into_iter().find(|path| path.exists());
    let Some(marker) = marker else {
        return Ok(());
    };
    let _ = fs::remove_file(&marker);

    let source_path = {
        let source_file_candidates = [
            marker.with_file_name("debug-sest-source.txt"),
            PathBuf::from(
                "/data/data/org.untitled_story.storyteller.android/files/debug-sest-source.txt",
            ),
            PathBuf::from(
                "/data/user/0/org.untitled_story.storyteller.android/files/debug-sest-source.txt",
            ),
        ];
        source_file_candidates
            .into_iter()
            .find_map(|path| fs::read_to_string(path).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/sdcard/Download/Test.sest".to_string())
    };

    // data_dir() already falls back to app_data_dir when workspaceDir is unset.

    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke inspect begin source={source_path}"
    );
    let inspection = inspect_project_archive(app.clone(), source_path.clone())?;
    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke inspect ok title={} models={} exists={}",
        inspection.title,
        inspection.model_count,
        inspection.project_exists
    );

    let imported = import_project_archive(
        app.clone(),
        source_path.clone(),
        if inspection.project_exists {
            ProjectImportConflict::Rename
        } else {
            ProjectImportConflict::Rename
        },
    )?;
    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke import ok project={}",
        imported.project_name
    );

    let export_path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("export cache: {error}"))?
        .join(format!("mss-export-{}.sest", super::unique_write_suffix()));
    export_project_archive(
        app.clone(),
        imported.project_name.clone(),
        export_path.to_string_lossy().to_string(),
    )?;
    // Best-effort publish to shared Download for manual inspection.
    let shared = PathBuf::from("/sdcard/Download").join(
        export_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "mss-export.sest".into()),
    );
    if let Err(error) = fs::copy(&export_path, &shared) {
        log::warn!(
            target: "backend::project",
            "android_debug_sest_smoke shared copy failed path={} error={}",
            shared.display(),
            error
        );
    }
    let export_size = fs::metadata(&export_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if export_size == 0 {
        return Err(format!(
            "export produced empty file: {}",
            export_path.display()
        ));
    }
    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke export ok path={} bytes={}",
        export_path.display(),
        export_size
    );

    // re-import exported archive to prove round-trip
    let reimport = import_project_archive(
        app.clone(),
        export_path.to_string_lossy().to_string(),
        ProjectImportConflict::Rename,
    )?;
    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke reimport ok project={}",
        reimport.project_name
    );

    let result_path = marker.with_file_name("debug-sest-result.txt");
    fs::write(
        &result_path,
        format!(
            "ok\nimport={}\nexport={}\nexport_bytes={}\nreimport={}\n",
            imported.project_name,
            export_path.display(),
            export_size,
            reimport.project_name
        ),
    )
    .map_err(|error| format!("write result: {error}"))?;
    log::info!(
        target: "backend::project",
        "android_debug_sest_smoke completed result={}",
        result_path.display()
    );
    Ok(())
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_import_sest_from_path(
    app: AppHandle,
    source_path: String,
    conflict: Option<ProjectImportConflict>,
) -> Result<ImportedProjectResult, String> {
    let conflict = conflict.unwrap_or(ProjectImportConflict::Rename);
    log::info!(
        target: "backend::project",
        "debug_import_sest_from_path source={} conflict={:?}",
        source_path,
        conflict
    );
    import_project_archive(app, source_path, conflict)
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_export_sest_to_path(
    app: AppHandle,
    project_name: String,
    destination_path: String,
) -> Result<(), String> {
    log::info!(
        target: "backend::project",
        "debug_export_sest_to_path project={} destination={}",
        project_name,
        destination_path
    );
    export_project_archive(app, project_name, destination_path)
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_inspect_sest_from_path(
    app: AppHandle,
    source_path: String,
) -> Result<ProjectArchiveInspection, String> {
    log::info!(
        target: "backend::project",
        "debug_inspect_sest_from_path source={}",
        source_path
    );
    inspect_project_archive(app, source_path)
}

#[cfg(test)]
mod tests {
    use super::{
        directory_digest, extract_archive, open_archive, read_manifest, validate_archive_entries,
        validate_archive_path, validate_manifest, write_archive, ArchiveModel, ArchiveProject,
        ProjectArchiveManifest, ARCHIVE_FORMAT, ARCHIVE_VERSION,
    };
    use std::fs;

    #[test]
    fn archive_format_is_stable() {
        assert_eq!(ARCHIVE_FORMAT, "my-sekai-storyteller-project");
        assert_eq!(ARCHIVE_VERSION, 1);
    }

    #[test]
    fn rejects_paths_outside_archive_root() {
        assert!(validate_archive_path("project/story.json").is_ok());
        assert!(validate_archive_path("../story.json").is_err());
        assert!(validate_archive_path("/story.json").is_err());
        assert!(validate_archive_path("C:\\story.json").is_err());
    }

    #[test]
    fn writes_and_extracts_self_contained_archive() {
        let root = std::env::temp_dir().join(format!(
            "mss-project-archive-test-{}",
            super::super::unique_write_suffix()
        ));
        let project = root.join("source/project");
        let models = root.join("source/models");
        let model = models.join("test-model");
        fs::create_dir_all(project.join("assets/backgrounds")).unwrap();
        fs::create_dir_all(&model).unwrap();
        fs::write(
            project.join("metadata.json"),
            r#"{"title":"Archive Test","lastModified":1}"#,
        )
        .unwrap();
        fs::write(project.join("story.json"), r#"{"version":1,"snippets":[]}"#).unwrap();
        fs::write(
            project.join("assets.json"),
            r#"{"models":{"model":{"modelId":"test-model"}},"backgrounds":{"bg":{"name":"Background","path":"assets/backgrounds/bg.png"}},"voices":{}}"#,
        )
        .unwrap();
        fs::write(project.join("assets/backgrounds/bg.png"), b"background").unwrap();
        fs::write(model.join("test.model3.json"), b"{\"Version\":3}").unwrap();

        let manifest = ProjectArchiveManifest {
            format: ARCHIVE_FORMAT.into(),
            format_version: ARCHIVE_VERSION,
            app_version: "test".into(),
            exported_at: 1,
            project: ArchiveProject {
                title: "Archive Test".into(),
            },
            models: vec![ArchiveModel {
                id: "test-model".into(),
                path: "models/test-model".into(),
                sha256: directory_digest(&model).unwrap(),
            }],
        };
        let archive_path = root.join("test.sest");
        write_archive(&archive_path, &manifest, &project, &models).unwrap();

        let mut archive = open_archive(&archive_path).unwrap();
        validate_archive_entries(&mut archive).unwrap();
        let decoded = read_manifest(&mut archive).unwrap();
        validate_manifest(&decoded).unwrap();
        let extracted = root.join("extracted");
        extract_archive(&mut archive, &extracted).unwrap();
        assert_eq!(
            fs::read(extracted.join("project/assets/backgrounds/bg.png")).unwrap(),
            b"background"
        );
        assert_eq!(
            directory_digest(&extracted.join("models/test-model")).unwrap(),
            manifest.models[0].sha256
        );

        fs::remove_dir_all(root).unwrap();
    }
}
