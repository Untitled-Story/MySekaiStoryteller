mod commands;
mod protocol;

use commands::{file_open, project, settings, window};
use log::LevelFilter;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, WEBVIEW_TARGET};

const LOG_FILE_SIZE_BYTES: u128 = 5 * 1024 * 1024;
const LOG_FILE_COUNT: usize = 5;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_level: LevelFilter = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let mut log_targets: Vec<Target> = vec![
        Target::new(TargetKind::LogDir {
            file_name: Some("backend".into()),
        })
        .filter(|metadata| !metadata.target().starts_with(WEBVIEW_TARGET)),
        Target::new(TargetKind::LogDir {
            file_name: Some("frontend".into()),
        })
        .filter(|metadata| metadata.target().starts_with(WEBVIEW_TARGET)),
    ];
    if cfg!(debug_assertions) {
        log_targets.push(Target::new(TargetKind::Stdout));
    }

    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log_level)
        .max_file_size(LOG_FILE_SIZE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_FILE_COUNT))
        .targets(log_targets)
        .build();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_open::project_paths_from_args(&args, &PathBuf::from(cwd));
            file_open::queue_paths(app, paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(file_open::PendingProjectImports::default());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder = builder
        .setup(|app| {
            log::info!(
                target: "backend::lifecycle",
                "app.setup version={} debug={}",
                app.package_info().version,
                cfg!(debug_assertions)
            );

            let default_panic_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |panic_info| {
                log::error!(target: "backend::panic", "unhandled panic: {panic_info}");
                default_panic_hook(panic_info);
            }));
            let args: Vec<String> = std::env::args().collect();
            let current_dir = std::env::current_dir().unwrap_or_default();
            let paths = file_open::project_paths_from_args(&args, &current_dir);
            file_open::queue_paths(app.handle(), paths);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            log::info!(
                target: "backend::webview",
                "page_load window={} event={:?} path={}",
                webview.label(),
                payload.event(),
                payload.url().path()
            );
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            file_open::get_pending_project_imports,
            project::paths::get_default_workspace_dir,
            project::paths::get_workspace,
            project::paths::get_data_path,
            project::paths::get_log_path,
            project::paths::get_data_fonts,
            project::model_registry::get_model_registry,
            project::model_registry::inspect_model_archive,
            project::model_registry::import_global_model,
            project::metadata::get_projects,
            project::metadata::get_project_metadata,
            project::metadata::set_project_metadata,
            project::metadata::create_project,
            project::metadata::delete_project,
            project::metadata::rename_project,
            project::archive::inspect_project_archive,
            project::archive::export_project_archive,
            project::archive::import_project_archive,
            project::paths::get_project_path,
            project::assets::get_project_assets,
            project::assets::set_project_assets,
            project::assets::import_project_asset,
            project::assets::register_project_model,
            project::assets::get_project_asset_references,
            project::assets::rename_project_asset,
            project::assets::delete_project_asset,
            project::story::get_project_story,
            project::story::set_project_story,
            window::open_editor,
            window::open_player,
        ]);

    builder = protocol::register_story_protocol(builder);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect::<Vec<PathBuf>>();
            file_open::queue_paths(app, paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
