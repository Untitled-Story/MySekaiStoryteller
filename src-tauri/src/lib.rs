mod commands;
mod protocol;

use commands::{project, settings, window};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            project::get_default_workspace_dir,
            project::get_workspace,
            project::get_projects,
            project::get_project_metadata,
            project::set_project_metadata,
            project::create_project,
            project::delete_project,
            project::rename_project,
            project::get_project_path,
            window::resize_window,
            window::open_editor,
            window::open_player,
        ]);

    builder = protocol::register_story_protocol(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
