use crossbeam_channel::{bounded, Sender};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
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

/// Prefer hardware encode when available; fall back to libx264 ultrafast.
fn build_ffmpeg_args(size: &str, fps: &str, export_path: &str, use_nvenc: bool) -> Vec<String> {
    let mut base = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pixel_format".into(),
        "rgba".into(),
        "-video_size".into(),
        size.to_string(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
        "-an".into(),
        "-vf".into(),
        "vflip".into(),
    ];

    if use_nvenc {
        base.extend([
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p1".into(),
            "-tune".into(),
            "ll".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            "20".into(),
            "-b:v".into(),
            "0".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
    } else {
        base.extend([
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-tune".into(),
            "zerolatency".into(),
            "-threads".into(),
            "0".into(),
            "-crf".into(),
            "20".into(),
        ]);
    }

    base.extend([
        "-movflags".into(),
        "+frag_keyframe+empty_moov+default_base_moof".into(),
        "-flush_packets".into(),
        "1".into(),
        export_path.to_string(),
    ]);
    base
}

/// True only if a real short encode with h264_nvenc succeeds.
/// Listing the encoder is not enough (GT 1030 often reports unsupported device).
fn nvenc_usable() -> bool {
    static NVENC_OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *NVENC_OK.get_or_init(|| {
        let listed = Command::new("ffmpeg")
            .args(["-hide_banner", "-encoders"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains("h264_nvenc"))
            .unwrap_or(false);
        if !listed {
            return false;
        }

        // Tiny synthetic encode; must open the HW session successfully.
        // Swallow ffmpeg stderr — unsupported devices (e.g. GT 1030) spam OpenEncodeSessionEx.
        let ok = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "quiet",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=128x128:d=0.05",
                "-frames:v",
                "1",
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p1",
                "-tune",
                "ll",
                "-f",
                "null",
                "-",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if ok {
            log::info!(target: "backend::render", "encoder selected: h264_nvenc");
        } else {
            log::info!(target: "backend::render", "encoder selected: libx264 (nvenc unavailable)");
        }
        ok
    })
}

pub struct RenderSession {
    pub tx: Sender<RenderMessage>,
    pub worker_handle: Option<thread::JoinHandle<()>>,
    pub server_handle: Option<thread::JoinHandle<()>>,
    pub stop_flag: Arc<AtomicBool>,
    pub stop_addr: SocketAddr,
    /// ffmpeg pid for force-kill when stdin write deadlocks.
    pub ffmpeg_pid: Arc<Mutex<Option<u32>>>,
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
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

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

    // Heavy libx265 re-encode must not block the async runtime / UI thread.
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
        // Reject incomplete MP4s (missing moov) before concat; also sum durations for progress.
        let dur = validate_render_segment(path.clone(), 0.01)?;
        probed_total += dur;
    }

    let total_duration_sec = args
        .total_duration_sec
        .filter(|d| d.is_finite() && *d > 0.05)
        .unwrap_or(probed_total)
        .max(0.05);

    if let Some(parent) = Path::new(&args.export_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory: {e}"))?;
        }
    }

    let list_path = Path::new(&args.export_path).with_extension("concat.txt");
    let mut list = String::new();
    for path in &args.segment_paths {
        // Escape single quotes for ffmpeg concat demuxer.
        let escaped = path.replace('\'', "'\\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list).map_err(|e| format!("Failed to write concat list: {e}"))?;

    // Final pass: concat + re-encode with a quality-oriented encoder.
    // -progress pipe:1 emits machine-readable progress on stdout.
    let encode_args = final_delivery_encode_args();
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_path.to_string_lossy().as_ref(),
        "-an",
    ]);
    cmd.args(&encode_args);
    cmd.arg(&args.export_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    log::info!(target: "backend::render", "final merge+encode (progress enabled): {}", encode_args.join(" "));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg concat/encode: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_progress = app.clone();
        let total = total_duration_sec;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut out_time_sec = 0.0_f64;
            for line in reader.lines().flatten() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("out_time_ms=") {
                    if let Ok(ms) = rest.parse::<f64>() {
                        out_time_sec = (ms / 1000.0).max(0.0);
                    }
                } else if let Some(rest) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = rest.parse::<f64>() {
                        out_time_sec = (us / 1_000_000.0).max(0.0);
                    }
                } else if let Some(rest) = line.strip_prefix("out_time=") {
                    // HH:MM:SS.microseconds
                    if let Some(sec) = parse_ffmpeg_clock(rest) {
                        out_time_sec = sec;
                    }
                } else if line == "progress=continue" || line == "progress=end" {
                    let ratio = (out_time_sec / total).clamp(0.0, 1.0);
                    let payload = FfmpegProgressPayload {
                        ratio,
                        out_time_sec,
                        total_duration_sec: total,
                    };
                    let _ = app_progress.emit("export-ffmpeg-progress", &payload);
                    if line == "progress=end" {
                        break;
                    }
                }
            }
        });
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait ffmpeg concat/encode: {e}"))?;

    let _ = std::fs::remove_file(&list_path);

    if !status.success() {
        return Err(format!("ffmpeg concat/encode failed with status {status}"));
    }

    // Ensure UI can snap to end of merge band.
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

fn parse_ffmpeg_clock(value: &str) -> Option<f64> {
    // "HH:MM:SS.micro" or "MM:SS.micro"
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let s: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse().ok()?;
        let s: f64 = parts[1].parse().ok()?;
        Some(m * 60.0 + s)
    } else {
        value.parse().ok()
    }
}

/// Quality-oriented final encode args (no input/output paths).
/// Prefer libx265 medium; fall back to libx264 medium.
fn final_delivery_encode_args() -> Vec<String> {
    static ARGS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ARGS.get_or_init(|| {
        if encoder_name_listed("libx265") {
            log::info!(target: "backend::render", "final encoder: libx265 medium CRF 20");
            vec![
                "-c:v".into(),
                "libx265".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "20".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-tag:v".into(),
                "hvc1".into(),
                "-movflags".into(),
                "+faststart".into(),
            ]
        } else {
            log::info!(target: "backend::render", "final encoder: libx264 medium CRF 18");
            vec![
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "18".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-movflags".into(),
                "+faststart".into(),
            ]
        }
    })
    .clone()
}

fn encoder_name_listed(name: &str) -> bool {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(name))
        .unwrap_or(false)
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

    if config.width == 0 || config.height == 0 {
        return Err("Invalid render size".to_string());
    }
    if config.fps == 0 {
        return Err("Invalid fps".to_string());
    }
    if config.export_path.trim().is_empty() {
        return Err("Export path is empty".to_string());
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
    let (tx, rx) = bounded::<RenderMessage>(48);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let ffmpeg_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));

    let config_clone = config.clone();
    let stop_flag_worker = Arc::clone(&stop_flag);
    let ffmpeg_pid_worker = Arc::clone(&ffmpeg_pid);
    let worker_handle = thread::spawn(move || {
        let size = format!("{}x{}", config_clone.width, config_clone.height);
        let fps = config_clone.fps.to_string();

        // Probe once process-wide; never pick NVENC just because the encoder name exists.
        let use_nvenc = nvenc_usable();
        let ffmpeg_args = build_ffmpeg_args(&size, &fps, &config_clone.export_path, use_nvenc);
        let mut child = match Command::new("ffmpeg")
            .args(&ffmpeg_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                log::error!(target: "backend::render", "Failed to spawn ffmpeg: {e}");
                while let Ok(msg) = rx.recv() {
                    if matches!(msg, RenderMessage::Stop) {
                        break;
                    }
                }
                return;
            }
        };

        if let Ok(mut guard) = ffmpeg_pid_worker.lock() {
            *guard = Some(child.id());
        }

        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                log::error!(target: "backend::render", "Failed to open ffmpeg stdin");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        };

        let frame_bytes =
            (config_clone.width as usize) * (config_clone.height as usize) * 4;

        loop {
            if stop_flag_worker.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(RenderMessage::FrameBatch(data)) => {
                    if stop_flag_worker.load(Ordering::Relaxed) {
                        break;
                    }
                    if data.is_empty() || data.len() % frame_bytes != 0 {
                        log::error!(target: "backend::render", "Unexpected batch size: got {} bytes, frame {} ({}x{})", data.len(), frame_bytes, config_clone.width, config_clone.height);
                        break;
                    }
                    // Chunked write so stop_flag can be observed between chunks.
                    let mut offset = 0usize;
                    let mut write_failed = false;
                    while offset < data.len() {
                        if stop_flag_worker.load(Ordering::Relaxed) {
                            write_failed = true;
                            break;
                        }
                        let end = (offset + 256 * 1024).min(data.len());
                        match stdin.write(&data[offset..end]) {
                            Ok(0) => {
                                write_failed = true;
                                break;
                            }
                            Ok(n) => offset += n,
                            Err(e) => {
                                log::error!(target: "backend::render", "FFmpeg stdin write error: {e}");
                                write_failed = true;
                                break;
                            }
                        }
                    }
                    if write_failed {
                        break;
                    }
                }
                Ok(RenderMessage::Stop) => break,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(stdin);
        // Force-finish if encoder is stuck after stdin close.
        let wait_deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let mut err = String::new();
                        if let Some(mut stderr) = child.stderr.take() {
                            let _ = stderr.read_to_string(&mut err);
                        }
                        log::error!(target: "backend::render", "ffmpeg exited with status {status}: {err}");
                    }
                    break;
                }
                Ok(None) => {
                    if std::time::Instant::now() >= wait_deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        log::warn!(target: "backend::render", "ffmpeg force-killed after stop timeout");
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    log::error!(target: "backend::render", "Failed to wait for ffmpeg: {e}");
                    let _ = child.kill();
                    break;
                }
            }
        }
        if let Ok(mut guard) = ffmpeg_pid_worker.lock() {
            *guard = None;
        }
    });

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
                match http_tx.send_timeout(
                    RenderMessage::FrameBatch(body),
                    Duration::from_secs(5),
                ) {
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

        sessions.insert(
            session_id.clone(),
            RenderSession {
                tx,
                worker_handle: Some(worker_handle),
                server_handle: Some(server_handle),
                stop_flag,
                stop_addr,
                ffmpeg_pid,
            },
        );
    }

    Ok(StartRenderResult {
        upload_url,
        session_id,
    })
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

    tx.send(RenderMessage::FrameBatch(data))
        .map_err(|e| e.to_string())?;
    Ok(())
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

        // Prefer graceful finalize: worker closes stdin and waits up to ~20s.
        if let Some(handle) = session.worker_handle.take() {
            let _ = handle.join();
        }
        // Last resort if pid still recorded.
        if let Ok(guard) = session.ffmpeg_pid.lock() {
            if let Some(pid) = *guard {
                let _ = Command::new("kill")
                    .args(["-15", &pid.to_string()])
                    .status();
                thread::sleep(Duration::from_millis(400));
                let _ = Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status();
            }
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

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path,
        ])
        .output()
        .map_err(|e| format!("ffprobe failed: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Invalid segment (no moov/unreadable): {path}: {err}"));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let duration: f64 = text
        .parse()
        .map_err(|_| format!("Could not parse duration '{text}' for {path}"))?;
    if duration + 1e-3 < min_duration_sec {
        return Err(format!(
            "Segment too short: {path} duration={duration:.3}s < expected {min_duration_sec:.3}s"
        ));
    }
    Ok(duration)
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
