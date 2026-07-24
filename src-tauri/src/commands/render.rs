use crossbeam_channel::{bounded, Sender};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg_attr(mobile, allow(unused_imports))]
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderConfig {
    pub export_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRenderResult {
    pub upload_url: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareParallelExportArgs {
    pub project_name: String,
    pub export_path: String,
    pub concurrency: u32,
    pub total_frames: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub data_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPlan {
    pub worker_index: u32,
    pub start_frame: u32,
    pub end_frame: u32,
    pub segment_path: String,
    pub session_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareParallelExportResult {
    pub session_id: String,
    pub temp_dir: String,
    pub workers: Vec<WorkerPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcatSegmentsArgs {
    pub segment_paths: Vec<String>,
    pub export_path: String,
    /// Expected output duration in seconds (for progress = out_time / total).
    #[serde(default)]
    pub total_duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegProgressPayload {
    /// 0–1 based on out_time / total_duration_sec
    ratio: f64,
    out_time_sec: f64,
    total_duration_sec: f64,
}

pub enum RenderMessage {
    /// One or more tightly packed RGBA frames (len % frame_bytes == 0).
    FrameBatch(Vec<u8>),
    Stop,
}

pub struct RenderSession {
    pub tx: Sender<RenderMessage>,
    pub worker_handle: Option<thread::JoinHandle<()>>,
    pub server_handle: Option<thread::JoinHandle<()>>,
    pub stop_flag: Arc<AtomicBool>,
    pub stop_addr: SocketAddr,
    /// Packed RGBA bytes per frame (width*height*4); reserved for bridge validation.
    #[allow(dead_code)]
    pub frame_bytes: usize,
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
pub fn prepare_parallel_export(
    args: PrepareParallelExportArgs,
) -> Result<PrepareParallelExportResult, String> {
    log::info!(target: "backend::render", "prepare_parallel_export requested project={} concurrency={} frames={}", args.project_name, args.concurrency, args.total_frames);

    let concurrency = args.concurrency.max(1);
    let total_frames = args.total_frames;
    let session_id = format!(
        "exp_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let temp_dir = PathBuf::from(&args.data_path)
        .join("outputs")
        .join(".tmp")
        .join(&session_id);
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    // Ensure final export parent exists.
    if let Some(parent) = Path::new(&args.export_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory: {e}"))?;
        }
    }

    let workers = plan_chunks(total_frames, concurrency)
        .into_iter()
        .map(|(worker_index, start_frame, end_frame)| {
            let segment_path = temp_dir
                .join(format!("seg_{worker_index:03}.mp4"))
                .to_string_lossy()
                .to_string();
            let session_key = format!("{session_id}_w{worker_index}");
            WorkerPlan {
                worker_index,
                start_frame,
                end_frame,
                segment_path,
                session_key,
            }
        })
        .collect::<Vec<_>>();

    Ok(PrepareParallelExportResult {
        session_id,
        temp_dir: temp_dir.to_string_lossy().to_string(),
        workers,
    })
}

#[tauri::command]
pub async fn concat_render_segments(
    app: AppHandle,
    args: ConcatSegmentsArgs,
) -> Result<(), String> {
    log::info!(target: "backend::render", "concat_render_segments requested segments={} path={}", args.segment_paths.len(), args.export_path);

    // Pure remux can still be heavy for large multi-segment exports — keep off UI thread.
    tauri::async_runtime::spawn_blocking(move || concat_render_segments_blocking(app, args))
        .await
        .map_err(|e| format!("concat task join failed: {e}"))?
}

fn concat_render_segments_blocking(app: AppHandle, args: ConcatSegmentsArgs) -> Result<(), String> {
    if args.segment_paths.is_empty() {
        return Err("No segments to concat".to_string());
    }
    if args.export_path.trim().is_empty() {
        return Err("Export path is empty".to_string());
    }

    let mut probed_total = 0.0_f64;
    for path in &args.segment_paths {
        if !Path::new(path).is_file() {
            return Err(format!("Segment missing: {path}"));
        }
        let dur = validate_render_segment(path.clone(), 0.01)?;
        probed_total += dur;
    }

    let total_duration_sec = args
        .total_duration_sec
        .filter(|d| d.is_finite() && *d > 0.05)
        .unwrap_or(probed_total)
        .max(0.05);

    let app_progress = app.clone();
    let total = total_duration_sec;
    let mut progress_cb = move |ratio: f64| {
        let ratio = ratio.clamp(0.0, 1.0);
        let payload = FfmpegProgressPayload {
            ratio,
            out_time_sec: total * ratio,
            total_duration_sec: total,
        };
        let _ = app_progress.emit("export-ffmpeg-progress", &payload);
    };

    crate::commands::encoder::concat_mp4_segments(
        &args.segment_paths,
        &args.export_path,
        Some(&mut progress_cb),
    )?;

    let _ = app.emit(
        "export-ffmpeg-progress",
        &FfmpegProgressPayload {
            ratio: 1.0,
            out_time_sec: total_duration_sec,
            total_duration_sec,
        },
    );
    Ok(())
}

/// Desktop single-path final delivery: re-encode a capture MP4 with quality preset (prefer libx265).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeRenderDeliveryArgs {
    pub source_path: String,
    pub export_path: String,
    pub total_duration_sec: Option<f64>,
}

#[tauri::command]
pub async fn finalize_render_delivery(
    app: AppHandle,
    args: FinalizeRenderDeliveryArgs,
) -> Result<(), String> {
    log::info!(
        target: "backend::render",
        "finalize_render_delivery source={} dest={}",
        args.source_path,
        args.export_path
    );
    tauri::async_runtime::spawn_blocking(move || finalize_render_delivery_blocking(app, args))
        .await
        .map_err(|e| format!("finalize delivery join failed: {e}"))?
}

fn finalize_render_delivery_blocking(
    app: AppHandle,
    args: FinalizeRenderDeliveryArgs,
) -> Result<(), String> {
    // Delivery encode already applied at capture time (openh264/MediaCodec).
    // Finalize is validate + optional copy/rename — no second lossy pass.
    let source = args.source_path.trim().to_string();
    let export_path = args.export_path.trim().to_string();
    if source.is_empty() || export_path.is_empty() {
        return Err("finalize paths empty".into());
    }
    if !Path::new(&source).is_file() {
        return Err(format!("source missing: {source}"));
    }
    let probed = validate_render_segment(source.clone(), 0.01)?;
    let total_duration_sec = args
        .total_duration_sec
        .filter(|d| d.is_finite() && *d > 0.05)
        .unwrap_or(probed)
        .max(0.05);

    if let Some(parent) = Path::new(&export_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory: {e}"))?;
        }
    }

    let same_path = Path::new(&source)
        .canonicalize()
        .ok()
        .and_then(|s| Path::new(&export_path).canonicalize().ok().map(|d| (s, d)))
        .map(|(s, d)| s == d)
        .unwrap_or(source == export_path);

    if !same_path {
        std::fs::copy(&source, &export_path)
            .map_err(|e| format!("copy delivery output failed: {e}"))?;
    }

    log::info!(
        target: "backend::render",
        "finalize delivery (no re-encode) source={source} dest={export_path} duration≈{total_duration_sec:.2}s"
    );

    let _ = app.emit(
        "export-ffmpeg-progress",
        &FfmpegProgressPayload {
            ratio: 1.0,
            out_time_sec: total_duration_sec,
            total_duration_sec,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn cleanup_export_temp(temp_dir: String) -> Result<(), String> {
    log::info!(target: "backend::render", "cleanup_export_temp dir={temp_dir}");

    let path = Path::new(&temp_dir);
    if path.exists() {
        std::fs::remove_dir_all(path).map_err(|e| format!("Failed to remove temp dir: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn start_render_session(
    state: State<'_, RenderManager>,
    project_name: String,
    config: RenderConfig,
) -> Result<StartRenderResult, String> {
    log::info!(target: "backend::render", "start_render_session requested project={} path={} {}x{}@{}", project_name, config.export_path, config.width, config.height, config.fps);
    let config = crate::commands::encoder::clamp_export_config(&config);
    log::info!(
        target: "backend::render",
        "clamped render config {}x{}@{}",
        config.width,
        config.height,
        config.fps
    );

    if config.width == 0 || config.height == 0 {
        return Err("Invalid render size".to_string());
    }
    if config.fps == 0 {
        return Err("Invalid fps".to_string());
    }
    if config.export_path.trim().is_empty() {
        return Err("Export path is empty".to_string());
    }
    let lowered = config.export_path.to_ascii_lowercase();
    if lowered.starts_with("content://") || lowered.starts_with("file://") {
        return Err(
            "Android content:// paths cannot be opened as ordinary files for encoding. Use the app private outputs directory, then share/export the finished MP4."
                .into(),
        );
    }

    let export_path = Path::new(&config.export_path);
    if let Some(parent) = export_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {e}"))?;
        }
    }

    let session_id = config
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(project_name);

    // Bounded queue for backpressure. Keep modest: each frame is width*height*4 bytes.
    // HTTP path uses send_timeout so a full queue returns 503 instead of hanging forever.
    // Mobile soft-encode is slow; keep the queue tiny to bound RAM (~frame_bytes * N).
    // Soft encoder is slow; keep a few frames buffered without multi-100MB RAM.
    // Mobile: JPEG payloads are small — deeper queue absorbs capture bursts.
    #[cfg(mobile)]
    let (tx, rx) = bounded::<RenderMessage>(16);
    #[cfg(desktop)]
    let (tx, rx) = bounded::<RenderMessage>(48);
    let stop_flag = Arc::new(AtomicBool::new(false));

    let config_clone = config.clone();
    let stop_flag_worker = Arc::clone(&stop_flag);

    #[cfg(mobile)]
    let worker_handle = {
        let cfg = config_clone.clone();
        let stop = Arc::clone(&stop_flag_worker);
        thread::spawn(move || {
            crate::commands::mobile_encoder::run_mobile_encode_worker(rx, cfg, stop);
        })
    };

    // Desktop: embedded encode (HW probe → openh264); no system ffmpeg.
    #[cfg(desktop)]
    let worker_handle = {
        let cfg = crate::commands::encoder::clamp_export_config(&config_clone);
        let stop = Arc::clone(&stop_flag_worker);
        thread::spawn(move || {
            crate::commands::encoder::run_encode_worker(rx, cfg, stop);
        })
    };

    // All platforms use a localhost binary HTTP frame server. On Android this avoids
    // the Tauri JavaBridge/AppCache path, which consumed ~100% JavaBridge CPU and
    // 300-600ms per 720p frame.
    let (upload_url, stop_addr, server_handle) = {
        let server =
            Server::http("127.0.0.1:0").map_err(|e| format!("Failed to bind frame server: {e}"))?;
        let stop_addr = match server.server_addr() {
            tiny_http::ListenAddr::IP(socket) => socket,
            _ => return Err("Frame server bound to unsupported address".to_string()),
        };
        let upload_url = format!("http://{stop_addr}/frame");
        let server_stop = Arc::clone(&stop_flag);
        let http_tx = tx.clone();
        let expected_bytes = (config.width as usize) * (config.height as usize) * 4;
        let server_handle = thread::spawn(move || {
            for mut request in server.incoming_requests() {
                if server_stop.load(Ordering::Relaxed) {
                    let _ = request.respond(with_cors(Response::empty(StatusCode(503))));
                    break;
                }

                let method = request.method().clone();
                let url = request.url().to_string();

                if method == Method::Options {
                    let _ = request.respond(with_cors(Response::empty(StatusCode(204))));
                    continue;
                }

                if method == Method::Post && (url == "/frame" || url.starts_with("/frame?")) {
                    let mut body = Vec::new();
                    if let Err(e) = request.as_reader().read_to_end(&mut body) {
                        let _ = request.respond(with_cors(
                            Response::from_string(format!("read error: {e}"))
                                .with_status_code(StatusCode(400)),
                        ));
                        continue;
                    }

                    if body.is_empty() || body.len() % expected_bytes != 0 {
                        let _ = request.respond(with_cors(
                            Response::from_string(format!(
                                "bad body size: {} (frame size {})",
                                body.len(),
                                expected_bytes
                            ))
                            .with_status_code(StatusCode(400)),
                        ));
                        continue;
                    }

                    // Move whole batch once — avoid per-frame to_vec copies.
                    let mut send_failed = false;
                    let mut overloaded = false;
                    match http_tx
                        .send_timeout(RenderMessage::FrameBatch(body), Duration::from_secs(5))
                    {
                        Ok(()) => {}
                        Err(crossbeam_channel::SendTimeoutError::Timeout(_)) => {
                            overloaded = true;
                        }
                        Err(crossbeam_channel::SendTimeoutError::Disconnected(_)) => {
                            send_failed = true;
                        }
                    }

                    if send_failed {
                        let _ = request.respond(with_cors(Response::empty(StatusCode(503))));
                        break;
                    }
                    if overloaded {
                        let _ = request.respond(with_cors(
                            Response::from_string("frame queue full")
                                .with_status_code(StatusCode(503)),
                        ));
                        continue;
                    }

                    let _ = request.respond(with_cors(Response::empty(StatusCode(204))));
                    continue;
                }

                if method == Method::Post && (url == "/stop" || url.starts_with("/stop?")) {
                    let _ = http_tx.try_send(RenderMessage::Stop);
                    server_stop.store(true, Ordering::Relaxed);
                    let _ = request.respond(with_cors(
                        Response::from_string("stopped").with_status_code(StatusCode(200)),
                    ));
                    break;
                }

                let _ = request.respond(with_cors(
                    Response::from_string("not found").with_status_code(StatusCode(404)),
                ));
            }
        });
        (upload_url, stop_addr, Some(server_handle))
    };

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(mut existing) = sessions.remove(&session_id) {
            existing.stop_flag.store(true, Ordering::Relaxed);
            let _ = existing.tx.send(RenderMessage::Stop);
            let _ = kick_stop(existing.stop_addr);
            if let Some(handle) = existing.server_handle.take() {
                thread::spawn(move || {
                    let _ = handle.join();
                });
            }
            if let Some(handle) = existing.worker_handle.take() {
                thread::spawn(move || {
                    let _ = handle.join();
                });
            }
        }

        let frame_bytes = (config.width as usize)
            .saturating_mul(config.height as usize)
            .saturating_mul(4);
        sessions.insert(
            session_id.clone(),
            RenderSession {
                tx,
                worker_handle: Some(worker_handle),
                server_handle,
                stop_flag,
                stop_addr,
                frame_bytes,
            },
        );
    }

    Ok(StartRenderResult {
        upload_url,
        session_id,
    })
}

/// Decode JPEG frame bridge payloads on the encode worker (keeps IPC path fast).
/// Raw RGBA batches (exact multiple of frame size) pass through unchanged.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn expand_frame_payload(data: Vec<u8>, frame_bytes: usize) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Err("empty frame payload".into());
    }
    if frame_bytes > 0 && (data.len() == frame_bytes || data.len() % frame_bytes == 0) {
        return Ok(data);
    }
    let is_jpeg = data.len() >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff;
    if !is_jpeg {
        return Ok(data);
    }
    let img = image::load_from_memory(&data)
        .map_err(|e| format!("jpeg decode failed: {e}"))?
        .to_rgba8();
    let rgba = img.into_raw();
    if frame_bytes > 0 && rgba.len() != frame_bytes {
        return Err(format!(
            "jpeg decoded size {} != expected frame bytes {frame_bytes}",
            rgba.len()
        ));
    }
    Ok(rgba)
}

#[tauri::command]
pub fn stream_frame(
    state: State<'_, RenderManager>,
    project_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let tx = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&project_name)
            .map(|session| session.tx.clone())
            .ok_or_else(|| "No active render session found for this project".to_string())?
    };

    // Soft encoder can lag hard on phones; wait longer than the old 2–4s so capture
    // does not abort while openh264 is still chewing a prior frame.
    // JPEG payloads are small — queue them raw; encode worker expands.
    let bytes = data.len();
    match tx.send_timeout(
        RenderMessage::FrameBatch(data),
        Duration::from_millis(20_000),
    ) {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!(
                target: "backend::render",
                "stream_frame queue fail project={project_name} bytes={bytes} err={e}"
            );
            Err(format!("frame queue: {e}"))
        }
    }
}

/// Prefer this on mobile: read a temp RGBA/JPEG batch file instead of huge IPC payloads.
#[tauri::command]
pub fn stream_frame_file(
    app: AppHandle,
    state: State<'_, RenderManager>,
    project_name: String,
    path: String,
) -> Result<(), String> {
    let resolved = if Path::new(&path).is_file() {
        PathBuf::from(&path)
    } else {
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("cache dir: {e}"))?
            .join(&path)
    };
    let data = std::fs::read(&resolved)
        .map_err(|e| format!("read frame file failed path={} err={e}", resolved.display()))?;
    if data.is_empty() {
        return Err("frame file empty".into());
    }
    let tx = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&project_name)
            .map(|session| session.tx.clone())
            .ok_or_else(|| "No active render session found for this project".to_string())?
    };
    let bytes = data.len();
    match tx.send_timeout(
        RenderMessage::FrameBatch(data),
        Duration::from_millis(20_000),
    ) {
        Ok(()) => {
            let _ = std::fs::remove_file(&resolved);
            Ok(())
        }
        Err(e) => {
            log::warn!(
                target: "backend::render",
                "stream_frame_file queue fail project={project_name} bytes={bytes} path={} err={e}",
                resolved.display()
            );
            // Keep file for a possible retry by the same slot name.
            Err(format!("frame queue: {e}"))
        }
    }
}

#[tauri::command]
pub fn stop_render_session(
    state: State<'_, RenderManager>,
    project_name: String,
) -> Result<(), String> {
    log::info!(target: "backend::render", "stop_render_session requested project={project_name}");

    let mut session = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&project_name)
    };

    if let Some(session) = session.as_mut() {
        session.stop_flag.store(true, Ordering::Relaxed);
        let _ = kick_stop(session.stop_addr);
        // Avoid deadlock when the frame queue is full.
        let _ = session.tx.try_send(RenderMessage::Stop);

        // Prefer graceful finalize: encode worker drains and writes moov.
        if let Some(handle) = session.worker_handle.take() {
            let _ = handle.join();
        }

        if let Some(handle) = session.server_handle.take() {
            thread::spawn(move || {
                let _ = handle.join();
            });
        }
    }

    Ok(())
}

#[tauri::command]
pub fn validate_render_segment(path: String, min_duration_sec: f64) -> Result<f64, String> {
    log::debug!(target: "backend::render", "validate_render_segment path={path} min_duration={min_duration_sec}");

    if !Path::new(&path).is_file() {
        return Err(format!("Segment missing: {path}"));
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() < 1024 {
        return Err(format!("Segment too small ({} bytes): {path}", meta.len()));
    }

    crate::commands::encoder::validate_mp4_basic(&path, min_duration_sec)
}

/// Weighted split: worker w gets weight (n − w) + n → n=4 → 8:7:6:5.
fn plan_chunks(total_frames: u32, workers: u32) -> Vec<(u32, u32, u32)> {
    if total_frames == 0 {
        return vec![(0, 0, 0)];
    }
    let workers = workers.max(1);
    if workers == 1 {
        return vec![(0, 0, total_frames)];
    }

    // Σ_w ((n−w)+n) = Σ_k=n+1..2n k = n(3n+1)/2
    let total_weight = workers * (3 * workers + 1) / 2;
    let mut sizes: Vec<u32> = Vec::with_capacity(workers as usize);
    let mut assigned = 0u32;
    for w in 0..workers {
        if w + 1 == workers {
            sizes.push(total_frames.saturating_sub(assigned));
        } else {
            let weight = (workers - w) + workers;
            let size = (total_frames as u64 * weight as u64 / total_weight as u64) as u32;
            sizes.push(size);
            assigned = assigned.saturating_add(size);
        }
    }

    let sum: u32 = sizes.iter().sum();
    if sum < total_frames {
        let mut need = total_frames - sum;
        for size in sizes.iter_mut() {
            if need == 0 {
                break;
            }
            *size += 1;
            need -= 1;
        }
    } else if sum > total_frames {
        let mut over = sum - total_frames;
        for size in sizes.iter_mut().rev() {
            if over == 0 {
                break;
            }
            let take = (*size).min(over);
            *size -= take;
            over -= take;
        }
    }

    let mut out = Vec::new();
    let mut cursor = 0u32;
    for (i, size) in sizes.into_iter().enumerate() {
        let start = cursor;
        let end = cursor + size;
        cursor = end;
        out.push((i as u32, start, end));
    }
    if out.is_empty() {
        out.push((0, 0, total_frames));
    }
    out
}

#[cfg_attr(mobile, allow(dead_code))]
fn with_cors<R: std::io::Read>(response: Response<R>) -> Response<R> {
    let mut response = response;
    if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]) {
        response = response.with_header(h);
    }
    if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, OPTIONS"[..]) {
        response = response.with_header(h);
    }
    if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]) {
        response = response.with_header(h);
    }
    response
}

fn kick_stop(addr: SocketAddr) -> Result<(), String> {
    // Mobile IPC sessions use a dummy 127.0.0.1:0 address (no tiny_http server).
    if addr.port() == 0 {
        return Ok(());
    }
    let addrs = addr
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .collect::<Vec<_>>();
    let target = addrs
        .first()
        .copied()
        .ok_or_else(|| "no stop address".to_string())?;
    if let Ok(mut stream) = TcpStream::connect_timeout(&target, Duration::from_millis(200)) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
        let req = b"POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(req);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRenderOutputArgs {
    pub source_path: String,
    pub destination: String,
}

/// Copy a finished render into a user-selected path (may be content:// on Android).
#[tauri::command]
pub fn publish_render_output(app: AppHandle, args: PublishRenderOutputArgs) -> Result<(), String> {
    log::info!(
        target: "backend::render",
        "publish_render_output source={} dest={}",
        args.source_path,
        args.destination
    );
    let source = Path::new(&args.source_path);
    if !source.is_file() {
        return Err(format!("源文件不存在: {}", args.source_path));
    }
    let bytes = std::fs::read(source).map_err(|e| format!("读取渲染结果失败: {e}"))?;
    if bytes.is_empty() {
        return Err("渲染结果为空".into());
    }

    let dest = args.destination.trim().to_string();
    let lowered = dest.to_ascii_lowercase();
    if lowered.starts_with("content://") || lowered.starts_with("file://") {
        use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
        let file_path = FilePath::from_str(&dest).map_err(|e| format!("解析导出目标失败: {e}"))?;
        let mut options = OpenOptions::new();
        options.write(true).truncate(true).create(true);
        let mut file = app
            .fs()
            .open(file_path, options)
            .map_err(|e| format!("打开导出目标失败: {e}"))?;
        use std::io::Write as _;
        file.write_all(&bytes)
            .map_err(|e| format!("写入导出目标失败: {e}"))?;
        file.flush().map_err(|e| format!("刷新导出目标失败: {e}"))?;
        return Ok(());
    }

    if let Some(parent) = Path::new(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
        }
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入导出文件失败: {e}"))?;
    Ok(())
}
