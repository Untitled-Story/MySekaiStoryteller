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

    let url = WebviewUrl::App(
        project_window_url(
            "src/windows/editor/index.html",
            [("project", project_name.as_str())].as_slice(),
        )
        .into(),
    );

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Editor")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn open_player(
    app: AppHandle,
    project_name: String,
    render: bool,
    render_config: Option<serde_json::Value>,
) -> Result<(), String> {
    let label = "player";

    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|e| e.to_string())?;
        window
            .emit("project-changed", &project_name)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let render_str = render.to_string();
    let mut params = vec![
        ("project", project_name.as_str()),
        ("render", render_str.as_str()),
    ];

    let config_json = if let Some(config) = render_config {
        serde_json::to_string(&config).ok()
    } else {
        None
    };

    if let Some(ref json) = config_json {
        params.push(("renderConfig", json.as_str()));
    }

    let url = WebviewUrl::App(
        project_window_url(
            "src/windows/player/index.html",
            params.as_slice(),
        )
        .into(),
    );

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("MySekaiStoryteller - Player")
        .inner_size(1280.0, 720.0)
        .resizable(false)
        .decorations(false)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    Ok(())
}

fn project_window_url(path: &str, params: &[(&str, &str)]) -> String {
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
