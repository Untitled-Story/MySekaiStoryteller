use crate::commands::project::write_picked_destination;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

#[cfg(desktop)]
use std::io::{BufWriter, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(desktop)]
use std::process::{Child, Command, Stdio};
#[cfg(desktop)]
use std::sync::mpsc::{self, SyncSender};
#[cfg(desktop)]
use std::thread::JoinHandle;

const MAX_WIDTH: u32 = 7680;
const MAX_HEIGHT: u32 = 4320;
const MIN_WIDTH: u32 = 320;
const MIN_HEIGHT: u32 = 240;
const MIN_FPS: f64 = 1.0;
const MAX_FPS: f64 = 240.0;
#[cfg(desktop)]
const FFMPEG_PIPE_QUEUE_CAPACITY: usize = 8;
#[cfg(desktop)]
const WRITER_BUFFER_BYTES: usize = 4 * 1024 * 1024;
#[cfg(desktop)]
const STDERR_CAPTURE_LIMIT_BYTES: usize = 64 * 1024;

static NEXT_SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct VideoExportSessions {
    inner: Mutex<HashMap<String, ExportSessionEntry>>,
}

enum ExportSessionEntry {
    WebCodecs(Arc<Mutex<WebCodecsSession>>),
    #[cfg(desktop)]
    Ffmpeg(Arc<Mutex<FfmpegSession>>),
}

struct WebCodecsSession {
    session_dir: PathBuf,
    output_path: PathBuf,
    file: File,
    bytes_written: u64,
}

#[cfg(desktop)]
struct FfmpegSession {
    session_dir: PathBuf,
    video_only_path: PathBuf,
    wav_path: PathBuf,
    final_path: PathBuf,
    ffmpeg_path: PathBuf,
    container: String,
    audio_codec: String,
    frame_tx: Option<SyncSender<Vec<u8>>>,
    writer_handle: Option<JoinHandle<Result<(), String>>>,
    stderr_handle: Option<JoinHandle<String>>,
    child: Option<Child>,
    expected_frame_bytes: usize,
    frames_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegCapabilities {
    pub available: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub custom_path_invalid: bool,
    pub hardware_encoders: Vec<String>,
    pub software_encoders: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct StartExportRequest {
    pub mode: String,
    pub container: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate_kbps: Option<u32>,
    pub crf: Option<u8>,
    pub hardware_accel: bool,
    pub ffmpeg_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartExportResponse {
    pub session_id: String,
    pub selected_encoder: Option<String>,
    pub expected_frame_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishExportResponse {
    pub output_path: String,
    pub file_size_bytes: u64,
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
const KNOWN_HARDWARE_ENCODERS: &[&str] = &[
    "h264_videotoolbox",
    "hevc_videotoolbox",
    "prores_videotoolbox",
    "h264_nvenc",
    "hevc_nvenc",
    "av1_nvenc",
    "h264_amf",
    "hevc_amf",
    "av1_amf",
    "h264_qsv",
    "hevc_qsv",
    "av1_qsv",
    "h264_vaapi",
    "hevc_vaapi",
];

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
const KNOWN_SOFTWARE_ENCODERS: &[&str] = &[
    "libx264",
    "libx265",
    "libvpx-vp9",
    "libsvtav1",
    "libaom-av1",
    "prores_ks",
    "aac",
    "libopus",
];

#[tauri::command]
pub async fn probe_ffmpeg_capabilities(
    custom_path: Option<String>,
) -> Result<FfmpegCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || probe_ffmpeg_sync(custom_path.as_deref()))
        .await
        .map_err(|error| format!("FFmpeg probe task failed: {error}"))
}

#[tauri::command]
pub async fn export_start_session(
    app: AppHandle,
    sessions: State<'_, VideoExportSessions>,
    request: StartExportRequest,
) -> Result<StartExportResponse, String> {
    validate_export_request(&request)?;

    let session_id = next_session_id();
    let session_dir = export_temp_root(&app)?.join(&session_id);
    fs::create_dir_all(&session_dir)
        .map_err(|error| format!("创建视频导出缓存目录失败: {error}"))?;

    let container_ext = container_extension(&request.container)?;
    let expected_frame_bytes = if request.mode == "webcodecs" {
        0
    } else {
        expected_raw_frame_bytes(request.width, request.height, &request.pixel_format)?
    };

    let created = match request.mode.as_str() {
        "webcodecs" => {
            let output_path = session_dir.join(format!("output.{container_ext}"));
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(&output_path)
                .map_err(|error| {
                    let _ = fs::remove_dir_all(&session_dir);
                    format!("创建导出临时文件失败: {error}")
                })?;

            let entry = ExportSessionEntry::WebCodecs(Arc::new(Mutex::new(WebCodecsSession {
                session_dir: session_dir.clone(),
                output_path,
                file,
                bytes_written: 0,
            })));
            (entry, None)
        }
        "ffmpeg" => {
            #[cfg(not(desktop))]
            {
                let _ = fs::remove_dir_all(&session_dir);
                return Err("移动平台暂不支持 FFmpeg 后端，请使用 WebCodecs 引擎。".into());
            }

            #[cfg(desktop)]
            {
                let caps = probe_ffmpeg_sync(request.ffmpeg_path.as_deref());
                if caps.custom_path_invalid {
                    let _ = fs::remove_dir_all(&session_dir);
                    return Err("设置中指定的 FFmpeg 路径无效或不可执行。".into());
                }
                let executable_path = match caps.executable_path {
                    Some(path) => PathBuf::from(path),
                    None => {
                        let _ = fs::remove_dir_all(&session_dir);
                        return Err("未检测到可用的 FFmpeg 可执行文件，请在设置中配置路径。".into());
                    }
                };
                let selected_encoder = select_ffmpeg_encoder(
                    &request.video_codec,
                    request.hardware_accel,
                    request.pixel_format == "rgba",
                    &caps.hardware_encoders,
                    &caps.software_encoders,
                )
                .ok_or_else(|| {
                    let _ = fs::remove_dir_all(&session_dir);
                    format!("当前 FFmpeg 未包含可用的 {} 编码器。", request.video_codec)
                })?;

                let video_only_path = session_dir.join(format!("video_only.{container_ext}"));
                let wav_path = session_dir.join("audio.wav");
                let final_path = session_dir.join(format!("final.{container_ext}"));
                let args = build_ffmpeg_video_args(&request, &selected_encoder, &video_only_path)?;

                let mut command = configure_ffmpeg_command(&executable_path);
                command
                    .args(&args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());

                let mut child = command.spawn().map_err(|error| {
                    let _ = fs::remove_dir_all(&session_dir);
                    format!("启动 FFmpeg 失败: {error}")
                })?;

                let stdin = child.stdin.take().ok_or_else(|| {
                    let _ = child.kill();
                    let _ = fs::remove_dir_all(&session_dir);
                    "无法打开 FFmpeg 标准输入管道".to_string()
                })?;
                let stderr = child.stderr.take();

                let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(FFMPEG_PIPE_QUEUE_CAPACITY);
                let writer_handle = std::thread::Builder::new()
                    .name(format!("ffmpeg-pipe-{session_id}"))
                    .spawn(move || {
                        let mut writer = BufWriter::with_capacity(WRITER_BUFFER_BYTES, stdin);
                        for chunk in rx {
                            writer
                                .write_all(&chunk)
                                .map_err(|error| format!("写入 FFmpeg 视频管道失败: {error}"))?;
                        }
                        writer
                            .flush()
                            .map_err(|error| format!("刷新 FFmpeg 视频管道失败: {error}"))?;
                        Ok(())
                    })
                    .map_err(|error| {
                        let _ = child.kill();
                        let _ = fs::remove_dir_all(&session_dir);
                        format!("创建 FFmpeg 写入线程失败: {error}")
                    })?;

                let stderr_handle = stderr
                    .map(|mut pipe| {
                        std::thread::Builder::new()
                            .name(format!("ffmpeg-err-{session_id}"))
                            .spawn(move || read_capped_stderr(&mut pipe))
                            .ok()
                    })
                    .flatten();

                let entry = ExportSessionEntry::Ffmpeg(Arc::new(Mutex::new(FfmpegSession {
                    session_dir,
                    video_only_path,
                    wav_path,
                    final_path,
                    ffmpeg_path: executable_path,
                    container: request.container.clone(),
                    audio_codec: request.audio_codec.clone(),
                    frame_tx: Some(tx),
                    writer_handle: Some(writer_handle),
                    stderr_handle,
                    child: Some(child),
                    expected_frame_bytes,
                    frames_written: 0,
                })));
                (entry, Some(selected_encoder))
            }
        }
        other => {
            let _ = fs::remove_dir_all(&session_dir);
            return Err(format!("不支持的视频导出模式: {other}"));
        }
    };

    {
        let mut map = sessions
            .inner
            .lock()
            .map_err(|_| "视频导出会话锁已损坏".to_string())?;
        map.insert(session_id.clone(), created.0);
    }

    Ok(StartExportResponse {
        session_id,
        selected_encoder: created.1,
        expected_frame_bytes,
    })
}

#[tauri::command]
pub async fn export_write_chunk(
    sessions: State<'_, VideoExportSessions>,
    request: Request<'_>,
) -> Result<(), String> {
    let session_id = header_str(&request, "x-export-id")?;
    let offset_header = request
        .headers()
        .get("x-offset")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| "无效的 x-offset 偏移值".to_string())?;

    let bytes: Vec<u8> = extract_raw_body(&request)?;

    let session_arc = {
        let map = sessions
            .inner
            .lock()
            .map_err(|_| "视频导出会话锁已损坏".to_string())?;
        match map.get(&session_id) {
            Some(ExportSessionEntry::WebCodecs(arc)) => Arc::clone(arc),
            #[cfg(desktop)]
            Some(ExportSessionEntry::Ffmpeg(_)) => {
                return Err("FFmpeg 会话不接受容器分块写入".into());
            }
            None => return Err("视频导出会话不存在或已取消".into()),
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session_arc
            .lock()
            .map_err(|_| "WebCodecs 导出会话锁已损坏".to_string())?;
        if let Some(offset) = offset_header {
            session
                .file
                .seek(SeekFrom::Start(offset))
                .map_err(|error| format!("定位输出文件偏移失败: {error}"))?;
        } else {
            session
                .file
                .seek(SeekFrom::End(0))
                .map_err(|error| format!("定位输出文件末尾失败: {error}"))?;
        }
        session
            .file
            .write_all(&bytes)
            .map_err(|error| format!("写入导出视频块失败: {error}"))?;
        let end_pos = offset_header
            .map(|offset| offset.saturating_add(bytes.len() as u64))
            .unwrap_or_else(|| session.bytes_written.saturating_add(bytes.len() as u64));
        if end_pos > session.bytes_written {
            session.bytes_written = end_pos;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("写入分块任务失败: {error}"))?
}

#[tauri::command]
pub async fn export_push_video_batch(
    sessions: State<'_, VideoExportSessions>,
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (sessions, request);
        Err("移动平台暂不支持 FFmpeg 后端，请使用 WebCodecs 引擎。".into())
    }

    #[cfg(desktop)]
    {
        let session_id = header_str(&request, "x-export-id")?;
        let bytes: Vec<u8> = extract_raw_body(&request)?;
        if bytes.is_empty() {
            return Ok(());
        }

        let (tx, expected_frame_bytes) = {
            let map = sessions
                .inner
                .lock()
                .map_err(|_| "视频导出会话锁已损坏".to_string())?;
            let session_arc = match map.get(&session_id) {
                Some(ExportSessionEntry::Ffmpeg(arc)) => Arc::clone(arc),
                Some(ExportSessionEntry::WebCodecs(_)) => {
                    return Err("WebCodecs 会话不接受原始视频帧批次".into());
                }
                None => return Err("视频导出会话不存在或已取消".into()),
            };
            let mut session = session_arc
                .lock()
                .map_err(|_| "FFmpeg 导出会话锁已损坏".to_string())?;
            if session.expected_frame_bytes == 0 || bytes.len() % session.expected_frame_bytes != 0
            {
                return Err(format!(
                    "视频帧字节数与分辨率不匹配: bytes={}, expected_frame={}",
                    bytes.len(),
                    session.expected_frame_bytes
                ));
            }
            let batch_frames = (bytes.len() / session.expected_frame_bytes) as u64;
            session.frames_written = session.frames_written.saturating_add(batch_frames);
            let tx = session
                .frame_tx
                .as_ref()
                .cloned()
                .ok_or_else(|| "FFmpeg 视频输入通道已关闭".to_string())?;
            (tx, session.expected_frame_bytes)
        };
        let _ = expected_frame_bytes;

        tauri::async_runtime::spawn_blocking(move || {
            tx.send(bytes)
                .map_err(|_| "FFmpeg 写入通道已断开（编码器可能已异常退出）".to_string())
        })
        .await
        .map_err(|error| format!("推送视频批次任务失败: {error}"))?
    }
}

#[tauri::command]
pub async fn export_upload_wav(
    sessions: State<'_, VideoExportSessions>,
    request: Request<'_>,
) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (sessions, request);
        Err("仅 FFmpeg 会话支持 WAV 音频上传".into())
    }

    #[cfg(desktop)]
    {
        let session_id = header_str(&request, "x-export-id")?;
        let bytes: Vec<u8> = extract_raw_body(&request)?;

        let wav_path = {
            let map = sessions
                .inner
                .lock()
                .map_err(|_| "视频导出会话锁已损坏".to_string())?;
            let session_arc = match map.get(&session_id) {
                Some(ExportSessionEntry::Ffmpeg(arc)) => Arc::clone(arc),
                _ => return Err("仅 FFmpeg 会话支持 WAV 音频上传".into()),
            };
            let session = session_arc
                .lock()
                .map_err(|_| "FFmpeg 导出会话锁已损坏".to_string())?;
            session.wav_path.clone()
        };

        tauri::async_runtime::spawn_blocking(move || {
            fs::write(&wav_path, &bytes)
                .map_err(|error| format!("写入临时音频 WAV 失败: {error}"))
        })
        .await
        .map_err(|error| format!("保存临时音频任务失败: {error}"))?
    }
}

#[tauri::command]
pub async fn export_finish_session(
    app: AppHandle,
    sessions: State<'_, VideoExportSessions>,
    session_id: String,
    destination_path: String,
    has_audio: bool,
) -> Result<FinishExportResponse, String> {
    #[cfg(not(desktop))]
    let _ = has_audio;

    if !is_safe_session_id(&session_id) {
        return Err("无效的导出会话 ID".into());
    }
    if destination_path.trim().is_empty() {
        return Err("导出路径不能为空".into());
    }

    let entry = {
        let mut map = sessions
            .inner
            .lock()
            .map_err(|_| "视频导出会话锁已损坏".to_string())?;
        map.remove(&session_id)
            .ok_or_else(|| "视频导出会话不存在或已被取消".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || match entry {
        ExportSessionEntry::WebCodecs(arc) => {
            let session = arc
                .lock()
                .map_err(|_| "WebCodecs 导出会话锁已损坏".to_string())?;
            session
                .file
                .sync_all()
                .map_err(|error| format!("刷新导出缓存文件失败: {error}"))?;
            let size = fs::metadata(&session.output_path)
                .map(|m| m.len())
                .unwrap_or(session.bytes_written);
            if size == 0 {
                let _ = fs::remove_dir_all(&session.session_dir);
                return Err("导出的视频文件为空".into());
            }
            let write_result =
                write_picked_destination(&app, &destination_path, &session.output_path);
            let _ = fs::remove_dir_all(&session.session_dir);
            write_result?;
            Ok(FinishExportResponse {
                output_path: destination_path,
                file_size_bytes: size,
            })
        }
        #[cfg(desktop)]
        ExportSessionEntry::Ffmpeg(arc) => {
            let mut session = arc
                .lock()
                .map_err(|_| "FFmpeg 导出会话锁已损坏".to_string())?;
            session.frame_tx.take();

            let writer_result = if let Some(handle) = session.writer_handle.take() {
                handle
                    .join()
                    .map_err(|_| "FFmpeg 管道写入线程崩溃".to_string())?
            } else {
                Ok(())
            };

            let stderr_text = if let Some(handle) = session.stderr_handle.take() {
                handle.join().unwrap_or_default()
            } else {
                String::new()
            };

            if let Some(mut child) = session.child.take() {
                let status = child
                    .wait()
                    .map_err(|error| format!("等待 FFmpeg 完成失败: {error}"))?;
                if !status.success() {
                    let _ = fs::remove_dir_all(&session.session_dir);
                    let tail = tail_lines(&stderr_text, 12);
                    return Err(format!("FFmpeg 视频编码失败 ({status}): {tail}"));
                }
            }

            if let Err(error) = writer_result {
                let _ = fs::remove_dir_all(&session.session_dir);
                return Err(error);
            }

            let source_file =
                if has_audio && session.audio_codec != "none" && session.wav_path.is_file() {
                    let mux_args = build_ffmpeg_mux_args(
                        &session.video_only_path,
                        &session.wav_path,
                        &session.final_path,
                        &session.container,
                        &session.audio_codec,
                    )?;
                    let mut mux_cmd = configure_ffmpeg_command(&session.ffmpeg_path);
                    let output = mux_cmd
                        .args(&mux_args)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::piped())
                        .output()
                        .map_err(|error| {
                            let _ = fs::remove_dir_all(&session.session_dir);
                            format!("启动 FFmpeg 音视频混流失败: {error}")
                        })?;
                    if !output.status.success() {
                        let stderr_tail = tail_lines(&String::from_utf8_lossy(&output.stderr), 12);
                        let _ = fs::remove_dir_all(&session.session_dir);
                        return Err(format!(
                            "FFmpeg 音视频混流失败 ({}): {stderr_tail}",
                            output.status
                        ));
                    }
                    &session.final_path
                } else {
                    &session.video_only_path
                };

            let size = fs::metadata(source_file).map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                let _ = fs::remove_dir_all(&session.session_dir);
                return Err("FFmpeg 输出文件为空".into());
            }

            let write_result = write_picked_destination(&app, &destination_path, source_file);
            let _ = fs::remove_dir_all(&session.session_dir);
            write_result?;

            Ok(FinishExportResponse {
                output_path: destination_path,
                file_size_bytes: size,
            })
        }
    })
    .await
    .map_err(|error| format!("完成导出任务失败: {error}"))?
}

#[tauri::command]
pub async fn export_abort_session(
    sessions: State<'_, VideoExportSessions>,
    session_id: String,
) -> Result<(), String> {
    if !is_safe_session_id(&session_id) {
        return Ok(());
    }
    let removed = {
        let mut map = sessions
            .inner
            .lock()
            .map_err(|_| "视频导出会话锁已损坏".to_string())?;
        map.remove(&session_id)
    };
    if let Some(entry) = removed {
        let _ = tauri::async_runtime::spawn_blocking(move || cleanup_session(entry)).await;
    }
    Ok(())
}

fn cleanup_session(entry: ExportSessionEntry) {
    match entry {
        ExportSessionEntry::WebCodecs(arc) => {
            if let Ok(session) = arc.lock() {
                let _ = fs::remove_dir_all(&session.session_dir);
            }
        }
        #[cfg(desktop)]
        ExportSessionEntry::Ffmpeg(arc) => {
            if let Ok(mut session) = arc.lock() {
                session.frame_tx.take();
                if let Some(mut child) = session.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                if let Some(handle) = session.writer_handle.take() {
                    let _ = handle.join();
                }
                if let Some(handle) = session.stderr_handle.take() {
                    let _ = handle.join();
                }
                let _ = fs::remove_dir_all(&session.session_dir);
            }
        }
    }
}

fn export_temp_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("video-exports"))
        .map_err(|error| format!("获取应用缓存目录失败: {error}"))
}

fn next_session_id() -> String {
    let seq = NEXT_SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("vexp-{nanos:x}-{seq}")
}

fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn header_str(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .ok_or_else(|| format!("缺少请求头: {name}"))?;
    if name == "x-export-id" && !is_safe_session_id(&raw) {
        return Err("无效的导出会话 ID".into());
    }
    Ok(raw)
}

fn extract_raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(value) => {
            if let Some(encoded) = value.get("dataBase64").and_then(|v| v.as_str()) {
                return decode_base64(encoded);
            }
            Err("必须使用原始二进制缓冲区 (InvokeBody::Raw) 上传数据".into())
        }
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn decode_char(byte: u8) -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("Base64 数据包含非法字符: 0x{byte:02x}")),
        }
    }

    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() % 4 != 0 {
        return Err("Base64 数据长度无效".into());
    }

    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };

    let mut out = Vec::with_capacity((bytes.len() / 4) * 3 - padding);
    let last_chunk_start = bytes.len() - 4;

    for (idx, chunk) in bytes.chunks_exact(4).enumerate() {
        let is_last = idx * 4 == last_chunk_start;
        if !is_last && chunk.contains(&b'=') {
            return Err("Base64 填充字符只能出现在末尾".into());
        }

        let a = decode_char(chunk[0])?;
        let b = decode_char(chunk[1])?;
        let c = if chunk[2] == b'=' {
            if chunk[3] != b'=' {
                return Err("Base64 填充格式无效".into());
            }
            0
        } else {
            decode_char(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            decode_char(chunk[3])?
        };

        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            out.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            out.push((c << 6) | d);
        }
    }

    Ok(out)
}

fn validate_export_request(request: &StartExportRequest) -> Result<(), String> {
    if request.width < MIN_WIDTH || request.width > MAX_WIDTH {
        return Err(format!("视频宽度必须在 {MIN_WIDTH}..={MAX_WIDTH} 范围内"));
    }
    if request.height < MIN_HEIGHT || request.height > MAX_HEIGHT {
        return Err(format!("视频高度必须在 {MIN_HEIGHT}..={MAX_HEIGHT} 范围内"));
    }
    if request.width % 2 != 0 || request.height % 2 != 0 {
        return Err("视频宽高必须为偶数以确保编码器兼容性".into());
    }
    if !request.fps.is_finite() || request.fps < MIN_FPS || request.fps > MAX_FPS {
        return Err(format!("帧率必须在 {MIN_FPS}..={MAX_FPS} 范围内"));
    }
    let _ = container_extension(&request.container)?;
    if !matches!(request.mode.as_str(), "webcodecs" | "ffmpeg") {
        return Err(format!("不支持的视频导出模式: {}", request.mode));
    }
    if !matches!(
        request.video_codec.as_str(),
        "auto" | "h264" | "hevc" | "vp9" | "av1" | "prores"
    ) {
        return Err(format!("不支持的视频编码格式: {}", request.video_codec));
    }
    if !matches!(
        request.audio_codec.as_str(),
        "aac" | "opus" | "pcm_s16le" | "none"
    ) {
        return Err(format!("不支持的音频编码格式: {}", request.audio_codec));
    }
    if request.mode == "webcodecs" {
        if request.pixel_format != "encoded" {
            return Err(format!(
                "WebCodecs 模式仅支持 encoded 像素输入: {}",
                request.pixel_format
            ));
        }
    } else if !matches!(request.pixel_format.as_str(), "nv12" | "rgba") {
        return Err(format!("不支持的像素输入格式: {}", request.pixel_format));
    }
    if let Some(bitrate_kbps) = request.bitrate_kbps {
        if !(100..=500_000).contains(&bitrate_kbps) {
            return Err("目标码率超出合法范围 (100..=500000 kbps)".into());
        }
    }
    if let Some(crf) = request.crf {
        if crf > 51 {
            return Err("CRF 质量参数必须在 0..=51 范围内".into());
        }
    }
    Ok(())
}

fn expected_raw_frame_bytes(width: u32, height: u32, pixel_format: &str) -> Result<usize, String> {
    let w = usize::try_from(width).map_err(|_| "视频宽度溢出".to_string())?;
    let h = usize::try_from(height).map_err(|_| "视频高度溢出".to_string())?;
    let pixels = w.checked_mul(h).ok_or_else(|| "像素数量溢出".to_string())?;
    match pixel_format {
        "nv12" => {
            let half = pixels / 2;
            pixels
                .checked_add(half)
                .ok_or_else(|| "帧字节大小溢出".to_string())
        }
        "rgba" => pixels
            .checked_mul(4)
            .ok_or_else(|| "帧字节大小溢出".to_string()),
        _ => Err(format!("不支持的像素格式: {pixel_format}")),
    }
}

fn container_extension(container: &str) -> Result<&'static str, String> {
    match container {
        "mp4" => Ok("mp4"),
        "webm" => Ok("webm"),
        "mov" => Ok("mov"),
        _ => Err(format!("不支持的封装格式: {container}")),
    }
}

#[cfg(desktop)]
fn configure_ffmpeg_command(executable: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(desktop)]
fn probe_ffmpeg_sync(custom_path: Option<&str>) -> FfmpegCapabilities {
    let trimmed_custom = custom_path
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let (resolved, custom_path_invalid) = if let Some(custom) = trimmed_custom {
        let path = PathBuf::from(custom);
        if is_executable_ffmpeg(&path) {
            (Some(path), false)
        } else {
            (None, true)
        }
    } else {
        (discover_system_ffmpeg(), false)
    };

    let Some(executable) = resolved else {
        return FfmpegCapabilities {
            available: false,
            executable_path: None,
            version: None,
            custom_path_invalid,
            hardware_encoders: Vec::new(),
            software_encoders: Vec::new(),
        };
    };

    let version = read_ffmpeg_version(&executable);
    let (hardware_encoders, software_encoders) = read_ffmpeg_encoders(&executable);

    FfmpegCapabilities {
        available: version.is_some(),
        executable_path: Some(executable.to_string_lossy().into_owned()),
        version,
        custom_path_invalid,
        hardware_encoders,
        software_encoders,
    }
}

#[cfg(not(desktop))]
fn probe_ffmpeg_sync(_custom_path: Option<&str>) -> FfmpegCapabilities {
    FfmpegCapabilities {
        available: false,
        executable_path: None,
        version: None,
        custom_path_invalid: false,
        hardware_encoders: Vec::new(),
        software_encoders: Vec::new(),
    }
}

#[cfg(desktop)]
fn discover_system_ffmpeg() -> Option<PathBuf> {
    let bin_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let candidate = dir.join(bin_name);
            if is_executable_ffmpeg(&candidate) {
                return Some(candidate);
            }
        }
    }

    let mut well_known: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        well_known.push(PathBuf::from("/opt/homebrew/bin/ffmpeg"));
        well_known.push(PathBuf::from("/usr/local/bin/ffmpeg"));
        well_known.push(PathBuf::from("/opt/local/bin/ffmpeg"));
    }
    #[cfg(target_os = "linux")]
    {
        well_known.push(PathBuf::from("/usr/bin/ffmpeg"));
        well_known.push(PathBuf::from("/usr/local/bin/ffmpeg"));
        well_known.push(PathBuf::from("/snap/bin/ffmpeg"));
    }
    #[cfg(windows)]
    {
        well_known.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            well_known.push(
                PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join("ffmpeg.exe"),
            );
        }
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            well_known.push(
                PathBuf::from(user_profile)
                    .join("scoop")
                    .join("shims")
                    .join("ffmpeg.exe"),
            );
        }
    }

    well_known
        .into_iter()
        .find(|candidate| is_executable_ffmpeg(candidate))
}

#[cfg(desktop)]
fn is_executable_ffmpeg(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    configure_ffmpeg_command(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(desktop)]
fn read_ffmpeg_version(path: &Path) -> Option<String> {
    let output = configure_ffmpeg_command(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

#[cfg(desktop)]
fn read_ffmpeg_encoders(path: &Path) -> (Vec<String>, Vec<String>) {
    let Ok(output) = configure_ffmpeg_command(path)
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return (Vec::new(), Vec::new());
    };
    if !output.status.success() {
        return (Vec::new(), Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_encoder_list(&stdout)
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
fn parse_encoder_list(stdout: &str) -> (Vec<String>, Vec<String>) {
    let mut hardware = Vec::new();
    let mut software = Vec::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        let Some((_, rest)) = trimmed.split_once(' ') else {
            continue;
        };
        let Some(name) = rest.split_whitespace().next() else {
            continue;
        };
        if KNOWN_HARDWARE_ENCODERS.contains(&name) && !hardware.iter().any(|item| item == name) {
            hardware.push(name.to_string());
        } else if KNOWN_SOFTWARE_ENCODERS.contains(&name)
            && !software.iter().any(|item| item == name)
        {
            software.push(name.to_string());
        }
    }

    (hardware, software)
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
fn select_ffmpeg_encoder(
    requested_codec: &str,
    prefer_hardware: bool,
    transparent_alpha: bool,
    hardware_encoders: &[String],
    software_encoders: &[String],
) -> Option<String> {
    let has_hw = |name: &str| hardware_encoders.iter().any(|item| item == name);
    let has_sw = |name: &str| software_encoders.iter().any(|item| item == name);

    if transparent_alpha {
        if requested_codec == "prores" {
            return if has_sw("prores_ks") {
                Some("prores_ks".to_string())
            } else {
                None
            };
        }
        return if has_sw("libvpx-vp9") {
            Some("libvpx-vp9".to_string())
        } else {
            None
        };
    }

    let candidates: &[&str] = match requested_codec {
        "hevc" => &[
            "hevc_videotoolbox",
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_amf",
            "hevc_vaapi",
            "libx265",
        ],
        "h264" => &[
            "h264_videotoolbox",
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_vaapi",
            "libx264",
        ],
        "vp9" => &["libvpx-vp9"],
        "av1" => &["av1_nvenc", "av1_qsv", "av1_amf", "libsvtav1", "libaom-av1"],
        "prores" => &["prores_videotoolbox", "prores_ks"],
        _ => &[
            "hevc_videotoolbox",
            "hevc_nvenc",
            "h264_videotoolbox",
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_vaapi",
            "libx264",
            "libx265",
        ],
    };

    if prefer_hardware {
        for candidate in candidates {
            if KNOWN_HARDWARE_ENCODERS.contains(candidate) && has_hw(candidate) {
                return Some((*candidate).to_string());
            }
        }
    }

    for candidate in candidates {
        if has_sw(candidate) || (!prefer_hardware && has_hw(candidate)) {
            return Some((*candidate).to_string());
        }
    }

    // Also try hardware fallback if user disabled hardware preference only as soft preference and SW encoder missing
    if !prefer_hardware {
        for candidate in candidates {
            if has_hw(candidate) {
                return Some((*candidate).to_string());
            }
        }
    }

    None
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
fn format_fps_arg(fps: f64) -> String {
    if (fps.fract()).abs() < 1e-6 {
        format!("{}", fps.round() as u32)
    } else {
        format!("{fps:.6}")
    }
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
fn build_ffmpeg_video_args(
    request: &StartExportRequest,
    encoder: &str,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pixel_format".to_string(),
        request.pixel_format.clone(),
        "-video_size".to_string(),
        format!("{}x{}", request.width, request.height),
        "-framerate".to_string(),
        format_fps_arg(request.fps),
    ];

    if request.pixel_format == "nv12" {
        args.extend([
            "-color_range".to_string(),
            "tv".to_string(),
            "-colorspace".to_string(),
            "bt709".to_string(),
            "-color_primaries".to_string(),
            "bt709".to_string(),
            "-color_trc".to_string(),
            "iec61966-2-1".to_string(),
        ]);
    }

    args.extend([
        "-i".to_string(),
        "pipe:0".to_string(),
        "-an".to_string(),
        "-c:v".to_string(),
        encoder.to_string(),
    ]);

    let target_bitrate_kbps = request.bitrate_kbps.unwrap_or(50_000);
    let total_pixels = request.width.saturating_mul(request.height);
    let high_throughput = total_pixels >= 2560 * 1440 || request.fps >= 90.0;

    match encoder {
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            let output_pix_fmt = if request.pixel_format == "nv12" {
                "nv12"
            } else {
                "yuv420p"
            };
            args.extend([
                "-allow_sw".to_string(),
                "1".to_string(),
                "-b:v".to_string(),
                format!("{target_bitrate_kbps}k"),
                "-pix_fmt".to_string(),
                output_pix_fmt.to_string(),
            ]);
            if high_throughput {
                args.extend([
                    "-prio_speed".to_string(),
                    "1".to_string(),
                    "-bf".to_string(),
                    "0".to_string(),
                ]);
            }
            if encoder == "hevc_videotoolbox" {
                args.extend(["-tag:v".to_string(), "hvc1".to_string()]);
            }
        }
        "prores_videotoolbox" | "prores_ks" => {
            if encoder == "prores_ks" && request.pixel_format == "rgba" {
                args.extend([
                    "-profile:v".to_string(),
                    "4".to_string(),
                    "-pix_fmt".to_string(),
                    "yuva444p10le".to_string(),
                ]);
            } else {
                args.extend([
                    "-profile:v".to_string(),
                    "2".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv422p10le".to_string(),
                ]);
            }
        }
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => {
            args.extend([
                "-preset".to_string(),
                "p5".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
            if let Some(crf) = request.crf {
                args.extend([
                    "-rc".to_string(),
                    "vbr".to_string(),
                    "-cq".to_string(),
                    crf.to_string(),
                ]);
            } else {
                args.extend(["-b:v".to_string(), format!("{target_bitrate_kbps}k")]);
            }
            if encoder == "hevc_nvenc" {
                args.extend(["-tag:v".to_string(), "hvc1".to_string()]);
            }
        }
        "libx264" | "libx265" => {
            let preset = if encoder == "libx264" {
                if total_pixels >= 3840 * 2160 && request.fps >= 90.0 {
                    "superfast"
                } else if high_throughput {
                    "veryfast"
                } else {
                    "medium"
                }
            } else if high_throughput {
                "superfast"
            } else {
                "medium"
            };
            args.extend([
                "-preset".to_string(),
                preset.to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
            if let Some(crf) = request.crf {
                args.extend(["-crf".to_string(), crf.to_string()]);
            } else {
                args.extend([
                    "-b:v".to_string(),
                    format!("{target_bitrate_kbps}k"),
                    "-maxrate".to_string(),
                    format!("{}k", target_bitrate_kbps.saturating_mul(3) / 2),
                    "-bufsize".to_string(),
                    format!("{}k", target_bitrate_kbps.saturating_mul(2)),
                ]);
            }
            if encoder == "libx265" {
                args.extend(["-tag:v".to_string(), "hvc1".to_string()]);
            }
        }
        "libvpx-vp9" => {
            let output_pix_fmt = if request.pixel_format == "rgba" {
                "yuva420p"
            } else {
                "yuv420p"
            };
            args.extend([
                "-pix_fmt".to_string(),
                output_pix_fmt.to_string(),
                "-deadline".to_string(),
                "good".to_string(),
                "-cpu-used".to_string(),
                "4".to_string(),
                "-row-mt".to_string(),
                "1".to_string(),
            ]);
            if let Some(crf) = request.crf {
                args.extend([
                    "-crf".to_string(),
                    crf.to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                ]);
            } else {
                args.extend(["-b:v".to_string(), format!("{target_bitrate_kbps}k")]);
            }
        }
        "libsvtav1" | "libaom-av1" => {
            args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
            if let Some(crf) = request.crf {
                args.extend(["-crf".to_string(), crf.to_string()]);
            } else {
                args.extend(["-b:v".to_string(), format!("{target_bitrate_kbps}k")]);
            }
        }
        _ => {
            args.extend([
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                "-b:v".to_string(),
                format!("{target_bitrate_kbps}k"),
            ]);
        }
    }

    if request.pixel_format == "nv12" {
        args.extend([
            "-color_range".to_string(),
            "tv".to_string(),
            "-colorspace".to_string(),
            "bt709".to_string(),
            "-color_primaries".to_string(),
            "bt709".to_string(),
            "-color_trc".to_string(),
            "iec61966-2-1".to_string(),
        ]);
    }

    args.push(output_path.to_string_lossy().into_owned());
    Ok(args)
}

#[cfg(any(test, not(any(target_os = "android", target_os = "ios"))))]
fn build_ffmpeg_mux_args(
    video_only_path: &Path,
    wav_path: &Path,
    final_path: &Path,
    container: &str,
    audio_codec: &str,
) -> Result<Vec<String>, String> {
    let codec_name = match (container, audio_codec) {
        ("webm", _) => "libopus",
        (_, "opus") => "libopus",
        (_, "aac") => "aac",
        ("mov", "pcm_s16le") => "pcm_s16le",
        _ => {
            return Err(format!(
                "无效的音频混流组合: container={container}, audio={audio_codec}"
            ))
        }
    };

    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_only_path.to_string_lossy().into_owned(),
        "-i".to_string(),
        wav_path.to_string_lossy().into_owned(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        codec_name.to_string(),
    ];

    if codec_name != "pcm_s16le" {
        args.extend(["-b:a".to_string(), "192k".to_string()]);
    }
    args.push("-shortest".to_string());

    if container == "mp4" || container == "mov" {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }

    args.push(final_path.to_string_lossy().into_owned());
    Ok(args)
}

#[cfg(desktop)]
fn read_capped_stderr<R: Read>(reader: &mut R) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(read) = reader.read(&mut chunk) {
        if read == 0 {
            break;
        }
        if buffer.len() < STDERR_CAPTURE_LIMIT_BYTES {
            let remaining = STDERR_CAPTURE_LIMIT_BYTES - buffer.len();
            buffer.extend_from_slice(&chunk[..read.min(remaining)]);
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

#[cfg(desktop)]
fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> StartExportRequest {
        StartExportRequest {
            mode: "ffmpeg".to_string(),
            container: "mp4".to_string(),
            video_codec: "hevc".to_string(),
            audio_codec: "aac".to_string(),
            pixel_format: "nv12".to_string(),
            width: 3840,
            height: 2160,
            fps: 120.0,
            bitrate_kbps: Some(100_000),
            crf: None,
            hardware_accel: true,
            ffmpeg_path: None,
        }
    }

    #[test]
    fn validates_dimensions_fps_and_frame_bytes() {
        let mut req = sample_request();
        assert!(validate_export_request(&req).is_ok());
        assert_eq!(
            expected_raw_frame_bytes(3840, 2160, "nv12").unwrap(),
            12_441_600
        );

        req.width = 1921;
        assert!(validate_export_request(&req).is_err());

        req.width = 3840;
        req.fps = 300.0;
        assert!(validate_export_request(&req).is_err());

        let mut webcodecs_req = sample_request();
        webcodecs_req.mode = "webcodecs".to_string();
        webcodecs_req.video_codec = "h264".to_string();
        webcodecs_req.pixel_format = "encoded".to_string();
        assert!(validate_export_request(&webcodecs_req).is_ok());

        webcodecs_req.pixel_format = "nv12".to_string();
        assert!(validate_export_request(&webcodecs_req).is_err());
    }

    #[test]
    fn selects_hardware_hevc_and_builds_bt709_args() {
        let hw = vec![
            "h264_videotoolbox".to_string(),
            "hevc_videotoolbox".to_string(),
        ];
        let sw = vec!["libx264".to_string(), "libx265".to_string()];

        let selected = select_ffmpeg_encoder("hevc", true, false, &hw, &sw);
        assert_eq!(selected.as_deref(), Some("hevc_videotoolbox"));

        let req = sample_request();
        let args =
            build_ffmpeg_video_args(&req, "hevc_videotoolbox", Path::new("/tmp/v.mp4")).unwrap();
        assert!(args.windows(2).any(|w| w == ["-video_size", "3840x2160"]));
        assert!(args.windows(2).any(|w| w == ["-framerate", "120"]));
        assert!(args.windows(2).any(|w| w == ["-colorspace", "bt709"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "nv12"]));
        assert!(args.windows(2).any(|w| w == ["-prio_speed", "1"]));
        assert!(args.windows(2).any(|w| w == ["-bf", "0"]));
        assert!(args.windows(2).any(|w| w == ["-tag:v", "hvc1"]));
        assert!(args.windows(2).any(|w| w == ["-b:v", "100000k"]));

        let x264_args =
            build_ffmpeg_video_args(&req, "libx264", Path::new("/tmp/v_x264.mp4")).unwrap();
        assert!(x264_args.windows(2).any(|w| w == ["-preset", "superfast"]));
        assert!(x264_args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
    }

    #[test]
    fn parses_encoder_list_safely() {
        let sample = "\
 V....D libx264              libx264 H.264 / AVC
 V..... hevc_videotoolbox    VideoToolbox H.265 Encoder
 A....D aac                  AAC (Advanced Audio Coding)
";
        let (hw, sw) = parse_encoder_list(sample);
        assert_eq!(hw, vec!["hevc_videotoolbox"]);
        assert_eq!(sw, vec!["libx264", "aac"]);
    }

    #[test]
    fn positional_file_writes_overwrite_reserved_header_bytes() {
        let dir = std::env::temp_dir().join(format!("mss-vexp-test-{}", next_session_id()));
        fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("out.mp4");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&file_path)
            .unwrap();

        file.write_all(b"HEADER0000PAYLOAD").unwrap();
        file.seek(SeekFrom::Start(6)).unwrap();
        file.write_all(b"1234").unwrap();
        file.sync_all().unwrap();

        let contents = fs::read(&file_path).unwrap();
        assert_eq!(&contents, b"HEADER1234PAYLOAD");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn supports_prores_alpha_and_mov_pcm_muxing() {
        let sw = vec!["prores_ks".to_string(), "libvpx-vp9".to_string()];
        let selected = select_ffmpeg_encoder("prores", true, true, &[], &sw);
        assert_eq!(selected.as_deref(), Some("prores_ks"));

        let mut req = sample_request();
        req.container = "mov".to_string();
        req.video_codec = "prores".to_string();
        req.audio_codec = "pcm_s16le".to_string();
        req.pixel_format = "rgba".to_string();

        let video_args =
            build_ffmpeg_video_args(&req, "prores_ks", Path::new("/tmp/v.mov")).unwrap();
        assert!(video_args.windows(2).any(|w| w == ["-profile:v", "4"]));
        assert!(video_args
            .windows(2)
            .any(|w| w == ["-pix_fmt", "yuva444p10le"]));

        let mux_args = build_ffmpeg_mux_args(
            Path::new("/tmp/v.mov"),
            Path::new("/tmp/a.wav"),
            Path::new("/tmp/out.mov"),
            "mov",
            "pcm_s16le",
        )
        .unwrap();
        assert!(mux_args.windows(2).any(|w| w == ["-c:a", "pcm_s16le"]));
        assert!(!mux_args.iter().any(|arg| arg == "-b:a"));
    }

    #[test]
    fn decodes_base64_chunk_payloads() {
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("YQ==").unwrap(), b"a");
        assert!(decode_base64("abc").is_err());
        assert!(decode_base64("SGVs$G8=").is_err());
    }
}
