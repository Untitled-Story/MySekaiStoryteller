use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::settings::{get_settings, PlaybackFontSettings};
use crate::renderer::config::{GpuBackendInfo, VideoExportConfig};
use crate::renderer::error::RendererError;
use crate::renderer::export::{export_story_to_mp4, ExportProgress, ExportResult, ExportStage};
use crate::renderer::gpu::enumerate_render_backends;
use crate::renderer::story::{PlaybackFontConfig, ProjectRenderInput, StoryData};

pub const VIDEO_EXPORT_PROGRESS_EVENT: &str = "video-export-progress";
pub const VIDEO_EXPORT_CANCELLED_CODE: &str = "VIDEO_EXPORT_CANCELLED";

static TEMP_EXPORT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Tauri state coordinating single-flight video export and cancellation requests.
#[derive(Default)]
pub struct VideoExportManager {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl VideoExportManager {
    fn try_begin(&self) -> Result<(Arc<AtomicBool>, ActiveExportGuard), String> {
        let mut slot = self
            .active
            .lock()
            .map_err(|_| "Video export state lock poisoned".to_string())?;
        if slot.is_some() {
            return Err("A video export is already in progress".to_string());
        }
        let cancel_flag = Arc::new(AtomicBool::new(false));
        *slot = Some(Arc::clone(&cancel_flag));
        Ok((
            cancel_flag,
            ActiveExportGuard {
                active: Arc::clone(&self.active),
            },
        ))
    }

    /// Signals cancellation for the currently running export, returning true if one was active.
    pub fn cancel(&self) -> Result<bool, String> {
        let slot = self
            .active
            .lock()
            .map_err(|_| "Video export state lock poisoned".to_string())?;
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::SeqCst);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

struct ActiveExportGuard {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl Drop for ActiveExportGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.active.lock() {
            *slot = None;
        }
    }
}

struct TempFileGuard {
    path: PathBuf,
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn map_playback_font(font: PlaybackFontSettings) -> PlaybackFontConfig {
    match font {
        PlaybackFontSettings::Default => PlaybackFontConfig::Default,
        PlaybackFontSettings::Data { family, path } => PlaybackFontConfig::Data { family, path },
        PlaybackFontSettings::System { family } => PlaybackFontConfig::System { family },
    }
}

fn resolve_playback_font(app: &AppHandle) -> PlaybackFontConfig {
    match get_settings(app.clone()) {
        Some(settings) => map_playback_font(settings.playback.font),
        None => PlaybackFontConfig::Default,
    }
}

fn should_emit_progress(
    progress: &ExportProgress,
    last_stage: &mut Option<ExportStage>,
    last_emitted_at: &mut Option<Instant>,
) -> bool {
    let stage_changed = *last_stage != Some(progress.stage);
    let is_terminal_frame = progress.estimated_total_frames > 0
        && progress.rendered_frames >= progress.estimated_total_frames;
    let elapsed_ready = last_emitted_at
        .map(|t| t.elapsed() >= Duration::from_millis(100))
        .unwrap_or(true);

    if stage_changed || is_terminal_frame || elapsed_ready {
        *last_stage = Some(progress.stage);
        *last_emitted_at = Some(Instant::now());
        true
    } else {
        false
    }
}

/// Renders a project purely in Rust and writes a fast-start H.264/AAC MP4 to `destination_path`.
#[tauri::command]
pub async fn export_project_video(
    app: AppHandle,
    state: State<'_, VideoExportManager>,
    project_name: String,
    destination_path: String,
    config: VideoExportConfig,
    story_override: Option<StoryData>,
) -> Result<ExportResult, String> {
    if destination_path.trim().is_empty() {
        return Err("Export destination path cannot be empty".to_string());
    }
    config.validate().map_err(|err| err.to_string())?;

    let data_dir = crate::commands::project::data_dir(&app)?;
    let project_dir = crate::commands::project::project_path(&app, &project_name)?;
    let font_config = resolve_playback_font(&app);
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|err| format!("Failed to resolve temp directory: {err}"))?;

    let (cancel_flag, active_guard) = state.try_begin()?;

    log::info!(
        target: "backend::export",
        "video_export.start project={} size={}x{} fps={} quality={:?}",
        project_name,
        config.width,
        config.height,
        config.fps,
        config.quality
    );

    let app_for_task = app.clone();
    let project_for_log = project_name.clone();
    let dest_for_task = destination_path.clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _active_guard = active_guard;
        fs::create_dir_all(&temp_dir)
            .map_err(|err| format!("Failed to create export temp directory: {err}"))?;
        let seq = TEMP_EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
        let temp_path = temp_dir.join(format!("mss-export-{}-{seq}.mp4", std::process::id()));
        let _temp_guard = TempFileGuard {
            path: temp_path.clone(),
        };

        let input =
            ProjectRenderInput::load_from_dirs(data_dir, project_dir, story_override, font_config)
                .map_err(|err| err.to_string())?;

        let mut last_stage: Option<ExportStage> = None;
        let mut last_emitted_at: Option<Instant> = None;

        let mut result = export_story_to_mp4(
            &input,
            &config,
            &temp_path,
            Some(cancel_flag.as_ref()),
            |progress| {
                if should_emit_progress(&progress, &mut last_stage, &mut last_emitted_at) {
                    let _ = app_for_task.emit(VIDEO_EXPORT_PROGRESS_EVENT, &progress);
                }
            },
        )
        .map_err(|err| match err {
            RendererError::Cancelled => {
                log::info!(
                    target: "backend::export",
                    "video_export.cancelled project={}",
                    project_for_log
                );
                VIDEO_EXPORT_CANCELLED_CODE.to_string()
            }
            other => {
                log::error!(
                    target: "backend::export",
                    "video_export.failed project={} error={}",
                    project_for_log,
                    other
                );
                other.to_string()
            }
        })?;

        crate::commands::project::write_picked_destination(
            &app_for_task,
            &dest_for_task,
            &temp_path,
        )?;
        result.output_path = PathBuf::from(&dest_for_task);

        log::info!(
            target: "backend::export",
            "video_export.completed project={} frames={} bytes={}",
            project_for_log,
            result.video_frames,
            result.bytes_written
        );
        Ok(result)
    });

    handle
        .await
        .map_err(|err| format!("Video export worker panicked or aborted: {err}"))?
}

/// Requests cooperative cancellation of an active background video export.
#[tauri::command]
pub fn cancel_video_export(state: State<'_, VideoExportManager>) -> Result<bool, String> {
    let cancelled = state.cancel()?;
    if cancelled {
        log::info!(target: "backend::export", "video_export.cancel_requested");
    }
    Ok(cancelled)
}

/// Enumerates available GPU (Metal/MPS, Vulkan, CUDA, DX12, GL) and CPU render backends.
#[tauri::command]
pub async fn get_available_render_backends() -> Result<Vec<GpuBackendInfo>, String> {
    tauri::async_runtime::spawn_blocking(enumerate_render_backends)
        .await
        .map_err(|err| format!("Failed to enumerate render backends: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_export_manager_enforces_single_active_export_and_releases_on_drop() {
        let manager = VideoExportManager::default();
        assert!(!manager.cancel().expect("cancel when idle"));

        let (flag, guard) = manager.try_begin().expect("first export acquires slot");
        assert!(!flag.load(Ordering::SeqCst));
        assert!(manager.try_begin().is_err(), "second export must conflict");

        assert!(manager.cancel().expect("cancel when active"));
        assert!(flag.load(Ordering::SeqCst));

        drop(guard);
        assert!(!manager.cancel().expect("idle again after guard drop"));
        let (_flag2, _guard2) = manager.try_begin().expect("can acquire again after drop");
    }

    #[test]
    fn maps_all_playback_font_variants() {
        assert!(matches!(
            map_playback_font(PlaybackFontSettings::Default),
            PlaybackFontConfig::Default
        ));
        assert!(matches!(
            map_playback_font(PlaybackFontSettings::Data {
                family: "Custom".into(),
                path: "fonts/custom.ttf".into()
            }),
            PlaybackFontConfig::Data { family, path } if family == "Custom" && path == "fonts/custom.ttf"
        ));
        assert!(matches!(
            map_playback_font(PlaybackFontSettings::System {
                family: "Hiragino Sans".into()
            }),
            PlaybackFontConfig::System { family } if family == "Hiragino Sans"
        ));
    }
}
