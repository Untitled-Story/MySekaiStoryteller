use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::Mutex;
use std::thread;
use crossbeam_channel::{bounded, Sender};
use tauri::{AppHandle, State};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderConfig {
    pub export_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub enum RenderMessage {
    Frame(Vec<u8>),
    Stop,
}

pub struct RenderSession {
    pub tx: Sender<RenderMessage>,
    pub worker_handle: Option<thread::JoinHandle<()>>,
}

pub struct RenderManager {
    pub sessions: Mutex<std::collections::HashMap<String, RenderSession>>,
}

impl RenderManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

#[tauri::command]
pub fn start_render_session(
    _app: AppHandle,
    state: State<'_, RenderManager>,
    project_name: String,
    config: RenderConfig,
) -> Result<(), String> {
    let session_id = project_name.clone();
    let (tx, rx) = bounded::<RenderMessage>(120); // Buffer 2 seconds of frames @ 60fps
    
    let config_clone = config.clone();
    let worker_handle = thread::spawn(move || {
        let mut child = Command::new("ffmpeg")
            .args([
                "-y",
                "-f", "rawvideo",
                "-pixel_format", "rgba",
                "-video_size", &format!("{}x{}", config_clone.width, config_clone.height),
                "-framerate", &config_clone.fps.to_string(),
                "-i", "pipe:0",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-preset", "ultrafast",
                &config_clone.export_path,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Failed to spawn ffmpeg");

        let mut stdin = child.stdin.take().expect("Failed to open stdin");

        while let Ok(msg) = rx.recv() {
            match msg {
                RenderMessage::Frame(data) => {
                    if let Err(e) = stdin.write_all(&data) {
                        eprintln!("FFmpeg stdin write error: {}", e);
                        break;
                    }
                }
                RenderMessage::Stop => {
                    break;
                }
            }
        }

        drop(stdin); // Closing stdin signals EOF to FFmpeg
        let _ = child.wait();
    });

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(session_id, RenderSession {
        tx,
        worker_handle: Some(worker_handle),
    });

    Ok(())
}

#[tauri::command]
pub fn stream_frame(
    state: State<'_, RenderManager>,
    project_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    println!("Received frame for project {}: {} bytes", project_name, data.len());
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&project_name) {
        session.tx.send(RenderMessage::Frame(data)).map_err(|e| e.to_string())?;
    } else {
        return Err("No active render session found for this project".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn stop_render_session(
    state: State<'_, RenderManager>,
    project_name: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&project_name) {
        let _ = session.tx.send(RenderMessage::Stop);
        if let Some(handle) = session.worker_handle.take() {
            let _ = handle.join();
        }
    }
    Ok(())
}
