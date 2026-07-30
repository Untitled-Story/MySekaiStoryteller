#[cfg(desktop)]
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::Value;
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl};

#[tauri::command]
pub async fn open_editor(app: AppHandle, project_name: String) -> Result<(), String> {
    log::info!(
        target: "backend::window",
        "open_editor requested project={project_name}"
    );

    #[cfg(mobile)]
    {
        let _ = app;
        log::info!(
            target: "backend::window",
            "open_editor ignored on mobile; frontend should navigate in-app"
        );
        return Ok(());
    }

    #[cfg(desktop)]
    {
        open_editor_desktop(app, project_name).await
    }
}

#[tauri::command]
pub async fn open_player(
    app: AppHandle,
    project_name: String,
    render: Option<bool>,
    render_config: Option<Value>,
) -> Result<(), String> {
    let is_render = render.unwrap_or(false);
    log::info!(
        target: "backend::window",
        "open_player requested project={project_name} render={is_render}"
    );

    #[cfg(mobile)]
    {
        let _ = (app, project_name, render, render_config);
        log::info!(
            target: "backend::window",
            "open_player ignored on mobile; frontend should navigate in-app"
        );
        return Ok(());
    }

    #[cfg(desktop)]
    {
        open_player_desktop(app, project_name, render, render_config).await
    }
}

#[tauri::command]
pub fn close_export_worker(app: AppHandle, worker_index: u32) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, worker_index);
        return Ok(());
    }

    #[cfg(desktop)]
    {
        close_export_worker_desktop(app, worker_index)
    }
}

#[cfg(desktop)]
async fn open_editor_desktop(app: AppHandle, project_name: String) -> Result<(), String> {
    let label = "editor";
    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|error| {
            log::error!(target: "backend::window", "open_editor focus failed: {error}");
            error.to_string()
        })?;
        window
            .emit("project-changed", &project_name)
            .map_err(|error| {
                log::error!(target: "backend::window", "open_editor emit failed: {error}");
                error.to_string()
            })?;
        log::info!(target: "backend::window", "open_editor reused existing window");
        return Ok(());
    }

    let url =
        WebviewUrl::App(project_window_url("src/windows/editor/index.html", &project_name).into());

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Editor")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|error: tauri::Error| {
            log::error!(target: "backend::window", "open_editor build failed: {error}");
            error.to_string()
        })?;

    log::info!(target: "backend::window", "open_editor created window");
    Ok(())
}

#[cfg(desktop)]
async fn open_player_desktop(
    app: AppHandle,
    project_name: String,
    render: Option<bool>,
    render_config: Option<Value>,
) -> Result<(), String> {

    let is_render = render.unwrap_or(false);
    let worker_index = render_config
        .as_ref()
        .and_then(|c| c.get("workerIndex"))
        .and_then(|v| v.as_u64());
    let role = render_config
        .as_ref()
        .and_then(|c| c.get("role"))
        .and_then(|v| v.as_str())
        .unwrap_or(if is_render { "single" } else { "play" });

    log::info!(
        target: "backend::window",
        "open_player requested project={project_name} render={is_render} role={role} worker={worker_index:?}"
    );

    let label = if is_render {
        if role == "worker" {
            format!("export-worker-{}", worker_index.unwrap_or(0))
        } else if role == "coordinator" {
            "export-coordinator".to_string()
        } else if role == "debug" {
            "export-debug".to_string()
        } else {
            // single export progress uses the player label historically
            "player".to_string()
        }
    } else {
        "player".to_string()
    };

    // Debug dashboard: focus existing window instead of tearing it down.
    if role == "debug" {
        if let Some(window) = app.get_webview_window(&label) {
            window.set_focus().map_err(|error| {
                log::error!(target: "backend::window", "open_player debug focus failed: {error}");
                error.to_string()
            })?;
            log::info!(target: "backend::window", "open_player reused debug window label={label}");
            return Ok(());
        }
    }

    if let Some(window) = app.get_webview_window(&label) {
        log::info!(target: "backend::window", "open_player closing existing window label={label}");
        window.close().map_err(|error| {
            log::error!(target: "backend::window", "open_player close failed label={label}: {error}");
            error.to_string()
        })?;
        let start = std::time::Instant::now();
        while app.get_webview_window(&label).is_some() {
            if start.elapsed() > std::time::Duration::from_secs(2) {
                log::error!(target: "backend::window", "open_player close timeout label={label}");
                return Err("Failed to close existing player window".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    }

    let project_owned = project_name;
    let render_owned = is_render.to_string();
    let config_owned = render_config
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok());

    let mut query_pairs: Vec<(&str, &str)> = vec![
        ("project", project_owned.as_str()),
        ("render", render_owned.as_str()),
    ];
    if let Some(ref json) = config_owned {
        query_pairs.push(("renderConfig", json.as_str()));
    }

    let url = WebviewUrl::App(
        build_window_url("src/windows/player/index.html", &query_pairs).into(),
    );

    let is_worker = is_render && role == "worker";
    let is_export_debug = is_render && role == "debug";
    // Compact progress windows only (coordinator/single). Not workers, not debug.
    let is_export_progress = is_render && !is_worker && !is_export_debug;
    // Workers must use the export resolution so app.screen / layout / Live2D match capture.
    let (width, height) = if is_worker {
        render_config
            .as_ref()
            .map(|cfg| {
                let w = cfg
                    .get("width")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1280)
                    .clamp(160, 7680) as f64;
                let h = cfg
                    .get("height")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(720)
                    .clamp(90, 4320) as f64;
                (w, h)
            })
            .unwrap_or((1280.0, 720.0))
    } else if is_export_debug {
        (900.0, 640.0)
    } else if is_export_progress {
        // Title + bar + frames line + actions; OS chrome is outside inner_size.
        (480.0, 320.0)
    } else {
        (1280.0, 720.0)
    };

    let title = if is_worker {
        format!(
            "MySekaiStoryteller - Export Worker {}",
            worker_index.unwrap_or(0)
        )
    } else if is_export_debug {
        "渲染调试".to_string()
    } else if is_export_progress {
        "渲染视频".to_string()
    } else {
        "MySekaiStoryteller - Player".to_string()
    };

    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(title)
        .inner_size(width, height)
        .resizable(if is_export_progress || is_export_debug {
            true
        } else {
            !is_render
        })
        .decorations(is_export_progress || is_export_debug);

    if is_export_debug {
        builder = builder
            .min_inner_size(720.0, 480.0)
            .skip_taskbar(false)
            .visible(true)
            .focused(true)
            .always_on_top(false);
    } else if is_export_progress {
        builder = builder
            .min_inner_size(360.0, 200.0)
            .skip_taskbar(false)
            .visible(true)
            .focused(true)
            .always_on_top(false);
    } else if is_worker {
        // IMPORTANT: do NOT use visible(false) or minimize() by default.
        // Hidden/minimized webviews throttle/freeze WebGL + timers on Linux/WebKit →
        // multi-worker export sits at 0 frames until coordinator false-stalls.
        // Keep workers "visible" to the compositor, but place them off-screen and
        // skip the taskbar so users are not flooded with black undecorated windows.
        // Debug: MSS_SHOW_EXPORT_WORKERS=1 keeps them on-screen.
        builder = builder
            .skip_taskbar(true)
            .visible(true)
            .focused(false)
            .always_on_bottom(true);

        if !show_export_workers_on_screen() {
            let (lx, ly) = export_worker_offscreen_logical(&app, width, height, worker_index);
            builder = builder.position(lx, ly);
        }
    }

    let window = builder.build().map_err(|error: tauri::Error| {
        log::error!(target: "backend::window", "open_player build failed label={label}: {error}");
        error.to_string()
    })?;

    if is_worker && !show_export_workers_on_screen() {
        let (px, py) = export_worker_offscreen_physical(&app, width, height, worker_index);
        if let Err(error) = window.set_position(PhysicalPosition::new(px, py)) {
            log::warn!(
                target: "backend::window",
                "open_player worker off-screen set_position failed label={label}: {error}"
            );
        } else {
            log::info!(
                target: "backend::window",
                "open_player worker off-screen label={label} pos=({px},{py})"
            );
        }
    }

    log::info!(
        target: "backend::window",
        "open_player created window label={label} project={project_owned} render={is_render} role={role}"
    );
    Ok(())
}

#[cfg(desktop)]
fn show_export_workers_on_screen() -> bool {
    matches!(
        std::env::var("MSS_SHOW_EXPORT_WORKERS")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

/// Logical coords for WebviewWindowBuilder::position (scale-aware).
#[cfg(desktop)]
fn export_worker_offscreen_logical(
    app: &AppHandle,
    width: f64,
    height: f64,
    worker_index: Option<u64>,
) -> (f64, f64) {
    let (px, py) = export_worker_offscreen_physical(app, width, height, worker_index);
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
        .max(0.1);
    (px as f64 / scale, py as f64 / scale)
}

/// Physical desktop coords fully outside the primary monitor work area.
#[cfg(desktop)]
fn export_worker_offscreen_physical(
    app: &AppHandle,
    width: f64,
    height: f64,
    worker_index: Option<u64>,
) -> (i32, i32) {
    let slot = worker_index.unwrap_or(0) as i32;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor().max(0.1);
        let phys_w = (width * scale).ceil() as i32;
        let pos = monitor.position();
        // Fully left of the primary monitor; tiny y stagger avoids identical stacking.
        let x = pos.x - phys_w - 64;
        let y = pos.y + slot * 8;
        return (x, y);
    }
    let _ = height;
    (-((width.ceil() as i32) + 64), -64 + slot * 8)
}

#[cfg(desktop)]
fn close_export_worker_desktop(app: AppHandle, worker_index: u32) -> Result<(), String> {

    let label = format!("export-worker-{worker_index}");
    log::info!(
        target: "backend::window",
        "close_export_worker requested worker={worker_index} label={label}"
    );
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| {
            log::error!(target: "backend::window", "close_export_worker failed label={label}: {error}");
            error.to_string()
        })?;
        log::info!(target: "backend::window", "close_export_worker closed label={label}");
    } else {
        log::debug!(target: "backend::window", "close_export_worker missing label={label}");
    }
    Ok(())
}

#[cfg(desktop)]
fn project_window_url(path: &str, project_name: &str) -> String {
    build_window_url(path, &[("project", project_name)])
}

#[cfg(desktop)]
fn build_window_url(path: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return path.to_string();
    }

    let query: String = params
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                utf8_percent_encode(key, NON_ALPHANUMERIC),
                utf8_percent_encode(value, NON_ALPHANUMERIC)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    format!("{path}?{query}")
}
