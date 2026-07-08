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
            project::paths::get_default_workspace_dir,
            project::paths::get_workspace,
            project::paths::get_data_path,
            project::paths::get_data_fonts,
            project::model_registry::get_model_registry,
            project::metadata::get_projects,
            project::metadata::get_project_metadata,
            project::metadata::set_project_metadata,
            project::metadata::create_project,
            project::metadata::delete_project,
            project::metadata::rename_project,
            project::paths::get_project_path,
            project::assets::get_project_assets,
            project::assets::set_project_assets,
            project::story::get_project_story,
            project::story::set_project_story,
            window::open_editor,
            window::open_player,
        ]);

    builder = protocol::register_story_protocol(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
