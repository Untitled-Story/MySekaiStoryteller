use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const IMPORT_EVENT: &str = "project-import-requested";

#[derive(Default)]
pub struct PendingProjectImports(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn get_pending_project_imports(app: AppHandle) -> Vec<String> {
    let state = app.state::<PendingProjectImports>();
    let mut pending = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *pending)
}

pub fn queue_paths(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    for path in paths {
        if !is_project_archive(&path) {
            continue;
        }
        let path_text = path.to_string_lossy().into_owned();
        let state = app.state::<PendingProjectImports>();
        let mut pending = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.contains(&path_text) {
            continue;
        }
        pending.push(path_text.clone());
        drop(pending);
        if let Err(error) = app.emit(IMPORT_EVENT, &path_text) {
            log::warn!(target: "backend::lifecycle", "project_import.emit_failed error={error}");
        }
    }
}

pub fn project_paths_from_args(args: &[String], current_dir: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                current_dir.join(path)
            }
        })
        .filter(|path| is_project_archive(path))
        .collect()
}

fn is_project_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sest"))
}

#[cfg(test)]
mod tests {
    use super::project_paths_from_args;
    use std::path::Path;

    #[test]
    fn extracts_project_archives_from_process_arguments() {
        let args = vec![
            "storyteller".to_string(),
            "example.sest".to_string(),
            "ignored.txt".to_string(),
        ];
        assert_eq!(
            project_paths_from_args(&args, Path::new("/workspace")),
            vec![Path::new("/workspace/example.sest")]
        );
    }
}
