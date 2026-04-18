use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, Window};

#[tauri::command]
pub fn resize_window<R: Runtime>(
    window: Window<R>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let outer_position = window.outer_position().map_err(|e| e.to_string())?;
    let outer_size = window.outer_size().map_err(|e| e.to_string())?;

    let center_x = outer_position.x as f64 + outer_size.width as f64 / 2.0;
    let center_y = outer_position.y as f64 + outer_size.height as f64 / 2.0;

    let new_x = (center_x - width as f64 / 2.0).round() as i32;
    let new_y = (center_y - height as f64 / 2.0).round() as i32;

    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(new_x, new_y))
        .map_err(|e| e.to_string())?;

    Ok(())
}

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

    let url = WebviewUrl::App(format!("src/windows/editor/index.html?project={}", project_name).into());

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

    let url = WebviewUrl::App(format!("src/windows/player/index.html?project={}", project_name).into());

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Player")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    Ok(())
}
