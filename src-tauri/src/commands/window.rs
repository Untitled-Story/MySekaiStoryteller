use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

#[tauri::command]
// Keep dynamic window commands async. A synchronous command can deadlock while
// WebView2 waits for COM callbacks on Windows during WebviewWindowBuilder::build.
pub async fn open_editor(app: AppHandle, project_name: String) -> Result<(), String> {
    let label = "editor";
    log::info!(
        target: "backend::window",
        "open_editor requested project={project_name}"
    );

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

#[tauri::command]
// See open_editor: player window creation has the same WebView2 constraint.
pub async fn open_player(app: AppHandle, project_name: String) -> Result<(), String> {
    let label = "player";
    log::info!(
        target: "backend::window",
        "open_player requested project={project_name}"
    );

    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|error| {
            log::error!(target: "backend::window", "open_player focus failed: {error}");
            error.to_string()
        })?;
        window
            .emit("project-changed", &project_name)
            .map_err(|error| {
                log::error!(target: "backend::window", "open_player emit failed: {error}");
                error.to_string()
            })?;
        log::info!(target: "backend::window", "open_player reused existing window");
        return Ok(());
    }

    let url =
        WebviewUrl::App(project_window_url("src/windows/player/index.html", &project_name).into());

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Player")
        .inner_size(1280.0, 720.0)
        .resizable(false)
        .decorations(false)
        .build()
        .map_err(|error: tauri::Error| {
            log::error!(target: "backend::window", "open_player build failed: {error}");
            error.to_string()
        })?;

    log::info!(target: "backend::window", "open_player created window");
    Ok(())
}

fn project_window_url(path: &str, project_name: &str) -> String {
    format!(
        "{path}?project={}",
        utf8_percent_encode(project_name, NON_ALPHANUMERIC)
    )
}
