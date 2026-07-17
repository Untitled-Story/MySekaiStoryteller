#[cfg(desktop)]
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
#[cfg(desktop)]
use tauri::{Emitter, Manager, WebviewUrl};
use tauri::AppHandle;

#[tauri::command]
// Keep dynamic window commands async. A synchronous command can deadlock while
// WebView2 waits for COM callbacks on Windows during WebviewWindowBuilder::build.
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
        open_labeled_window(
            &app,
            "editor",
            "MySekaiStoryteller - Editor",
            "src/windows/editor/index.html",
            &project_name,
            WindowChrome::Editor,
        )
        .await
    }
}

#[tauri::command]
// See open_editor: player window creation has the same WebView2 constraint.
pub async fn open_player(app: AppHandle, project_name: String) -> Result<(), String> {
    log::info!(
        target: "backend::window",
        "open_player requested project={project_name}"
    );

    #[cfg(mobile)]
    {
        let _ = app;
        log::info!(
            target: "backend::window",
            "open_player ignored on mobile; frontend should navigate in-app"
        );
        return Ok(());
    }

    #[cfg(desktop)]
    {
        open_labeled_window(
            &app,
            "player",
            "MySekaiStoryteller - Player",
            "src/windows/player/index.html",
            &project_name,
            WindowChrome::Player,
        )
        .await
    }
}

#[cfg(desktop)]
enum WindowChrome {
    Editor,
    Player,
}

#[cfg(desktop)]
async fn open_labeled_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    html_path: &str,
    project_name: &str,
    chrome: WindowChrome,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|error| {
            log::error!(target: "backend::window", "{label} focus failed: {error}");
            error.to_string()
        })?;
        window
            .emit("project-changed", &project_name)
            .map_err(|error| {
                log::error!(target: "backend::window", "{label} emit failed: {error}");
                error.to_string()
            })?;
        log::info!(target: "backend::window", "{label} reused existing window");
        return Ok(());
    }

    let url = WebviewUrl::App(project_window_url(html_path, project_name).into());
    let builder = tauri::WebviewWindowBuilder::new(app, label, url).title(title);

    let builder = match chrome {
        WindowChrome::Editor => builder.inner_size(1280.0, 720.0),
        WindowChrome::Player => builder
            .inner_size(1280.0, 720.0)
            .resizable(false)
            .decorations(false),
    };

    builder.build().map_err(|error: tauri::Error| {
        log::error!(target: "backend::window", "{label} build failed: {error}");
        error.to_string()
    })?;

    log::info!(target: "backend::window", "{label} created window");
    Ok(())
}

#[cfg(desktop)]
fn project_window_url(path: &str, project_name: &str) -> String {
    format!(
        "{path}?project={}",
        utf8_percent_encode(project_name, NON_ALPHANUMERIC)
    )
}
