use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

#[tauri::command]
pub fn open_editor(app: AppHandle, project_name: String) -> Result<(), String> {
    let label = "editor";

    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|e| e.to_string())?;
        window
            .emit("project-changed", &project_name)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url =
        WebviewUrl::App(project_window_url("src/windows/editor/index.html", &project_name).into());

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Editor")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn open_player(app: AppHandle, project_name: String) -> Result<(), String> {
    let label = "player";

    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|e| e.to_string())?;
        window
            .emit("project-changed", &project_name)
            .map_err(|e| e.to_string())?;
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
        .map_err(|e: tauri::Error| e.to_string())?;

    Ok(())
}

fn project_window_url(path: &str, project_name: &str) -> String {
    format!(
        "{path}?project={}",
        utf8_percent_encode(project_name, NON_ALPHANUMERIC)
    )
}
