use rusty_h264_common::YuvFrame;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::audio::{decode_audio_file, mix_timeline_audio, DecodedAudio, ScheduledVoiceEvent};
use super::clock::DeterministicClock;
use super::config::VideoExportConfig;
use super::dispatcher::{SceneDriver, StoryRunner};
use super::encoder::{
    create_video_encoder_for_backend, encode_interleaved_i16_parallel_with_workers,
    encode_yuv_gop_chunk, prefers_hardware_streaming_encoder_for_backend, EncodedAudioPacket,
    EncodedVideoPacket, H264EncoderOptions, Mp4MuxerWriter,
};
use super::error::RendererError;
use super::scene_impl::StorySceneState;
use super::story::{
    EffectTargetData, LayoutMode, PositionData, ProjectRenderInput, SnippetData, VisualEffectData,
};

const MAX_EXPORT_FRAMES: u64 = 3_600_000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExportStage {
    Preparing,
    Rendering,
    EncodingAudio,
    Muxing,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub stage: ExportStage,
    pub rendered_frames: u64,
    pub estimated_total_frames: u64,
    pub elapsed_ms: u64,
    pub duration_ms: f64,
    pub fps_actual: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_frames: u64,
    pub audio_frames: u64,
    pub duration_ms: f64,
    pub bytes_written: u64,
    pub seed_used: u64,
}

struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Renders an entire story timeline in pure Rust (`StoryRunner` + `StorySceneState` + H.264/AAC/MP4)
/// atomically into `output_path`.
pub fn export_story_to_mp4<F>(
    input: &ProjectRenderInput,
    config: &VideoExportConfig,
    output_path: &Path,
    cancel: Option<&AtomicBool>,
    mut on_progress: F,
) -> Result<ExportResult, RendererError>
where
    F: FnMut(ExportProgress),
{
    config.validate()?;
    check_cancel(cancel)?;

    let started = Instant::now();
    on_progress(ExportProgress {
        stage: ExportStage::Preparing,
        rendered_frames: 0,
        estimated_total_frames: 1,
        elapsed_ms: 0,
        duration_ms: 0.0,
        fps_actual: 0.0,
    });

    if let Some(parent) = output_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }

    let seed_used = config.resolve_seed();
    let frame_dt_ms = 1000.0 / config.fps as f64;

    // Pre-decode all referenced voice tracks once to compute accurate ETA and avoid I/O stalls mid-render.
    let predecoded_voices = predecode_story_voices(input, cancel)?;
    let estimated_story_ms = estimate_story_duration_ms(input, &predecoded_voices, frame_dt_ms);
    let estimated_total_frames = (((estimated_story_ms + config.trailing_hold_ms as f64)
        / frame_dt_ms)
        .ceil()
        .max(1.0) as u64)
        + 1;

    let temp_path = make_atomic_temp_path(output_path);
    let mut temp_guard = TempFileGuard::new(temp_path.clone());

    let mut muxer = Mp4MuxerWriter::create(
        &temp_path,
        config.width,
        config.height,
        config.fps,
        config.include_audio,
    )?;
    let h264_opts = H264EncoderOptions {
        quality: config.quality,
        qp: config.resolved_video_qp(),
        bitrate_bps: config.resolved_video_bitrate_bps(),
        gop_size: config.resolved_gop_frames(),
    };

    let total_cores: usize = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let is_uhd_or_above: bool = (config.width as u64) * (config.height as u64) > 1920 * 1080;
    let use_parallel_gop: bool = h264_opts.bitrate_bps == 0
        && (!prefers_hardware_streaming_encoder_for_backend(config.render_backend)
            || (!cfg!(target_os = "android") && is_uhd_or_above && total_cores >= 6))
        && !(cfg!(target_os = "android") && is_uhd_or_above);

    let (video_frames, scheduled_voices, decoded_voices, audio_packets): (
        u64,
        Vec<ScheduledVoiceEvent>,
        HashMap<String, DecodedAudio>,
        Vec<EncodedAudioPacket>,
    ) = if use_parallel_gop {
        run_parallel_gop_pipeline(
            input,
            config,
            seed_used,
            predecoded_voices,
            estimated_total_frames,
            frame_dt_ms,
            h264_opts,
            &mut muxer,
            cancel,
            &started,
            &mut on_progress,
        )?
    } else {
        run_streaming_abr_pipeline(
            input,
            config,
            seed_used,
            predecoded_voices,
            estimated_total_frames,
            frame_dt_ms,
            h264_opts,
            &mut muxer,
            cancel,
            &started,
            &mut on_progress,
        )?
    };
    let _ = (&scheduled_voices, &decoded_voices);

    check_cancel(cancel)?;
    let total_video_duration_ms = (video_frames as f64) * frame_dt_ms;

    let audio_frame_count: u64 = if config.include_audio {
        emit_progress(
            &mut on_progress,
            ExportStage::Muxing,
            video_frames,
            video_frames,
            total_video_duration_ms,
            &started,
        );

        let count: u64 = audio_packets.len() as u64;
        for pkt in &audio_packets {
            muxer.write_audio(pkt.pts_secs, &pkt.adts_frame)?;
        }
        count
    } else {
        emit_progress(
            &mut on_progress,
            ExportStage::Muxing,
            video_frames,
            video_frames,
            total_video_duration_ms,
            &started,
        );
        0
    };

    let stats = muxer.finish()?;
    if output_path.exists() {
        let _ = std::fs::remove_file(output_path);
    }
    std::fs::rename(&temp_path, output_path)?;
    temp_guard.disarm();

    let file_len = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(stats.bytes_written);

    emit_progress(
        &mut on_progress,
        ExportStage::Completed,
        video_frames,
        video_frames,
        total_video_duration_ms,
        &started,
    );

    Ok(ExportResult {
        output_path: output_path.to_path_buf(),
        width: config.width,
        height: config.height,
        fps: config.fps,
        video_frames,
        audio_frames: audio_frame_count,
        duration_ms: total_video_duration_ms,
        bytes_written: file_len,
        seed_used,
    })
}

fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), RendererError> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        Err(RendererError::Cancelled)
    } else {
        Ok(())
    }
}

fn make_atomic_temp_path(output_path: &Path) -> PathBuf {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    let pid = std::process::id();
    parent.join(format!(".{stem}.mss_tmp_{pid}.mp4"))
}

fn emit_progress<F: FnMut(ExportProgress)>(
    cb: &mut F,
    stage: ExportStage,
    rendered_frames: u64,
    estimated_total_frames: u64,
    duration_ms: f64,
    started: &Instant,
) {
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let fps_actual = if elapsed_ms > 0 {
        (rendered_frames as f64 * 1000.0) / elapsed_ms as f64
    } else {
        0.0
    };
    cb(ExportProgress {
        stage,
        rendered_frames,
        estimated_total_frames: estimated_total_frames.max(1),
        elapsed_ms,
        duration_ms,
        fps_actual,
    });
}

fn empty_yuv_frame() -> YuvFrame {
    YuvFrame {
        width: 0,
        height: 0,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    }
}

struct GopJob {
    seq_idx: usize,
    base_frame_index: u64,
    frames: Vec<YuvFrame>,
}

struct GopQueueState {
    pending: VecDeque<GopJob>,
    active_gops: usize,
    closed: bool,
    aborted: bool,
}

struct BoundedGopQueue {
    state: Mutex<GopQueueState>,
    cv: Condvar,
    max_in_flight: usize,
    free_frames: Mutex<Vec<YuvFrame>>,
    max_cached_frames: usize,
}

impl BoundedGopQueue {
    fn new(max_in_flight: usize, gop_size: usize) -> Self {
        Self {
            state: Mutex::new(GopQueueState {
                pending: VecDeque::new(),
                active_gops: 0,
                closed: false,
                aborted: false,
            }),
            cv: Condvar::new(),
            max_in_flight: max_in_flight.max(1),
            free_frames: Mutex::new(Vec::new()),
            max_cached_frames: (max_in_flight + 1).saturating_mul(gop_size.max(1)),
        }
    }

    fn take_frame_buffer(&self) -> YuvFrame {
        let mut pool = self.free_frames.lock().expect("free_frames lock poisoned");
        pool.pop().unwrap_or_else(empty_yuv_frame)
    }

    fn recycle_frames(&self, frames: Vec<YuvFrame>) {
        let mut pool = self.free_frames.lock().expect("free_frames lock poisoned");
        for frame in frames {
            if pool.len() >= self.max_cached_frames {
                break;
            }
            pool.push(frame);
        }
    }

    fn push(&self, job: GopJob, cancel: Option<&AtomicBool>) -> Result<(), RendererError> {
        let mut st = self.state.lock().expect("gop queue lock poisoned");
        while st.active_gops >= self.max_in_flight && !st.aborted {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                st.aborted = true;
                self.cv.notify_all();
                return Err(RendererError::Cancelled);
            }
            let (guard, _) = self
                .cv
                .wait_timeout(st, Duration::from_millis(25))
                .expect("gop queue lock poisoned");
            st = guard;
        }
        if st.aborted {
            return Err(RendererError::VideoEncode(
                "H.264 GOP pipeline aborted".to_string(),
            ));
        }
        st.active_gops += 1;
        st.pending.push_back(job);
        self.cv.notify_all();
        Ok(())
    }

    fn pop(&self) -> Option<GopJob> {
        let mut st = self.state.lock().expect("gop queue lock poisoned");
        loop {
            if st.aborted {
                return None;
            }
            if let Some(job) = st.pending.pop_front() {
                return Some(job);
            }
            if st.closed {
                return None;
            }
            st = self.cv.wait(st).expect("gop queue lock poisoned");
        }
    }

    fn complete_one(&self) {
        let mut st = self.state.lock().expect("gop queue lock poisoned");
        st.active_gops = st.active_gops.saturating_sub(1);
        self.cv.notify_all();
    }

    fn close(&self) {
        let mut st = self.state.lock().expect("gop queue lock poisoned");
        st.closed = true;
        self.cv.notify_all();
    }

    fn abort(&self) {
        let mut st = self.state.lock().expect("gop queue lock poisoned");
        st.aborted = true;
        st.pending.clear();
        self.cv.notify_all();
    }
}

fn drive_pipelined_scene_frames<F, OnFrame>(
    input: &ProjectRenderInput,
    config: &VideoExportConfig,
    seed_used: u64,
    predecoded_voices: HashMap<String, DecodedAudio>,
    estimated_total_frames: u64,
    frame_dt_ms: f64,
    cancel: Option<&AtomicBool>,
    started: &Instant,
    on_progress: &mut F,
    mut on_yuv_frame: OnFrame,
) -> Result<(u64, Vec<ScheduledVoiceEvent>, HashMap<String, DecodedAudio>), RendererError>
where
    F: FnMut(ExportProgress),
    OnFrame: FnMut(u64, &mut YuvFrame) -> Result<(), RendererError>,
{
    let mut scene = StorySceneState::new_with_voices(input, config, seed_used, predecoded_voices)?;
    let mut runner = StoryRunner::new(input.story.clone());
    runner.initialize(&mut scene)?;

    let mut completed_yuv: YuvFrame = empty_yuv_frame();
    let _ = scene.submit_and_drain_previous_yuv_frame_into(&mut completed_yuv)?;
    let mut submitted_frames: u64 = 1;
    let mut retired_frames: u64 = 0;

    let trailing_ms: f64 = config.trailing_hold_ms as f64;
    let mut hold_elapsed_ms: f64 = 0.0;

    while submitted_frames < MAX_EXPORT_FRAMES {
        check_cancel(cancel)?;
        if runner.is_fully_idle() {
            if hold_elapsed_ms + 1e-6 >= trailing_ms {
                break;
            }
            let step_ms: f64 = frame_dt_ms.min(trailing_ms - hold_elapsed_ms);
            let substeps: u32 = DeterministicClock::substeps_for_frame(step_ms);
            let sub_ms: f64 = step_ms / substeps as f64;
            for s in 0..substeps {
                let t: f64 = runner.now_ms() + sub_ms * ((s + 1) as f64);
                scene.tick_scene(sub_ms, t);
            }
            hold_elapsed_ms += step_ms;
        } else {
            runner.step_frame(frame_dt_ms, &mut scene)?;
        }

        if scene.submit_and_drain_previous_yuv_frame_into(&mut completed_yuv)? {
            on_yuv_frame(retired_frames, &mut completed_yuv)?;
            retired_frames += 1;
            emit_progress(
                on_progress,
                ExportStage::Rendering,
                retired_frames,
                estimated_total_frames.max(retired_frames),
                retired_frames as f64 * frame_dt_ms,
                started,
            );
        }
        submitted_frames += 1;
    }

    while scene.finish_pending_yuv_frame_into(&mut completed_yuv)? {
        on_yuv_frame(retired_frames, &mut completed_yuv)?;
        retired_frames += 1;
        emit_progress(
            on_progress,
            ExportStage::Rendering,
            retired_frames,
            estimated_total_frames.max(retired_frames),
            retired_frames as f64 * frame_dt_ms,
            started,
        );
    }

    let (scheduled_voices, decoded_voices) = scene.into_audio_timeline();
    Ok((retired_frames, scheduled_voices, decoded_voices))
}

fn mix_timeline_pcm(
    config: &VideoExportConfig,
    scheduled_voices: &[ScheduledVoiceEvent],
    decoded_voices: &HashMap<String, DecodedAudio>,
    total_video_duration_ms: f64,
) -> Option<Vec<i16>> {
    if !config.include_audio {
        return None;
    }
    let gain_mult: f32 = config.audio_gain_multiplier();
    let scaled_voices: Vec<ScheduledVoiceEvent> = scheduled_voices
        .iter()
        .map(|ev| ScheduledVoiceEvent {
            start_ms: ev.start_ms,
            voice_key: ev.voice_key.clone(),
            gain: ev.gain * gain_mult,
        })
        .collect();
    Some(mix_timeline_audio(
        &scaled_voices,
        decoded_voices,
        total_video_duration_ms,
    ))
}

fn encode_mixed_audio_track(
    config: &VideoExportConfig,
    pcm: Option<&[i16]>,
    total_video_duration_ms: f64,
    video_frames: u64,
    max_workers: usize,
    started: &Instant,
    on_progress: &mut impl FnMut(ExportProgress),
) -> Result<Vec<EncodedAudioPacket>, RendererError> {
    let Some(pcm_samples) = pcm else {
        return Ok(Vec::new());
    };
    emit_progress(
        on_progress,
        ExportStage::EncodingAudio,
        video_frames,
        video_frames,
        total_video_duration_ms,
        started,
    );
    encode_interleaved_i16_parallel_with_workers(
        pcm_samples,
        config.resolved_audio_bitrate_bps(),
        max_workers,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_parallel_gop_pipeline<F>(
    input: &ProjectRenderInput,
    config: &VideoExportConfig,
    seed_used: u64,
    predecoded_voices: HashMap<String, DecodedAudio>,
    estimated_total_frames: u64,
    frame_dt_ms: f64,
    h264_opts: H264EncoderOptions,
    muxer: &mut Mp4MuxerWriter,
    cancel: Option<&AtomicBool>,
    started: &Instant,
    on_progress: &mut F,
) -> Result<
    (
        u64,
        Vec<ScheduledVoiceEvent>,
        HashMap<String, DecodedAudio>,
        Vec<EncodedAudioPacket>,
    ),
    RendererError,
>
where
    F: FnMut(ExportProgress),
{
    let frame_bytes: usize = ((config.width as usize) * (config.height as usize) * 3) / 2;
    let total_cores: usize = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let is_uhd_or_above: bool = (config.width as u64) * (config.height as u64) > 1920 * 1080;
    let gop_size: usize = if cfg!(target_os = "android") && frame_bytes > 0 {
        let max_gop_frames: usize = (128 * 1024 * 1024 / frame_bytes).max(8);
        (h264_opts.gop_size.max(1) as usize).min(max_gop_frames)
    } else if !cfg!(target_os = "android")
        && config.gop_frames.is_none()
        && is_uhd_or_above
        && total_cores >= 6
    {
        (h264_opts.gop_size.max(1) as usize).min(15)
    } else {
        h264_opts.gop_size.max(1) as usize
    };
    let mut h264_opts: H264EncoderOptions = h264_opts;
    h264_opts.gop_size = gop_size as u32;
    let mut worker_count: usize = total_cores.clamp(1, 16);
    // EXPERIMENT: MSS_WORKERS overrides the encoder worker count. Leaving a core free for
    // the render/producer thread can beat using every core, because the producer feeds the
    // whole pipeline and is slowed by CPU contention.
    if let Some(n) = std::env::var("MSS_WORKERS")
        .ok()
        .and_then(|v: String| v.trim().parse::<usize>().ok())
    {
        worker_count = n.clamp(1, 16);
    }
    // Two-engine encode: dedicate one extra worker to the platform hardware encoder.
    // It runs on fixed-function silicon and does not compete with the CPU threads, so
    // its throughput is additive (measured at 4K: VT ~52 fps + software ~96 fps →
    // 1.17-1.20x end-to-end). Opt-in via `VideoExportConfig::hybrid_hardware_encoder`;
    // the MSS_HYBRID_VT env var still forces it on for benchmarks.
    let hybrid_requested: bool = config.hybrid_hardware_encoder
        || std::env::var("MSS_HYBRID_VT")
            .map(|v: String| !matches!(v.trim(), "0" | "false" | "off" | ""))
            .unwrap_or(false);
    let hybrid_vt: bool = cfg!(all(target_os = "macos", feature = "native-hw-accel"))
        && hybrid_requested
        && is_uhd_or_above
        && total_cores >= 6;
    if hybrid_vt {
        worker_count = worker_count.saturating_sub(1).max(1);
    }
    // Share of chunks routed to the hardware encoder: `seq_idx % vt_nth == 0` (1-in-5).
    let vt_nth: usize = std::env::var("MSS_HYBRID_VT_NTH")
        .ok()
        .and_then(|v: String| v.trim().parse::<usize>().ok())
        .unwrap_or(5)
        .clamp(2, 64);
    let max_in_flight: usize = if cfg!(target_os = "android") && frame_bytes > 0 {
        let gop_bytes: usize = gop_size.saturating_mul(frame_bytes).max(1);
        let max_gops: usize = (256 * 1024 * 1024 / gop_bytes).max(1);
        worker_count = worker_count.min(max_gops.max(2));
        max_gops
    } else {
        worker_count + 1
    };
    let queue: BoundedGopQueue = BoundedGopQueue::new(max_in_flight, gop_size);
    let (res_tx, res_rx) = mpsc::channel::<(usize, Result<Vec<EncodedVideoPacket>, RendererError>)>();

    let width: u32 = config.width;
    let height: u32 = config.height;
    let fps: u32 = config.fps;

    let mut audio_packets: Vec<EncodedAudioPacket> = Vec::new();
    let mut video_frames_out: u64 = 0;
    let mut scheduled_out: Vec<ScheduledVoiceEvent> = Vec::new();
    let mut decoded_out: HashMap<String, DecodedAudio> = HashMap::new();

    // Optional pipeline statistics (MSS_PIPELINE_STATS): declared outside the scope so the
    // spawned GOP workers and the mux thread can borrow them for the scope's lifetime.
    let stats_on: bool = std::env::var("MSS_PIPELINE_STATS").is_ok();
    let chunk_stats: Mutex<Vec<(usize, f64)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| -> Result<(), RendererError> {
        let mut worker_handles = Vec::with_capacity(worker_count);
        // Deterministic hybrid routing: chunk `seq_idx % 3 == 0` always goes to the hardware
        // encoder, so re-exporting the same project produces the same file. Software workers
        // forward those jobs to the single VT consumer instead of encoding them themselves.
        let (vt_tx, vt_rx) = mpsc::channel::<GopJob>();
        #[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
        if hybrid_vt {
            let queue_ref: &BoundedGopQueue = &queue;
            let tx: mpsc::Sender<(usize, Result<Vec<EncodedVideoPacket>, RendererError>)> =
                res_tx.clone();
            let rx: mpsc::Receiver<GopJob> = vt_rx;
            worker_handles.push(scope.spawn(move || {
                while let Ok(job) = rx.recv() {
                    let seq_idx: usize = job.seq_idx;
                    let enc_res: Result<Vec<EncodedVideoPacket>, RendererError> =
                        crate::renderer::encoder::video_vt::encode_yuv_gop_chunk_vt(
                            &job.frames,
                            job.base_frame_index,
                            width,
                            height,
                            fps,
                            h264_opts,
                        );
                    queue_ref.recycle_frames(job.frames);
                    queue_ref.complete_one();
                    if enc_res.is_err() {
                        queue_ref.abort();
                    }
                    let _ = tx.send((seq_idx, enc_res));
                }
            }));
        }
        #[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
        let vt_enabled: bool = hybrid_vt;
        #[cfg(not(all(target_os = "macos", feature = "native-hw-accel")))]
        let vt_enabled: bool = {
            let _unused: &mpsc::Receiver<GopJob> = &vt_rx;
            false
        };
        for _ in 0..worker_count {
            let queue_ref: &BoundedGopQueue = &queue;
            let tx: mpsc::Sender<(usize, Result<Vec<EncodedVideoPacket>, RendererError>)> =
                res_tx.clone();
            let vt_tx_ref: mpsc::Sender<GopJob> = vt_tx.clone();
            let chunk_stats_ref: &Mutex<Vec<(usize, f64)>> = &chunk_stats;
            worker_handles.push(scope.spawn(move || {
                while let Some(job) = queue_ref.pop() {
                    if vt_enabled && job.seq_idx % vt_nth == 0 {
                        if vt_tx_ref.send(job).is_err() {
                            queue_ref.abort();
                        }
                        continue;
                    }
                    let seq_idx: usize = job.seq_idx;
                    let started_chunk: Instant = Instant::now();
                    let enc_res: Result<Vec<EncodedVideoPacket>, RendererError> =
                        encode_yuv_gop_chunk(
                            &job.frames,
                            job.base_frame_index,
                            width,
                            height,
                            fps,
                            h264_opts,
                        );
                    if stats_on {
                        let secs: f64 = started_chunk.elapsed().as_secs_f64();
                        if let Ok(mut v) = chunk_stats_ref.lock() {
                            v.push((seq_idx, secs));
                        }
                    }
                    queue_ref.recycle_frames(job.frames);
                    queue_ref.complete_one();
                    if enc_res.is_err() {
                        queue_ref.abort();
                    }
                    let _ = tx.send((seq_idx, enc_res));
                }
            }));
        }
        drop(vt_tx);
        drop(res_tx);

        let queue_for_mux: &BoundedGopQueue = &queue;
        let chunk_stats_for_mux: &Mutex<Vec<(usize, f64)>> = &chunk_stats;
        let mux_handle = scope.spawn(move || -> Result<(), RendererError> {
            let mut next_seq: usize = 0;
            let mut reordered: BTreeMap<usize, Vec<EncodedVideoPacket>> = BTreeMap::new();
            while let Ok((seq_idx, enc_res)) = res_rx.recv() {
                let packets: Vec<EncodedVideoPacket> = match enc_res {
                    Ok(pkts) => pkts,
                    Err(err) => {
                        queue_for_mux.abort();
                        return Err(err);
                    }
                };
                reordered.insert(seq_idx, packets);
                while let Some(ready_pkts) = reordered.remove(&next_seq) {
                    for pkt in ready_pkts {
                        if let Err(err) =
                            muxer.write_video(pkt.pts_secs, &pkt.annex_b, pkt.is_keyframe)
                        {
                            queue_for_mux.abort();
                            return Err(err);
                        }
                    }
                    next_seq += 1;
                }
            }
            if stats_on {
                if let Ok(v) = chunk_stats_for_mux.lock() {
                    let mut sorted: Vec<f64> = v.iter().map(|(_, s): &(usize, f64)| *s).collect();
                    sorted.sort_by(|a: &f64, b: &f64| {
                        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let sum: f64 = sorted.iter().sum();
                    let n: usize = sorted.len();
                    let mean: f64 = if n > 0 { sum / n as f64 } else { 0.0 };
                    let p50: f64 = sorted.get(n / 2).copied().unwrap_or(0.0);
                    let max: f64 = sorted.last().copied().unwrap_or(0.0);
                    let total: f64 = started.elapsed().as_secs_f64();
                    eprintln!(
                        "[PIPELINE STATS] chunks={n} sum_encode={sum:.2}s wall={total:.2}s mean_concurrency={:.2} mean={mean:.3}s p50={p50:.3}s max={max:.3}s workers={worker_count}",
                        sum / total.max(1e-9)
                    );
                }
            }
            Ok(())
        });

        let mut gop_frames: Vec<YuvFrame> = Vec::with_capacity(gop_size);
        let mut gop_base_frame: u64 = 0;
        let mut next_seq_idx: usize = 0;

        let render_res: Result<(u64, Vec<ScheduledVoiceEvent>, HashMap<String, DecodedAudio>), RendererError> =
            drive_pipelined_scene_frames(
                input,
                config,
                seed_used,
                predecoded_voices,
                estimated_total_frames,
                frame_dt_ms,
                cancel,
                started,
                on_progress,
                |frame_idx, yuv_buf| {
                    let mut owned_slot: YuvFrame = queue.take_frame_buffer();
                    std::mem::swap(&mut owned_slot, yuv_buf);
                    if gop_frames.is_empty() {
                        gop_base_frame = frame_idx;
                    }
                    gop_frames.push(owned_slot);
                    if gop_frames.len() >= gop_size {
                        let batch: Vec<YuvFrame> =
                            std::mem::replace(&mut gop_frames, Vec::with_capacity(gop_size));
                        let seq: usize = next_seq_idx;
                        next_seq_idx += 1;
                        queue.push(
                            GopJob {
                                seq_idx: seq,
                                base_frame_index: gop_base_frame,
                                frames: batch,
                            },
                            cancel,
                        )?;
                    }
                    Ok(())
                },
            );

        let (video_frames, scheduled_voices, decoded_voices) = match render_res {
            Ok(vals) => vals,
            Err(err) => {
                queue.abort();
                for h in worker_handles {
                    let _ = h.join();
                }
                let _ = mux_handle.join();
                return Err(err);
            }
        };

        if !gop_frames.is_empty() {
            let seq: usize = next_seq_idx;
            if let Err(err) = queue.push(
                GopJob {
                    seq_idx: seq,
                    base_frame_index: gop_base_frame,
                    frames: gop_frames,
                },
                cancel,
            ) {
                queue.abort();
                for h in worker_handles {
                    let _ = h.join();
                }
                let _ = mux_handle.join();
                return Err(err);
            }
        }
        queue.close();

        // Mix timeline PCM and encode AAC concurrently while trailing H.264 GOPs finish.
        let total_video_duration_ms: f64 = (video_frames as f64) * frame_dt_ms;
        let mixed_pcm: Option<Vec<i16>> = mix_timeline_pcm(
            config,
            &scheduled_voices,
            &decoded_voices,
            total_video_duration_ms,
        );
        let audio_res: Result<Vec<EncodedAudioPacket>, RendererError> = encode_mixed_audio_track(
            config,
            mixed_pcm.as_deref(),
            total_video_duration_ms,
            video_frames,
            total_cores.clamp(1, 8),
            started,
            on_progress,
        );

        for h in worker_handles {
            let _ = h.join();
        }
        mux_handle.join().unwrap_or_else(|_| {
            Err(RendererError::VideoEncode(
                "Video mux thread panicked".to_string(),
            ))
        })?;

        audio_packets = audio_res?;
        video_frames_out = video_frames;
        scheduled_out = scheduled_voices;
        decoded_out = decoded_voices;
        Ok(())
    })?;

    Ok((video_frames_out, scheduled_out, decoded_out, audio_packets))
}

#[allow(clippy::too_many_arguments)]
fn run_streaming_abr_pipeline<F>(
    input: &ProjectRenderInput,
    config: &VideoExportConfig,
    seed_used: u64,
    predecoded_voices: HashMap<String, DecodedAudio>,
    estimated_total_frames: u64,
    frame_dt_ms: f64,
    h264_opts: H264EncoderOptions,
    muxer: &mut Mp4MuxerWriter,
    cancel: Option<&AtomicBool>,
    started: &Instant,
    on_progress: &mut F,
) -> Result<
    (
        u64,
        Vec<ScheduledVoiceEvent>,
        HashMap<String, DecodedAudio>,
        Vec<EncodedAudioPacket>,
    ),
    RendererError,
>
where
    F: FnMut(ExportProgress),
{
    let mut video_encoder: Box<dyn super::encoder::VideoFrameEncoder> =
        create_video_encoder_for_backend(
            config.width,
            config.height,
            config.fps,
            h264_opts,
            config.render_backend,
        )?;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<(u64, YuvFrame)>(4);
    let free_frames: Mutex<Vec<YuvFrame>> = Mutex::new(Vec::new());
    let fps: u32 = config.fps;
    let total_cores: usize = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);

    let mut video_frames_out: u64 = 0;
    let mut scheduled_out: Vec<ScheduledVoiceEvent> = Vec::new();
    let mut decoded_out: HashMap<String, DecodedAudio> = HashMap::new();
    let mut audio_packets: Vec<EncodedAudioPacket> = Vec::new();

    std::thread::scope(|scope| -> Result<(), RendererError> {
        let free_ref: &Mutex<Vec<YuvFrame>> = &free_frames;
        let enc_handle = scope.spawn(move || -> Result<(), RendererError> {
            let mut muxed_count: u64 = 0;
            while let Ok((frame_idx, yuv)) = frame_rx.recv() {
                let pts_secs: f64 = (frame_idx as f64) / (fps as f64);
                let pkts: Vec<EncodedVideoPacket> = video_encoder.encode_yuv(&yuv, pts_secs)?;
                {
                    let mut pool = free_ref.lock().expect("abr free_frames poisoned");
                    if pool.len() < 4 {
                        pool.push(yuv);
                    }
                }
                for pkt in pkts {
                    let pkt_pts: f64 = if pkt.pts_secs > 0.0 || muxed_count == 0 {
                        pkt.pts_secs
                    } else {
                        (muxed_count as f64) / (fps as f64)
                    };
                    muxer.write_video(pkt_pts, &pkt.annex_b, pkt.is_keyframe)?;
                    muxed_count += 1;
                }
            }
            for pkt in video_encoder.finish()? {
                let pkt_pts: f64 = if pkt.pts_secs > 0.0 || muxed_count == 0 {
                    pkt.pts_secs
                } else {
                    (muxed_count as f64) / (fps as f64)
                };
                muxer.write_video(pkt_pts, &pkt.annex_b, pkt.is_keyframe)?;
                muxed_count += 1;
            }
            Ok(())
        });

        let render_res: Result<(u64, Vec<ScheduledVoiceEvent>, HashMap<String, DecodedAudio>), RendererError> =
            drive_pipelined_scene_frames(
                input,
                config,
                seed_used,
                predecoded_voices,
                estimated_total_frames,
                frame_dt_ms,
                cancel,
                started,
                on_progress,
                |frame_idx, yuv_buf| {
                    let mut owned: YuvFrame = {
                        let mut pool = free_frames.lock().expect("abr free_frames poisoned");
                        pool.pop().unwrap_or_else(empty_yuv_frame)
                    };
                    std::mem::swap(&mut owned, yuv_buf);
                    frame_tx.send((frame_idx, owned)).map_err(|_| {
                        RendererError::VideoEncode("ABR encoder thread terminated early".to_string())
                    })
                },
            );
        drop(frame_tx);

        let (video_frames, scheduled_voices, decoded_voices) = match render_res {
            Ok(vals) => vals,
            Err(err) => {
                let _ = enc_handle.join();
                return Err(err);
            }
        };

        let total_video_duration_ms: f64 = (video_frames as f64) * frame_dt_ms;
        let audio_workers: usize = total_cores.clamp(1, 16);
        let audio_bitrate_bps: u32 = config.resolved_audio_bitrate_bps();

        let audio_handle = if config.include_audio {
            Some(scope.spawn(
                move || -> Result<
                    (
                        Vec<EncodedAudioPacket>,
                        Vec<ScheduledVoiceEvent>,
                        HashMap<String, DecodedAudio>,
                    ),
                    RendererError,
                > {
                    let mixed_pcm: Option<Vec<i16>> = mix_timeline_pcm(
                        config,
                        &scheduled_voices,
                        &decoded_voices,
                        total_video_duration_ms,
                    );
                    let pkts: Vec<EncodedAudioPacket> = match mixed_pcm {
                        Some(ref pcm_samples) => encode_interleaved_i16_parallel_with_workers(
                            pcm_samples,
                            audio_bitrate_bps,
                            audio_workers,
                        )?,
                        None => Vec::new(),
                    };
                    Ok((pkts, scheduled_voices, decoded_voices))
                },
            ))
        } else {
            scheduled_out = scheduled_voices;
            decoded_out = decoded_voices;
            None
        };

        enc_handle.join().unwrap_or_else(|_| {
            Err(RendererError::VideoEncode(
                "ABR video encoder thread panicked".to_string(),
            ))
        })?;

        if let Some(handle) = audio_handle {
            emit_progress(
                on_progress,
                ExportStage::EncodingAudio,
                video_frames,
                video_frames,
                total_video_duration_ms,
                started,
            );
            let (pkts, sched, dec): (
                Vec<EncodedAudioPacket>,
                Vec<ScheduledVoiceEvent>,
                HashMap<String, DecodedAudio>,
            ) = handle.join().unwrap_or_else(|_| {
                Err(RendererError::AudioEncode(
                    "Audio encode worker thread panicked".to_string(),
                ))
            })?;
            audio_packets = pkts;
            scheduled_out = sched;
            decoded_out = dec;
        }
        video_frames_out = video_frames;
        Ok(())
    })?;

    Ok((video_frames_out, scheduled_out, decoded_out, audio_packets))
}

fn collect_voice_keys(
    snippets: &[SnippetData],
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
) {
    for snippet in snippets {
        match snippet {
            SnippetData::Talk { data, .. } => {
                if let (Some(_), Some(voice_key)) = (&data.model, &data.voice) {
                    if seen.insert(voice_key.clone()) {
                        out.push(voice_key.clone());
                    }
                }
            }
            SnippetData::Parallel { snippets: inner, .. } => {
                collect_voice_keys(inner, seen, out);
            }
            _ => {}
        }
    }
}

fn predecode_story_voices(
    input: &ProjectRenderInput,
    cancel: Option<&AtomicBool>,
) -> Result<HashMap<String, DecodedAudio>, RendererError> {
    let mut keys: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    collect_voice_keys(&input.story.snippets, &mut seen, &mut keys);

    if keys.len() <= 1 {
        let mut map: HashMap<String, DecodedAudio> = HashMap::with_capacity(keys.len());
        for key in keys {
            check_cancel(cancel)?;
            let path: PathBuf = input.resolve_voice_path(&key)?;
            let decoded: DecodedAudio = decode_audio_file(&path)?;
            map.insert(key, decoded);
        }
        return Ok(map);
    }

    let worker_count: usize = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(1)
        .clamp(1, 8)
        .min(keys.len());
    let next_idx: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let results: Mutex<HashMap<String, DecodedAudio>> =
        Mutex::new(HashMap::with_capacity(keys.len()));

    let worker_res: Result<(), RendererError> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let keys_ref: &[String] = &keys;
            let idx_ref: &std::sync::atomic::AtomicUsize = &next_idx;
            let results_ref: &Mutex<HashMap<String, DecodedAudio>> = &results;
            handles.push(scope.spawn(move || -> Result<(), RendererError> {
                loop {
                    check_cancel(cancel)?;
                    let idx: usize = idx_ref.fetch_add(1, Ordering::Relaxed);
                    let Some(key) = keys_ref.get(idx) else {
                        break;
                    };
                    let path: PathBuf = input.resolve_voice_path(key)?;
                    let decoded: DecodedAudio = decode_audio_file(&path)?;
                    results_ref
                        .lock()
                        .expect("voice map lock poisoned")
                        .insert(key.clone(), decoded);
                }
                Ok(())
            }));
        }
        let mut first_err: Option<RendererError> = None;
        for h in handles {
            match h.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) if first_err.is_none() => first_err = Some(e),
                Ok(Err(_)) => {}
                Err(_) if first_err.is_none() => {
                    first_err = Some(RendererError::AudioDecode(
                        "Voice decode worker panicked".to_string(),
                    ));
                }
                Err(_) => {}
            }
        }
        if let Some(err) = first_err {
            Err(err)
        } else {
            Ok(())
        }
    });
    worker_res?;
    Ok(results.into_inner().expect("voice map lock poisoned"))
}

fn estimate_story_duration_ms(
    input: &ProjectRenderInput,
    voices: &HashMap<String, DecodedAudio>,
    frame_dt_ms: f64,
) -> f64 {
    struct DryEstimateScene<'a> {
        voices: &'a HashMap<String, DecodedAudio>,
        models: HashMap<String, f32>,
        motion_end_ms: HashMap<String, f64>,
        talk_shown: bool,
        fade_alpha: f32,
        effects: HashSet<String>,
        now_ms: f64,
    }

    impl<'a> SceneDriver for DryEstimateScene<'a> {
        fn set_layout_mode(&mut self, _mode: LayoutMode) {}
        fn set_background(&mut self, _bg_key: &str) -> Result<(), RendererError> {
            Ok(())
        }
        fn attach_or_show_model(
            &mut self,
            model_key: &str,
            _position: &PositionData,
            _hologram: bool,
            _motion: Option<&str>,
            _facial: Option<&str>,
        ) -> Result<(), RendererError> {
            self.models.entry(model_key.to_string()).or_insert(0.0);
            Ok(())
        }
        fn model_alpha(&self, model_key: &str) -> Option<f32> {
            self.models.get(model_key).copied()
        }
        fn set_model_alpha(&mut self, model_key: &str, alpha: f32) {
            self.models.insert(model_key.to_string(), alpha);
        }
        fn detach_model(&mut self, model_key: &str) {
            self.models.remove(model_key);
        }
        fn set_model_position(
            &mut self,
            _model_key: &str,
            _from: &PositionData,
            _to: &PositionData,
            _progress: f32,
        ) -> Result<(), RendererError> {
            Ok(())
        }
        fn start_model_motion(
            &mut self,
            model_key: &str,
            motion: Option<&str>,
            facial: Option<&str>,
            _ignore_eye_params: bool,
        ) -> Result<(), RendererError> {
            if motion.is_some() || facial.is_some() {
                self.motion_end_ms
                    .insert(model_key.to_string(), self.now_ms + 2_000.0);
            }
            Ok(())
        }
        fn is_model_motion_finished(&self, model_key: &str) -> bool {
            self.motion_end_ms
                .get(model_key)
                .map(|&end| self.now_ms >= end)
                .unwrap_or(true)
        }
        fn close_model_eyes(&mut self, _model_key: &str) {}
        fn set_model_parameter(&mut self, _model_key: &str, _param_id: &str, _value: f32) {}
        fn is_talk_shown(&self) -> bool {
            self.talk_shown
        }
        fn prepare_dialogue(&mut self, _speaker: &str, _content: &str) {}
        fn set_dialogue_visibility(&mut self, visible: bool, _alpha: f32) {
            self.talk_shown = visible;
        }
        fn set_dialogue_text(&mut self, _partial_text: &str) {}
        fn start_voice(
            &mut self,
            _model_key: Option<&str>,
            voice_key: &str,
            _now_ms: f64,
        ) -> Result<Option<f64>, RendererError> {
            Ok(self.voices.get(voice_key).map(DecodedAudio::duration_ms))
        }
        fn prepare_telop(&mut self, _content: &str) {}
        fn set_telop_state(&mut self, _visible: bool, _alpha: f32, _x_offset: f32) {}
        fn current_fade_alpha(&self) -> f32 {
            self.fade_alpha
        }
        fn set_fade_state(&mut self, _color: Option<[f32; 4]>, _visible: bool, alpha: f32) {
            self.fade_alpha = alpha;
        }
        fn has_effect(&self, effect_id: &str) -> bool {
            self.effects.contains(effect_id)
        }
        fn apply_effect(
            &mut self,
            effect_id: &str,
            _target: &EffectTargetData,
            _effect: &VisualEffectData,
        ) -> Result<(), RendererError> {
            self.effects.insert(effect_id.to_string());
            Ok(())
        }
        fn set_effect_progress(&mut self, _effect_id: &str, _progress: f32) {}
        fn remove_effect(&mut self, effect_id: &str) {
            self.effects.remove(effect_id);
        }
        fn tick_scene(&mut self, _delta_ms: f64, now_ms: f64) {
            self.now_ms = now_ms;
        }
    }

    let mut dry = DryEstimateScene {
        voices,
        models: HashMap::new(),
        motion_end_ms: HashMap::new(),
        talk_shown: false,
        fade_alpha: 0.0,
        effects: HashSet::new(),
        now_ms: 0.0,
    };
    let mut runner = StoryRunner::new(input.story.clone());
    if runner.initialize(&mut dry).is_err() {
        return frame_dt_ms;
    }
    let mut steps = 0_u64;
    while !runner.is_fully_idle() && steps < MAX_EXPORT_FRAMES {
        if runner.step_frame(frame_dt_ms, &mut dry).is_err() {
            break;
        }
        steps += 1;
    }
    runner.now_ms().max(frame_dt_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::config::{SeedMode, VideoQualityPreset};
    use crate::renderer::story::*;

    fn copy_dir_all(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap().flatten() {
            let p = entry.path();
            let d = dst.join(entry.file_name());
            if p.is_dir() {
                copy_dir_all(&p, &d);
            } else {
                std::fs::copy(&p, &d).unwrap();
            }
        }
    }

    fn write_test_wav(path: &Path, sample_rate: u32, duration_secs: f32) {
        use std::io::Write;
        let frames = (sample_rate as f32 * duration_secs) as u32;
        let data_bytes = frames * 4; // stereo i16
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_bytes).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&2u16.to_le_bytes()).unwrap(); // Stereo
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&(sample_rate * 4).to_le_bytes()).unwrap();
        f.write_all(&4u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_bytes.to_le_bytes()).unwrap();
        for i in 0..frames {
            let t = i as f32 / sample_rate as f32;
            let env = (t * 8.0 * std::f32::consts::PI).sin().abs();
            let s = (env * (t * 440.0 * std::f32::consts::TAU).sin() * 9000.0) as i16;
            f.write_all(&s.to_le_bytes()).unwrap();
            f.write_all(&s.to_le_bytes()).unwrap();
        }
    }

    /// Benchmark-only quality preset selector.
    ///
    /// `BENCH_QUALITY=speed|fast|balanced|high|quality|nearlossless|archive`
    /// (default `balanced`) so the #[ignore]d 4K benchmarks can be re-run at any
    /// shipping quality level without editing the source.
    fn bench_quality_preset() -> VideoQualityPreset {
        let raw: Option<String> = std::env::var("BENCH_QUALITY").ok();
        let normalized: Option<String> = raw
            .as_deref()
            .map(str::trim)
            .filter(|v: &&str| !v.is_empty())
            .map(str::to_ascii_lowercase);
        match normalized.as_deref() {
            None => VideoQualityPreset::Balanced,
            Some(v) => match v {
                "speed" => VideoQualityPreset::Speed,
                "fast" => VideoQualityPreset::Fast,
                "balanced" => VideoQualityPreset::Balanced,
                "high" => VideoQualityPreset::High,
                "quality" => VideoQualityPreset::Quality,
                "nearlossless" | "near-lossless" => VideoQualityPreset::NearLossless,
                "archive" => VideoQualityPreset::Archive,
                other => panic!(
                    "BENCH_QUALITY must be speed|fast|balanced|high|quality|nearlossless|archive, got {other:?}"
                ),
            },
        }
    }
    /// Per-process temp directory for a benchmark.
    ///
    /// A fixed name made two concurrently running `#[ignore]` benchmarks share one
    /// working directory, so whichever finished first deleted the other's files
    /// (`Io(NotFound)` panics mid-export). Suffixing the PID keeps them isolated.
    fn bench_tmp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}", std::process::id()))
    }


    #[test]
    fn export_story_to_mp4_creates_playable_faststart_mp4_with_h264_and_aac() {
        let tmp = std::env::temp_dir().join("mss_full_export_e2e");
        let _ = std::fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        let project_dir = tmp.join("project");
        let models_dir = data_dir.join("models/ichika");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(project_dir.join("backgrounds")).unwrap();
        std::fs::create_dir_all(project_dir.join("voices")).unwrap();

        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        copy_dir_all(
            &repo_root.join("tests/models/01ichika_normal_3.0_f_t04"),
            &models_dir,
        );

        let mut bg = image::RgbaImage::new(64, 64);
        for px in bg.pixels_mut() {
            *px = image::Rgba([24, 52, 88, 255]);
        }
        bg.save(project_dir.join("backgrounds/bg.png")).unwrap();

        let voice_wav_path = project_dir.join("voices/clip.wav");
        write_test_wav(&voice_wav_path, 48_000, 0.55);
        let voice_rel = Some("voices/clip.wav".to_string());

        let mut models = HashMap::new();
        models.insert(
            "ichika".to_string(),
            ModelAsset {
                name: Some("星乃一歌".to_string()),
                model_id: "ichika".to_string(),
                normal_scale: 2.1,
                small_scale: 1.6,
                anchor: 0.5,
            },
        );
        let mut backgrounds = HashMap::new();
        backgrounds.insert(
            "bg_main".to_string(),
            BackgroundAsset {
                name: Some("BG".to_string()),
                path: "backgrounds/bg.png".to_string(),
            },
        );
        let mut voices = HashMap::new();
        let has_voice = voice_rel.is_some();
        if let Some(vr) = voice_rel {
            voices.insert(
                "v01".to_string(),
                VoiceAsset {
                    name: Some("v01".to_string()),
                    path: vr,
                },
            );
        }
        let mut registry_models = HashMap::new();
        registry_models.insert(
            "ichika".to_string(),
            ModelRegistryEntry {
                name: Some("Ichika".to_string()),
                entry: "01ichika_normal_3.0_f_t04.model3.json".to_string(),
                motions: Vec::new(),
                facials: Vec::new(),
            },
        );

        let input = ProjectRenderInput {
            data_dir,
            project_dir,
            story: StoryData {
                version: 1,
                snippets: vec![
                    SnippetData::ChangeBackgroundImage {
                        id: None,
                        delay: 0.0,
                        data: ChangeBackgroundImageData {
                            background: "bg_main".to_string(),
                        },
                    },
                    SnippetData::LayoutAppear {
                        id: None,
                        delay: 0.0,
                        data: LayoutAppearData {
                            model: "ichika".to_string(),
                            position: PositionData {
                                side: Side::Center,
                                offset: 0.0,
                            },
                            hologram: false,
                            motion: Some("w-normal-nod01".to_string()),
                            facial: Some("face_smile_01".to_string()),
                        },
                    },
                    SnippetData::Talk {
                        id: None,
                        delay: 0.0,
                        data: TalkData {
                            speaker: "星乃一歌".to_string(),
                            content: "纯 Rust 视频导出端到端测试！".to_string(),
                            model: Some("ichika".to_string()),
                            voice: if has_voice {
                                Some("v01".to_string())
                            } else {
                                None
                            },
                        },
                    },
                    SnippetData::ScreenFadeOut {
                        id: None,
                        delay: 0.0,
                        data: ScreenFadeOutData {
                            color: "#000000".to_string(),
                            duration: 0.15,
                        },
                    },
                ],
            },
            assets: ProjectAssets {
                models,
                backgrounds,
                voices,
            },
            model_registry: ModelRegistry {
                version: 1,
                models: registry_models,
            },
            font: PlaybackFontConfig::Default,
        };

        let out_mp4 = tmp.join("rendered_story.mp4");
        let cfg = VideoExportConfig {
            width: 640,
            height: 360,
            fps: 30,
            quality: VideoQualityPreset::Fast,
            seed_mode: SeedMode::Fixed { seed: 777 },
            trailing_hold_ms: 100,
            ..Default::default()
        };

        let mut stages = Vec::new();
        let res = export_story_to_mp4(&input, &cfg, &out_mp4, None, |p| {
            stages.push(p.stage);
        })
        .expect("export mp4");

        assert!(out_mp4.is_file());
        assert_eq!(res.width, 640);
        assert_eq!(res.height, 360);
        assert_eq!(res.fps, 30);
        assert!(
            res.video_frames >= 20,
            "expected >= 20 frames, got {}",
            res.video_frames
        );
        assert!(res.audio_frames > 0);
        assert!(res.bytes_written > 10_000);
        assert!(stages.contains(&ExportStage::Preparing));
        assert!(stages.contains(&ExportStage::Rendering));
        assert!(stages.contains(&ExportStage::EncodingAudio));
        assert!(stages.contains(&ExportStage::Muxing));
        assert_eq!(stages.last().copied(), Some(ExportStage::Completed));

        // Verify ISO BMFF boxes cleanly (`ftyp` then `moov` before `mdat` for fast-start).
        let raw_mp4 = std::fs::read(&out_mp4).unwrap();
        assert!(raw_mp4.len() > 24);
        assert_eq!(&raw_mp4[4..8], b"ftyp");
        let ftyp_size = u32::from_be_bytes(raw_mp4[0..4].try_into().unwrap()) as usize;
        assert_eq!(&raw_mp4[ftyp_size + 4..ftyp_size + 8], b"moov");

        // Verify cancellation leaves zero partial files.
        let cancel_flag = AtomicBool::new(true);
        let cancelled_mp4 = tmp.join("cancelled.mp4");
        let err = export_story_to_mp4(&input, &cfg, &cancelled_mp4, Some(&cancel_flag), |_| {})
            .unwrap_err();
        assert!(matches!(err, RendererError::Cancelled));
        assert!(!cancelled_mp4.exists());

        // Optional external ffprobe sanity verification when available in environment.
        let ffprobe = std::process::Command::new("/opt/homebrew/bin/ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,width,height,sample_rate,channels",
                "-of",
                "json",
            ])
            .arg(&out_mp4)
            .output();
        if let Ok(out) = ffprobe {
            assert!(
                out.status.success(),
                "ffprobe failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(stdout.contains("\"h264\""), "missing h264 stream: {stdout}");
            assert!(stdout.contains("\"aac\""), "missing aac stream: {stdout}");
            assert!(
                stdout.contains("640") && stdout.contains("360"),
                "unexpected dims: {stdout}"
            );
            assert!(
                stdout.contains("48000"),
                "unexpected audio sample_rate: {stdout}"
            );
        }

        // Verify custom FPS (24), custom ABR bitrate, all-keyframe GOP, custom backdrop color, and muted video-only MP4.
        let custom_mp4 = tmp.join("custom_video_only.mp4");
        let custom_cfg = VideoExportConfig {
            width: 640,
            height: 360,
            fps: 24,
            quality: VideoQualityPreset::Fast,
            hybrid_hardware_encoder: false,
            seed_mode: SeedMode::Fixed { seed: 99 },
            trailing_hold_ms: 0,
            video_qp: Some(21),
            video_bitrate_kbps: Some(450),
            gop_frames: Some(4),
            include_audio: false,
            audio_bitrate_kbps: None,
            audio_volume_percent: 0,
            background_color: "#204060".to_string(),
            render_backend: crate::renderer::config::RenderBackend::Auto,
        };
        let custom_res = export_story_to_mp4(&input, &custom_cfg, &custom_mp4, None, |_| {})
            .expect("video only");
        assert!(custom_mp4.is_file());
        assert_eq!(custom_res.fps, 24);
        assert_eq!(custom_res.audio_frames, 0);
        assert!(custom_res.video_frames >= 15);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore = "4K performance benchmark (run with --release -- --ignored --nocapture)"]
    fn bench_4k_export_fps() {
        let tmp = bench_tmp_dir("my_sekai_bench_4k_export");
        let _ = std::fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        let project_dir = tmp.join("project");
        let models_dir = data_dir.join("models/ichika");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(project_dir.join("backgrounds")).unwrap();

        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        copy_dir_all(
            &repo_root.join("tests/models/01ichika_normal_3.0_f_t04"),
            &models_dir,
        );

        let mut bg = image::RgbaImage::new(1920, 1080);
        for px in bg.pixels_mut() {
            *px = image::Rgba([24, 52, 88, 255]);
        }
        bg.save(project_dir.join("backgrounds/bg.png")).unwrap();

        let mut models = HashMap::new();
        models.insert(
            "ichika".to_string(),
            ModelAsset {
                name: Some("星乃一歌".to_string()),
                model_id: "ichika".to_string(),
                normal_scale: 2.1,
                small_scale: 1.6,
                anchor: 0.5,
            },
        );
        let mut backgrounds = HashMap::new();
        backgrounds.insert(
            "bg_main".to_string(),
            BackgroundAsset {
                name: Some("BG".to_string()),
                path: "backgrounds/bg.png".to_string(),
            },
        );
        let mut registry_models = HashMap::new();
        registry_models.insert(
            "ichika".to_string(),
            ModelRegistryEntry {
                name: Some("Ichika".to_string()),
                entry: "01ichika_normal_3.0_f_t04.model3.json".to_string(),
                motions: Vec::new(),
                facials: Vec::new(),
            },
        );

        let input = ProjectRenderInput {
            data_dir,
            project_dir,
            story: StoryData {
                version: 1,
                snippets: vec![
                    SnippetData::ChangeBackgroundImage {
                        id: None,
                        delay: 0.0,
                        data: ChangeBackgroundImageData {
                            background: "bg_main".to_string(),
                        },
                    },
                    SnippetData::LayoutAppear {
                        id: None,
                        delay: 0.0,
                        data: LayoutAppearData {
                            model: "ichika".to_string(),
                            position: PositionData {
                                side: Side::Center,
                                offset: 0.0,
                            },
                            hologram: false,
                            motion: Some("w-normal-nod01".to_string()),
                            facial: Some("face_smile_01".to_string()),
                        },
                    },
                    SnippetData::Talk {
                        id: None,
                        delay: 0.0,
                        data: TalkData {
                            speaker: "星乃一歌".to_string(),
                            content: "こんにちは、これは4K高フレームレートレンダリングと動画エンコードの性能ベンチマークです。".to_string(),
                            model: Some("ichika".to_string()),
                            voice: None,
                        },
                    },
                ],
            },
            assets: ProjectAssets {
                models,
                backgrounds,
                voices: HashMap::new(),
            },
            model_registry: ModelRegistry {
                version: 1,
                models: registry_models,
            },
            font: PlaybackFontConfig::Default,
        };

        let preset: VideoQualityPreset = bench_quality_preset();
        let cfg = VideoExportConfig {
            width: 3840,
            height: 2160,
            fps: 60,
            quality: preset,
            trailing_hold_ms: 2000,
            include_audio: false,
            ..Default::default()
        };
        eprintln!(
            "[4K BENCH CONFIG] 3840x2160@60 quality={preset:?} qp={} gop={} bitrate_bps={} trailing_hold={}ms",
            cfg.resolved_video_qp(),
            cfg.resolved_gop_frames(),
            cfg.resolved_video_bitrate_bps(),
            cfg.trailing_hold_ms
        );

        // 1) Measure pure GPU render + YUV420p readback (separating init vs steady-state render)
        let started_gpu = Instant::now();
        let mut gpu_frames: u64 = 0;
        let mut first_frame_elapsed: Option<f64> = None;
        let (_gpu_count, _, _) = drive_pipelined_scene_frames(
            &input,
            &cfg,
            cfg.resolve_seed(),
            HashMap::new(),
            0,
            1000.0 / cfg.fps as f64,
            None,
            &started_gpu,
            &mut |_| {},
            |_idx, yuv| {
                if first_frame_elapsed.is_none() {
                    first_frame_elapsed = Some(started_gpu.elapsed().as_secs_f64());
                }
                gpu_frames += 1;
                std::hint::black_box(yuv.y.first());
                Ok(())
            },
        )
        .expect("4K GPU render succeeds");
        let gpu_secs = started_gpu.elapsed().as_secs_f64();
        let init_secs = first_frame_elapsed.unwrap_or(0.0);
        let steady_secs = (gpu_secs - init_secs).max(1e-6);
        let gpu_fps = (gpu_frames as f64) / gpu_secs.max(1e-6);
        let steady_fps = ((gpu_frames.saturating_sub(1)) as f64) / steady_secs;
        eprintln!(
            "[4K BENCH GPU-ONLY] frames={}, total={:.3}s ({:.1} FPS), init={:.3}s, steady={:.3}s ({:.1} FPS)",
            gpu_frames, gpu_secs, gpu_fps, init_secs, steady_secs, steady_fps
        );

        // 2) Measure VideoToolbox encode-only (no GPU, no MP4 muxer)
        {
            #[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
            {
                use crate::renderer::encoder::VideoFrameEncoder;
                let mut vt = crate::renderer::encoder::video_vt::VideoVtEncoder::new_with_options(
                    3840,
                    2160,
                    60,
                    H264EncoderOptions {
                        quality: preset,
                        qp: cfg.resolved_video_qp(),
                        bitrate_bps: cfg.resolved_video_bitrate_bps(),
                        gop_size: cfg.resolved_gop_frames(),
                    },
                )
                .expect("vt encoder");
                let hw: bool = vt.is_hardware_accelerated();
                let dummy_yuv = YuvFrame {
                    width: 3840,
                    height: 2160,
                    y: vec![128u8; 3840 * 2160],
                    u: vec![128u8; 1920 * 1080],
                    v: vec![128u8; 1920 * 1080],
                };
                let started_vt = Instant::now();
                let mut vt_bytes: usize = 0;
                for i in 0..334u64 {
                    let pkts = vt.encode_yuv(&dummy_yuv, (i as f64) / 60.0).expect("vt encode");
                    for p in pkts {
                        vt_bytes += p.annex_b.len();
                    }
                }
                for p in vt.finish().expect("vt finish") {
                    vt_bytes += p.annex_b.len();
                }
                let vt_secs = started_vt.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH VT-ONLY] hw={}, frames=334, elapsed={:.3}s, vt_fps={:.1} FPS, bytes={}",
                    hw,
                    vt_secs,
                    334.0 / vt_secs.max(1e-6),
                    vt_bytes
                );

                // 2b) Measure 4x parallel VideoToolbox GOP sessions
                let started_vt4 = Instant::now();
                let cfg_ref = &cfg;
                let vt4_bytes: usize = std::thread::scope(|s| {
                    let yuv_ref = &dummy_yuv;
                    let mut handles = Vec::new();
                    for w in 0..4usize {
                        handles.push(s.spawn(move || -> usize {
                            let mut enc = crate::renderer::encoder::video_vt::VideoVtEncoder::new_with_options(
                                3840,
                                2160,
                                60,
                                H264EncoderOptions {
                                    quality: preset,
                                    qp: cfg_ref.resolved_video_qp(),
                                    bitrate_bps: cfg_ref.resolved_video_bitrate_bps(),
                                    gop_size: cfg_ref.resolved_gop_frames(),
                                },
                            )
                            .expect("vt4");
                            let count = if w < 2 { 84 } else { 83 };
                            let mut bytes = 0usize;
                            for i in 0..count {
                                for p in enc.encode_yuv(yuv_ref, (i as f64) / 60.0).expect("vt4 enc") {
                                    bytes += p.annex_b.len();
                                }
                            }
                            for p in enc.finish().expect("vt4 fin") {
                                bytes += p.annex_b.len();
                            }
                            bytes
                        }));
                    }
                    handles.into_iter().map(|h| h.join().unwrap()).sum()
                });
                let vt4_secs = started_vt4.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH VT-4X] frames=334, elapsed={:.3}s, vt4_fps={:.1} FPS, bytes={}",
                    vt4_secs,
                    334.0 / vt4_secs.max(1e-6),
                    vt4_bytes
                );

                // 2c) Measure RustyH264 parallel GOP across all CPU cores
                let started_cpu_gop = Instant::now();
                let workers: usize = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(4);
                let chunk_len: usize = 334usize.div_ceil(workers);
                let cpu_bytes: usize = std::thread::scope(|s| {
                    let yuv_ref = &dummy_yuv;
                    let mut handles = Vec::new();
                    for w in 0..workers {
                        let start_idx: usize = w * chunk_len;
                        if start_idx >= 334 {
                            break;
                        }
                        let count: usize = (334 - start_idx).min(chunk_len);
                        handles.push(s.spawn(move || -> usize {
                            let mut enc = crate::renderer::encoder::RustyH264VideoEncoder::new_with_options(
                                3840,
                                2160,
                                60,
                                H264EncoderOptions {
                                    quality: preset,
                                    qp: cfg_ref.resolved_video_qp(),
                                    bitrate_bps: 0,
                                    gop_size: cfg_ref.resolved_gop_frames(),
                                },
                            )
                            .expect("cpu enc");
                            let mut bytes = 0usize;
                            for i in 0..count {
                                for p in enc
                                    .encode_yuv(yuv_ref, ((start_idx + i) as f64) / 60.0)
                                    .expect("cpu enc frame")
                                {
                                    bytes += p.annex_b.len();
                                }
                            }
                            for p in enc.finish().expect("cpu fin") {
                                bytes += p.annex_b.len();
                            }
                            bytes
                        }));
                    }
                    handles.into_iter().map(|h| h.join().unwrap()).sum()
                });
                let cpu_secs = started_cpu_gop.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH CPU-GOP-{}X] frames=334, elapsed={:.3}s, cpu_fps={:.1} FPS, bytes={}",
                    workers,
                    cpu_secs,
                    334.0 / cpu_secs.max(1e-6),
                    cpu_bytes
                );
            }
        }

        // 3) Measure full 4K export (GPU + VideoToolbox + MP4 mux)
        let mp4_path = tmp.join("bench_4k.mp4");
        let started = Instant::now();
        let res = export_story_to_mp4(&input, &cfg, &mp4_path, None, |_| {})
            .expect("4K export succeeds");
        let secs = started.elapsed().as_secs_f64();
        let fps_eff = (res.video_frames as f64) / secs.max(1e-6);
        eprintln!(
            "[4K BENCH FULL-MP4] frames={}, elapsed={:.3}s, effective_fps={:.1} FPS, bytes={}",
            res.video_frames, secs, fps_eff, res.bytes_written
        );

        let mut cfg_gop12 = cfg.clone();
        cfg_gop12.gop_frames = Some(12);
        let mp4_gop12 = tmp.join("bench_4k_gop12.mp4");
        let started12 = Instant::now();
        let res12 = export_story_to_mp4(&input, &cfg_gop12, &mp4_gop12, None, |_| {})
            .expect("4K export gop12 succeeds");
        let secs12 = started12.elapsed().as_secs_f64();
        let fps12 = (res12.video_frames as f64) / secs12.max(1e-6);
        eprintln!(
            "[4K BENCH FULL-MP4-GOP12] frames={}, elapsed={:.3}s, effective_fps={:.1} FPS, bytes={}",
            res12.video_frames, secs12, fps12, res12.bytes_written
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 4K (3840x2160) pipeline breakdown benchmark.
    ///
    /// Group A: GPU render + GPU-packed YUV420p readback only (no encoding).
    /// Group B: full `export_story_to_mp4` with the default 4K route (parallel `rusty_h264` GOP workers).
    /// Group C: full `export_story_to_mp4` forced onto the VideoToolbox streaming encoder.
    /// Group D: encoder-only micro benchmarks replayed on real captured 4K YUV frames.
    #[test]
    #[ignore = "4K pipeline breakdown benchmark (run with --release -- --ignored --nocapture --test-threads=1)"]
    fn bench_4k_pipeline_breakdown() {
        let w: u32 = std::env::var("MSS_BENCH_W")
            .ok()
            .and_then(|v: String| v.parse::<u32>().ok())
            .unwrap_or(3840);
        let h: u32 = std::env::var("MSS_BENCH_H")
            .ok()
            .and_then(|v: String| v.parse::<u32>().ok())
            .unwrap_or(2160);
        const FPS: u32 = 60;
        const REPEATS: usize = 3;
        const CAPTURE_FRAMES: usize = 15;
        const MICRO_FRAMES: usize = 120;
        // `MSS_QUICK=1` runs a single repeat of groups A/B only, so an A/B pair fits
        // inside a short window and thermal drift cannot swamp the measurement.
        let quick: bool = std::env::var("MSS_QUICK").is_ok();

        fn pct(sorted: &[f64], p: f64) -> f64 {
            if sorted.is_empty() {
                return 0.0;
            }
            let idx: usize = (((sorted.len() - 1) as f64) * p).round() as usize;
            sorted[idx.min(sorted.len() - 1)]
        }

        fn report(label: &str, intervals: &mut Vec<f64>) -> f64 {
            if intervals.is_empty() {
                eprintln!("[4K BENCH {label}] no samples");
                return 0.0;
            }
            intervals.sort_by(|a: &f64, b: &f64| a.partial_cmp(b).unwrap());
            let n: usize = intervals.len();
            let mean: f64 = intervals.iter().sum::<f64>() / n as f64;
            eprintln!(
                "[4K BENCH {label}] n={n} mean={mean:.2}ms p50={:.2}ms p95={:.2}ms min={:.2}ms max={:.2}ms mean_fps={:.2}",
                pct(intervals, 0.50),
                pct(intervals, 0.95),
                intervals[0],
                intervals[n - 1],
                1000.0 / mean.max(1e-9)
            );
            mean
        }

        // Renders the story without any encoder attached, returning per-frame intervals (ms) and
        // optionally captures the first `capture` steady-state YUV frames for the micro benchmarks.
        fn gpu_only(
            input: &ProjectRenderInput,
            cfg: &VideoExportConfig,
            capture: usize,
        ) -> (u64, f64, Vec<f64>, Vec<YuvFrame>) {
            let started: Instant = Instant::now();
            let mut last: Option<Instant> = None;
            let mut frames: u64 = 0;
            let mut intervals: Vec<f64> = Vec::new();
            let mut captured: Vec<YuvFrame> = Vec::new();
            let mut cap: usize = capture;
            drive_pipelined_scene_frames(
                input,
                cfg,
                cfg.resolve_seed(),
                HashMap::new(),
                0,
                1000.0 / cfg.fps as f64,
                None,
                &started,
                &mut |_| {},
                |_idx, yuv| {
                    let now: Instant = Instant::now();
                    if let Some(prev) = last {
                        intervals.push(now.duration_since(prev).as_secs_f64() * 1000.0);
                    }
                    if cap > 0 {
                        captured.push(yuv.clone());
                        cap -= 1;
                    }
                    last = Some(now);
                    frames += 1;
                    Ok(())
                },
            )
            .expect("4K GPU-only render succeeds");
            (frames, started.elapsed().as_secs_f64(), intervals, captured)
        }

        fn full_export(
            input: &ProjectRenderInput,
            cfg: &VideoExportConfig,
            path: &Path,
        ) -> (u64, f64, u64, f64, f64, Vec<f64>) {
            let started: Instant = Instant::now();
            let mut render_start: Option<Instant> = None;
            let mut render_end: Option<Instant> = None;
            let mut mux_done: Option<Instant> = None;
            let mut last_progress: Option<Instant> = None;
            let mut last_count: u64 = 0;
            let mut intervals: Vec<f64> = Vec::new();
            let res: ExportResult = export_story_to_mp4(input, cfg, path, None, |p: ExportProgress| {
                let now: Instant = Instant::now();
                match p.stage {
                    ExportStage::Rendering => {
                        if render_start.is_none() {
                            render_start = Some(now);
                        }
                        if p.rendered_frames > last_count {
                            if let Some(prev) = last_progress {
                                intervals.push(now.duration_since(prev).as_secs_f64() * 1000.0);
                            }
                            last_progress = Some(now);
                            last_count = p.rendered_frames;
                        }
                    }
                    ExportStage::EncodingAudio => {
                        render_end = Some(now);
                    }
                    ExportStage::Muxing => {
                        render_end = render_end.or(Some(now));
                    }
                    ExportStage::Completed => {
                        mux_done = Some(now);
                    }
                    ExportStage::Preparing => {}
                }
            })
            .expect("4K export succeeds");
            let secs: f64 = started.elapsed().as_secs_f64();
            let render_secs: f64 = match (render_start, render_end) {
                (Some(a), Some(b)) => b.duration_since(a).as_secs_f64(),
                _ => 0.0,
            };
            let mux_secs: f64 = match (render_end, mux_done) {
                (Some(a), Some(b)) => b.duration_since(a).as_secs_f64(),
                _ => 0.0,
            };
            (
                res.video_frames,
                secs,
                res.bytes_written,
                render_secs,
                mux_secs,
                intervals,
            )
        }

        let tmp: PathBuf = bench_tmp_dir("my_sekai_bench_4k_breakdown");
        let _ = std::fs::remove_dir_all(&tmp);
        let data_dir: PathBuf = tmp.join("data");
        let project_dir: PathBuf = tmp.join("project");
        let models_dir: PathBuf = data_dir.join("models/ichika");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(project_dir.join("backgrounds")).unwrap();

        let repo_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        copy_dir_all(
            &repo_root.join("tests/models/01ichika_normal_3.0_f_t04"),
            &models_dir,
        );

        let mut bg: image::RgbaImage = image::RgbaImage::new(1920, 1080);
        for px in bg.pixels_mut() {
            *px = image::Rgba([24, 52, 88, 255]);
        }
        bg.save(project_dir.join("backgrounds/bg.png")).unwrap();

        let mut models: HashMap<String, ModelAsset> = HashMap::new();
        models.insert(
            "ichika".to_string(),
            ModelAsset {
                name: Some("星乃一歌".to_string()),
                model_id: "ichika".to_string(),
                normal_scale: 2.1,
                small_scale: 1.6,
                anchor: 0.5,
            },
        );
        let mut backgrounds: HashMap<String, BackgroundAsset> = HashMap::new();
        backgrounds.insert(
            "bg_main".to_string(),
            BackgroundAsset {
                name: Some("BG".to_string()),
                path: "backgrounds/bg.png".to_string(),
            },
        );
        let mut registry_models: HashMap<String, ModelRegistryEntry> = HashMap::new();
        registry_models.insert(
            "ichika".to_string(),
            ModelRegistryEntry {
                name: Some("Ichika".to_string()),
                entry: "01ichika_normal_3.0_f_t04.model3.json".to_string(),
                motions: Vec::new(),
                facials: Vec::new(),
            },
        );

        let input: ProjectRenderInput = ProjectRenderInput {
            data_dir,
            project_dir,
            story: StoryData {
                version: 1,
                snippets: vec![
                    SnippetData::ChangeBackgroundImage {
                        id: None,
                        delay: 0.0,
                        data: ChangeBackgroundImageData {
                            background: "bg_main".to_string(),
                        },
                    },
                    SnippetData::LayoutAppear {
                        id: None,
                        delay: 0.0,
                        data: LayoutAppearData {
                            model: "ichika".to_string(),
                            position: PositionData {
                                side: Side::Center,
                                offset: 0.0,
                            },
                            hologram: false,
                            motion: Some("w-normal-nod01".to_string()),
                            facial: Some("face_smile_01".to_string()),
                        },
                    },
                    SnippetData::Talk {
                        id: None,
                        delay: 0.0,
                        data: TalkData {
                            speaker: "星乃一歌".to_string(),
                            content: "こんにちは、これは4K高フレームレートレンダリングと動画エンコードの性能ベンチマークです。".to_string(),
                            model: Some("ichika".to_string()),
                            voice: None,
                        },
                    },
                ],
            },
            assets: ProjectAssets {
                models,
                backgrounds,
                voices: HashMap::new(),
            },
            model_registry: ModelRegistry {
                version: 1,
                models: registry_models,
            },
            font: PlaybackFontConfig::Default,
        };

        let preset: VideoQualityPreset = bench_quality_preset();
        let base_cfg: VideoExportConfig = VideoExportConfig {
            width: w,
            height: h,
            fps: FPS,
            quality: preset,
            trailing_hold_ms: 1000,
            include_audio: false,
            ..Default::default()
        };
        base_cfg.validate().unwrap();

        let cores: usize = std::thread::available_parallelism()
            .map(|n: std::num::NonZeroUsize| n.get())
            .unwrap_or(2);
        eprintln!(
            "[4K BENCH CONFIG] {w}x{h}@{FPS} quality={preset:?} qp={} gop={} bitrate_bps={} trailing_hold={}ms cores={cores} repeats={REPEATS}",
            base_cfg.resolved_video_qp(),
            base_cfg.resolved_gop_frames(),
            base_cfg.resolved_video_bitrate_bps(),
            base_cfg.trailing_hold_ms
        );

        // ---------------- Group A: GPU render + YUV420p readback only ----------------
        let mut captured_yuv: Vec<YuvFrame> = Vec::new();
        let mut group_a_means: Vec<f64> = Vec::new();
        for run in 0..if quick { 1 } else { REPEATS } {
            let capture: usize = if run == 0 { CAPTURE_FRAMES } else { 0 };
            let (frames, secs, mut intervals, captured) =
                gpu_only(&input, &base_cfg, capture);
            if run == 0 {
                captured_yuv = captured;
            }
            let mean: f64 = report(&format!("A-run{run} gpu-render+readback"), &mut intervals);
            eprintln!(
                "[4K BENCH A-run{run} total] frames={frames} elapsed={secs:.3}s wall_fps={:.2}",
                frames as f64 / secs.max(1e-9)
            );
            group_a_means.push(mean);
        }

        // ---------------- Group B: default 4K route (parallel rusty_h264 GOP workers) ----------------
        let mut group_b_means: Vec<f64> = Vec::new();
        for run in 0..if quick { 1 } else { REPEATS } {
            let mp4: PathBuf = tmp.join(format!("b_soft_{run}.mp4"));
            let (frames, secs, bytes, render_secs, mux_secs, mut intervals) =
                full_export(&input, &base_cfg, &mp4);
            report(&format!("B-run{run} full-soft-gop"), &mut intervals);
            eprintln!(
                "[4K BENCH B-run{run} total] frames={frames} elapsed={secs:.3}s wall_fps={:.2} render_phase={render_secs:.3}s mux_phase={mux_secs:.3}s bytes={bytes}",
                frames as f64 / secs.max(1e-9)
            );
            group_b_means.push(secs * 1000.0 / frames as f64);
            let _ = std::fs::remove_file(&mp4);
        }

        if quick {
            return;
        }
        // ---------------- Group C: VideoToolbox streaming encode ----------------
        #[cfg(all(target_os = "macos", feature = "native-hw-accel"))]
        {
            let mut vt_cfg: VideoExportConfig = base_cfg.clone();
            // A non-zero bitrate is what routes the export onto `run_streaming_abr_pipeline`,
            // which is the only path that uses the VideoToolbox encoder.
            vt_cfg.video_bitrate_kbps = Some(20_000);
            vt_cfg.render_backend = crate::renderer::config::RenderBackend::Metal;
            vt_cfg.validate().unwrap();
            let mut group_c_means: Vec<f64> = Vec::new();
            for run in 0..if quick { 1 } else { REPEATS } {
                let mp4: PathBuf = tmp.join(format!("c_vt_{run}.mp4"));
                let (frames, secs, bytes, render_secs, mux_secs, mut intervals) =
                    full_export(&input, &vt_cfg, &mp4);
                report(&format!("C-run{run} full-videotoolbox"), &mut intervals);
                eprintln!(
                    "[4K BENCH C-run{run} total] frames={frames} elapsed={secs:.3}s wall_fps={:.2} render_phase={render_secs:.3}s mux_phase={mux_secs:.3}s bytes={bytes}",
                    frames as f64 / secs.max(1e-9)
                );
                group_c_means.push(secs * 1000.0 / frames as f64);
                let _ = std::fs::remove_file(&mp4);
            }
            eprintln!(
                "[4K BENCH C SUMMARY] per_frame_ms={:?}",
                group_c_means
                    .iter()
                    .map(|v: &f64| (v * 100.0).round() / 100.0)
                    .collect::<Vec<f64>>()
            );
        }

        // ---------------- Group D: encoder-only micro benchmarks on real frames ----------------
        {
            use crate::renderer::encoder::{
                encode_yuv_gop_chunk, RustyH264VideoEncoder, VideoFrameEncoder,
            };
            assert!(!captured_yuv.is_empty(), "need captured YUV frames");
            let opts: H264EncoderOptions = H264EncoderOptions {
                quality: preset,
                qp: base_cfg.resolved_video_qp(),
                bitrate_bps: 0,
                gop_size: 15,
            };
            let frames_len: usize = captured_yuv.len();

            // D1: pure single-thread rusty_h264 streaming encode.
            {
                let mut enc: RustyH264VideoEncoder =
                    RustyH264VideoEncoder::new_with_options(w, h, FPS, opts).expect("cpu enc");
                let started: Instant = Instant::now();
                let mut bytes: usize = 0;
                for i in 0..MICRO_FRAMES {
                    for p in enc
                        .encode_yuv(&captured_yuv[i % frames_len], (i as f64) / (FPS as f64))
                        .expect("cpu encode")
                    {
                        bytes += p.annex_b.len();
                    }
                }
                for p in enc.finish().expect("cpu finish") {
                    bytes += p.annex_b.len();
                }
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH D1 rusty_h264-1thread] frames={MICRO_FRAMES} elapsed={secs:.3}s fps={:.2} bytes={bytes}",
                    MICRO_FRAMES as f64 / secs.max(1e-9)
                );
            }

            // D2: production-style parallel GOP across all cores (mitates `run_parallel_gop_pipeline`).
            {
                let gop: usize = 15;
                let workers: usize = cores.clamp(1, 16);
                // Give every worker at least one chunk so the measurement is not chunk-starved.
                let chunks: usize = workers.max(MICRO_FRAMES.div_ceil(gop));
                let next: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
                let started: Instant = Instant::now();
                let bytes: usize = std::thread::scope(|s| -> usize {
                    let mut handles: Vec<std::thread::ScopedJoinHandle<usize>> = Vec::new();
                    for _ in 0..workers {
                        let next_ref: &std::sync::atomic::AtomicUsize = &next;
                        let frames_ref: &Vec<YuvFrame> = &captured_yuv;
                        handles.push(s.spawn(move || -> usize {
                            let mut out: usize = 0;
                            loop {
                                let ci: usize = next_ref
                                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                if ci >= chunks {
                                    break;
                                }
                                let mut batch: Vec<YuvFrame> = Vec::with_capacity(gop);
                                for k in 0..gop {
                                    batch.push(
                                        frames_ref[(ci * gop + k) % frames_ref.len()].clone(),
                                    );
                                }
                                let pkts: Vec<EncodedVideoPacket> = encode_yuv_gop_chunk(
                                    &batch,
                                    (ci * gop) as u64,
                                    w,
                                    h,
                                    FPS,
                                    opts,
                                )
                                .expect("gop encode");
                                for p in pkts {
                                    out += p.annex_b.len();
                                }
                            }
                            out
                        }));
                    }
                    handles
                        .into_iter()
                        .map(|h: std::thread::ScopedJoinHandle<usize>| h.join().unwrap())
                        .sum()
                });
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH D2 rusty_h264-gop-{workers}thread] frames={} elapsed={secs:.3}s fps={:.2} bytes={bytes}",
                    chunks * gop,
                    (chunks * gop) as f64 / secs.max(1e-9)
                );
            }

            // D3: single VideoToolbox session.
            {
                let vt_opts: H264EncoderOptions = H264EncoderOptions {
                    quality: preset,
                    qp: base_cfg.resolved_video_qp(),
                    bitrate_bps: 0,
                    gop_size: 15,
                };
                let mut enc: crate::renderer::encoder::video_vt::VideoVtEncoder =
                    crate::renderer::encoder::video_vt::VideoVtEncoder::new_with_options(
                        w, h, FPS, vt_opts,
                    )
                    .expect("vt enc");
                let hw: bool = enc.is_hardware_accelerated();
                let started: Instant = Instant::now();
                let mut bytes: usize = 0;
                for i in 0..MICRO_FRAMES {
                    for p in enc
                        .encode_yuv(&captured_yuv[i % frames_len], (i as f64) / (FPS as f64))
                        .expect("vt encode")
                    {
                        bytes += p.annex_b.len();
                    }
                }
                for p in enc.finish().expect("vt finish") {
                    bytes += p.annex_b.len();
                }
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH D3 videotoolbox-1session] hw={hw} frames={MICRO_FRAMES} elapsed={secs:.3}s fps={:.2} bytes={bytes}",
                    MICRO_FRAMES as f64 / secs.max(1e-9)
                );
            }

            // Shared helper: one VideoToolbox session encoding `count` frames round-robin.
            // `expected_fps` becomes `kVTCompressionPropertyKey_ExpectedFrameRate`, which is what
            // controls whether VideoToolbox paces the session to real time.
            fn vt_run(expected_fps: u32, frames: &[YuvFrame], count: usize) -> (bool, f64, usize) {
                let vt_preset: VideoQualityPreset = bench_quality_preset();
                let vt_opts: H264EncoderOptions = H264EncoderOptions {
                    quality: vt_preset,
                    qp: vt_preset.h264_qp(),
                    bitrate_bps: 0,
                    gop_size: 15,
                };
                let mut enc: crate::renderer::encoder::video_vt::VideoVtEncoder =
                    crate::renderer::encoder::video_vt::VideoVtEncoder::new_with_options(
                        3840,
                        2160,
                        expected_fps,
                        vt_opts,
                    )
                    .expect("vt enc");
                let hw: bool = enc.is_hardware_accelerated();
                let started: Instant = Instant::now();
                let mut bytes: usize = 0;
                for i in 0..count {
                    for p in enc
                        .encode_yuv(&frames[i % frames.len()], (i as f64) / 60.0)
                        .expect("vt encode")
                    {
                        bytes += p.annex_b.len();
                    }
                }
                for p in enc.finish().expect("vt finish") {
                    bytes += p.annex_b.len();
                }
                (hw, started.elapsed().as_secs_f64(), bytes)
            }

            // D4: same single session but with ExpectedFrameRate = 240 to test pacing.
            {
                let (hw, secs, bytes) = vt_run(240, &captured_yuv, MICRO_FRAMES);
                eprintln!(
                    "[4K BENCH D4 videotoolbox-expected-fps-240] hw={hw} frames={MICRO_FRAMES} elapsed={secs:.3}s fps={:.2} bytes={bytes}",
                    MICRO_FRAMES as f64 / secs.max(1e-9)
                );
            }

            // D5: four parallel VideoToolbox sessions.
            {
                let per_session: usize = MICRO_FRAMES / 4;
                let started: Instant = Instant::now();
                let bytes: usize = std::thread::scope(|s| -> usize {
                    let mut handles: Vec<std::thread::ScopedJoinHandle<usize>> = Vec::new();
                    for _ in 0..4 {
                        let frames_ref: &Vec<YuvFrame> = &captured_yuv;
                        handles.push(s.spawn(move || -> usize {
                            vt_run(60, frames_ref, per_session).2
                        }));
                    }
                    handles
                        .into_iter()
                        .map(|h: std::thread::ScopedJoinHandle<usize>| h.join().unwrap())
                        .sum()
                });
                let secs: f64 = started.elapsed().as_secs_f64();
                eprintln!(
                    "[4K BENCH D5 videotoolbox-4sessions] frames={} elapsed={secs:.3}s fps={:.2} bytes={bytes}",
                    per_session * 4,
                    (per_session * 4) as f64 / secs.max(1e-9)
                );
            }
        }

        eprintln!(
            "[4K BENCH A SUMMARY] per_frame_ms={:?}",
            group_a_means
                .iter()
                .map(|v: &f64| (v * 100.0).round() / 100.0)
                .collect::<Vec<f64>>()
        );
        eprintln!(
            "[4K BENCH B SUMMARY] per_frame_ms={:?}",
            group_b_means
                .iter()
                .map(|v: &f64| (v * 100.0).round() / 100.0)
                .collect::<Vec<f64>>()
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ========================================================================================
    // 30: 4K encode fidelity gate — per-plane PSNR, SSIM and bitrate for the shipping H.264
    //     pipeline, plus the 4:2:0 structural loss floor that no encoder setting can beat.
    //
    // LAYER 1 "encoder fidelity": encoder-input YUV420p  <->  rusty_h264-decoder YUV420p output.
    //     Frames come from the production render pipeline (`drive_pipelined_scene_frames`, the same
    //     capture path as `bench_4k_pipeline_breakdown`) and are encoded through the production
    //     `encode_yuv_gop_chunk` GOP split, including `run_parallel_gop_pipeline`'s 4K `min(gop,15)`
    //     cap, so the byte count matches a real export at that QP.
    //
    // LAYER 2 "4:2:0 structural loss": a real rendered RGBA frame converted to full-resolution
    //     BT.709 YUV444 (same integer coefficients as `rgba_to_yuv420p_bt709`) compared against the
    //     production `rgba_to_yuv420p_bt709` 4:2:0 frame upsampled back to 4:4:4 and to RGB.
    //
    // Metrics are implemented here; no extra crates:
    //   * PSNR per plane, peak 255, pooled SSE over every measured frame.
    //   * Overall 4:2:0 PSNR from the area-weighted MSE
    //     (|Y|*mse_y + |U|*mse_u + |V|*mse_v) / (|Y| + 2*|UV|), i.e. Y:U:V = 4:1:1.
    //   * SSIM over non-overlapping 8x8 blocks, C1=(0.01*255)^2, C2=(0.03*255)^2.
    // ========================================================================================

    const PG_PSNR_PEAK: f64 = 255.0;
    const PG_SSIM_C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
    const PG_SSIM_C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);

    /// PSNR (dB, peak 255) from an accumulated squared error over `n` samples.
    fn pg_psnr_from_sse(sse: u64, n: usize) -> f64 {
        if n == 0 {
            return f64::NAN;
        }
        pg_psnr_from_mse(sse as f64 / n as f64)
    }

    fn pg_psnr_from_mse(mse: f64) -> f64 {
        if mse <= 0.0 {
            f64::INFINITY
        } else {
            10.0 * ((PG_PSNR_PEAK * PG_PSNR_PEAK) / mse).log10()
        }
    }

    fn pg_plane_sse(a: &[u8], b: &[u8]) -> u64 {
        assert_eq!(a.len(), b.len(), "plane length mismatch");
        let mut acc: u64 = 0;
        for (x, y) in a.iter().zip(b.iter()) {
            let d: i32 = *x as i32 - *y as i32;
            acc += (d * d) as u64;
        }
        acc
    }

    /// SSE of one interleaved channel (`offset` bytes into each `stride`-byte pixel).
    fn pg_channel_sse(a: &[u8], b: &[u8], offset: usize, stride: usize) -> u64 {
        assert_eq!(a.len(), b.len(), "buffer length mismatch");
        let mut acc: u64 = 0;
        let mut i: usize = offset;
        while i < a.len() {
            let d: i32 = a[i] as i32 - b[i] as i32;
            acc += (d * d) as u64;
            i += stride;
        }
        acc
    }

    /// SSIM over non-overlapping 8x8 blocks of one plane.
    fn pg_ssim_8x8(a: &[u8], b: &[u8], w: usize, h: usize) -> f64 {
        const BS: usize = 8;
        let cols: usize = w / BS;
        let rows: usize = h / BS;
        if cols == 0 || rows == 0 || a.len() < w * h || b.len() < w * h {
            return f64::NAN;
        }
        let inv: f64 = 1.0 / ((BS * BS) as f64);
        let mut total: f64 = 0.0;
        let mut n: usize = 0;
        for by in 0..rows {
            for bx in 0..cols {
                let (mut sx, mut sy, mut sxx, mut syy, mut sxy): (f64, f64, f64, f64, f64) =
                    (0.0, 0.0, 0.0, 0.0, 0.0);
                for yy in 0..BS {
                    let row: usize = (by * BS + yy) * w + bx * BS;
                    for xx in 0..BS {
                        let x: f64 = a[row + xx] as f64;
                        let y: f64 = b[row + xx] as f64;
                        sx += x;
                        sy += y;
                        sxx += x * x;
                        syy += y * y;
                        sxy += x * y;
                    }
                }
                let mx: f64 = sx * inv;
                let my: f64 = sy * inv;
                let vx: f64 = (sxx * inv - mx * mx).max(0.0);
                let vy: f64 = (syy * inv - my * my).max(0.0);
                let cxy: f64 = sxy * inv - mx * my;
                let num: f64 = (2.0 * mx * my + PG_SSIM_C1) * (2.0 * cxy + PG_SSIM_C2);
                let den: f64 = (mx * mx + my * my + PG_SSIM_C1) * (vx + vy + PG_SSIM_C2);
                total += num / den;
                n += 1;
            }
        }
        total / n as f64
    }

    /// Per-pixel BT.709 limited-range YUV444 using the exact integer coefficients that
    /// `rgba_to_yuv420p_bt709` averages over its 2x2 chroma footprint.
    fn pg_yuv444_from_rgba_bt709(rgba: &[u8], w: usize, h: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let n: usize = w * h;
        assert!(rgba.len() >= n * 4, "RGBA buffer too small");
        let mut y_out: Vec<u8> = vec![0u8; n];
        let mut u_out: Vec<u8> = vec![0u8; n];
        let mut v_out: Vec<u8> = vec![0u8; n];
        for i in 0..n {
            let r: i32 = rgba[i * 4] as i32;
            let g: i32 = rgba[i * 4 + 1] as i32;
            let b: i32 = rgba[i * 4 + 2] as i32;
            y_out[i] =
                (((11_966 * r + 40_254 * g + 4_064 * b + 32_768) >> 16) + 16).clamp(16, 235) as u8;
            u_out[i] = (((-6_596 * r - 22_188 * g + 28_784 * b + 32_768) >> 16) + 128)
                .clamp(16, 240) as u8;
            v_out[i] = (((28_784 * r - 26_145 * g - 2_639 * b + 32_768) >> 16) + 128)
                .clamp(16, 240) as u8;
        }
        (y_out, u_out, v_out)
    }

    /// Upsamples a 4:2:0 chroma plane to full resolution: `false` = replicate (each chroma sample
    /// covers its 2x2 footprint, the exact inverse of the box average), `true` = centered bilinear.
    fn pg_upsample_chroma(
        src: &[u8],
        cw: usize,
        ch: usize,
        w: usize,
        h: usize,
        bilinear: bool,
    ) -> Vec<u8> {
        let mut out: Vec<u8> = vec![0u8; w * h];
        if cw == 0 || ch == 0 {
            return out;
        }
        if !bilinear {
            for y in 0..h {
                let cy: usize = (y / 2).min(ch - 1);
                for x in 0..w {
                    out[y * w + x] = src[cy * cw + (x / 2).min(cw - 1)];
                }
            }
            return out;
        }
        // Horizontal pass: (cw x ch) -> (w x ch), chroma sample i centered at full-res x = 2i + 0.5.
        let mut hbuf: Vec<u8> = vec![0u8; w * ch];
        for cy in 0..ch {
            for x in 0..w {
                let s: f64 = (x as f64 - 0.5) / 2.0;
                let f: f64 = s.floor();
                let frac: f64 = s - f;
                let i0: usize = if f < 0.0 { 0 } else { (f as usize).min(cw - 1) };
                let i1: usize = (i0 + 1).min(cw - 1);
                let a: f64 = src[cy * cw + i0] as f64;
                let b: f64 = src[cy * cw + i1] as f64;
                hbuf[cy * w + x] = (a + (b - a) * frac).round().clamp(0.0, 255.0) as u8;
            }
        }
        // Vertical pass: (w x ch) -> (w x h).
        for y in 0..h {
            let s: f64 = (y as f64 - 0.5) / 2.0;
            let f: f64 = s.floor();
            let frac: f64 = s - f;
            let r0: usize = if f < 0.0 { 0 } else { (f as usize).min(ch - 1) };
            let r1: usize = (r0 + 1).min(ch - 1);
            for x in 0..w {
                let a: f64 = hbuf[r0 * w + x] as f64;
                let b: f64 = hbuf[r1 * w + x] as f64;
                out[y * w + x] = (a + (b - a) * frac).round().clamp(0.0, 255.0) as u8;
            }
        }
        out
    }

    /// BT.709 limited-range 4:4:4 -> RGBA8 (alpha forced opaque), the player-side inverse.
    fn pg_rgba_from_yuv444(y: &[u8], u: &[u8], v: &[u8], n: usize) -> Vec<u8> {
        let mut out: Vec<u8> = vec![255u8; n * 4];
        for i in 0..n {
            let yf: f64 = (y[i] as f64 - 16.0) * (255.0 / 219.0);
            let cb: f64 = (u[i] as f64 - 128.0) * (255.0 / 224.0);
            let cr: f64 = (v[i] as f64 - 128.0) * (255.0 / 224.0);
            out[i * 4] = (yf + 1.5748 * cr).round().clamp(0.0, 255.0) as u8;
            out[i * 4 + 1] = (yf - 0.1873 * cb - 0.4681 * cr)
                .round()
                .clamp(0.0, 255.0) as u8;
            out[i * 4 + 2] = (yf + 1.8556 * cb).round().clamp(0.0, 255.0) as u8;
        }
        out
    }

    /// Standard deviation of a plane sampled every `step` pixels (cheap "is there content?" test).
    fn pg_sampled_std(plane: &[u8], n: usize, step: usize) -> f64 {
        let mut sum: f64 = 0.0;
        let mut sumsq: f64 = 0.0;
        let mut cnt: usize = 0;
        let mut i: usize = 0;
        while i < n {
            let v: f64 = plane[i] as f64;
            sum += v;
            sumsq += v * v;
            cnt += 1;
            i += step;
        }
        if cnt == 0 {
            return 0.0;
        }
        let mean: f64 = sum / cnt as f64;
        ((sumsq / cnt as f64) - mean * mean).max(0.0).sqrt()
    }

    /// Builds the same 4K story fixture `bench_4k_pipeline_breakdown` uses (background + Live2D
    /// model + a long Japanese dialogue line, so the frame carries text, edges and skin gradients).
    fn pg_4k_fixture(tmp: &Path) -> ProjectRenderInput {
        let data_dir: PathBuf = tmp.join("data");
        let project_dir: PathBuf = tmp.join("project");
        let models_dir: PathBuf = data_dir.join("models/ichika");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(project_dir.join("backgrounds")).unwrap();

        let repo_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        copy_dir_all(
            &repo_root.join("tests/models/01ichika_normal_3.0_f_t04"),
            &models_dir,
        );

        let mut bg: image::RgbaImage = image::RgbaImage::new(1920, 1080);
        for px in bg.pixels_mut() {
            *px = image::Rgba([24, 52, 88, 255]);
        }
        bg.save(project_dir.join("backgrounds/bg.png")).unwrap();

        let mut models: HashMap<String, ModelAsset> = HashMap::new();
        models.insert(
            "ichika".to_string(),
            ModelAsset {
                name: Some("星乃一歌".to_string()),
                model_id: "ichika".to_string(),
                normal_scale: 2.1,
                small_scale: 1.6,
                anchor: 0.5,
            },
        );
        let mut backgrounds: HashMap<String, BackgroundAsset> = HashMap::new();
        backgrounds.insert(
            "bg_main".to_string(),
            BackgroundAsset {
                name: Some("BG".to_string()),
                path: "backgrounds/bg.png".to_string(),
            },
        );
        let mut registry_models: HashMap<String, ModelRegistryEntry> = HashMap::new();
        registry_models.insert(
            "ichika".to_string(),
            ModelRegistryEntry {
                name: Some("Ichika".to_string()),
                entry: "01ichika_normal_3.0_f_t04.model3.json".to_string(),
                motions: Vec::new(),
                facials: Vec::new(),
            },
        );

        ProjectRenderInput {
            data_dir,
            project_dir,
            story: StoryData {
                version: 1,
                snippets: vec![
                    SnippetData::ChangeBackgroundImage {
                        id: None,
                        delay: 0.0,
                        data: ChangeBackgroundImageData {
                            background: "bg_main".to_string(),
                        },
                    },
                    SnippetData::LayoutAppear {
                        id: None,
                        delay: 0.0,
                        data: LayoutAppearData {
                            model: "ichika".to_string(),
                            position: PositionData {
                                side: Side::Center,
                                offset: 0.0,
                            },
                            hologram: false,
                            motion: Some("w-normal-nod01".to_string()),
                            facial: Some("face_smile_01".to_string()),
                        },
                    },
                    SnippetData::Talk {
                        id: None,
                        delay: 0.0,
                        data: TalkData {
                            speaker: "星乃一歌".to_string(),
                            content: "こんにちは、これは4K高フレームレートレンダリングと動画エンコードの性能ベンチマークです。".to_string(),
                            model: Some("ichika".to_string()),
                            voice: None,
                        },
                    },
                ],
            },
            assets: ProjectAssets {
                models,
                backgrounds,
                voices: HashMap::new(),
            },
            model_registry: ModelRegistry {
                version: 1,
                models: registry_models,
            },
            font: PlaybackFontConfig::Default,
        }
    }

    /// Captures the first `want` steady-state YUV420p frames straight out of the production render
    /// pipeline (identical capture path to `bench_4k_pipeline_breakdown`'s `gpu_only`).
    fn pg_capture_yuv(
        input: &ProjectRenderInput,
        cfg: &VideoExportConfig,
        want: usize,
    ) -> Vec<YuvFrame> {
        let started: Instant = Instant::now();
        let mut captured: Vec<YuvFrame> = Vec::with_capacity(want);
        drive_pipelined_scene_frames(
            input,
            cfg,
            cfg.resolve_seed(),
            HashMap::new(),
            0,
            1000.0 / cfg.fps as f64,
            None,
            &started,
            &mut |_| {},
            |_idx, yuv| {
                if captured.len() < want {
                    captured.push(yuv.clone());
                }
                Ok(())
            },
        )
        .expect("4K capture render succeeds");
        captured
    }

    /// Encodes `frames` with the production GOP split and returns the concatenated Annex-B stream
    /// plus the total encoded byte count.
    fn pg_encode_annex_b(
        frames: &[YuvFrame],
        w: u32,
        h: u32,
        fps: u32,
        chunk_gop: usize,
        opts: H264EncoderOptions,
    ) -> (Vec<u8>, usize, usize) {
        let mut stream: Vec<u8> = Vec::new();
        let mut encoded_bytes: usize = 0;
        let mut chunks: usize = 0;
        let mut cursor: usize = 0;
        while cursor < frames.len() {
            let end: usize = (cursor + chunk_gop.max(1)).min(frames.len());
            let pkts: Vec<EncodedVideoPacket> =
                encode_yuv_gop_chunk(&frames[cursor..end], cursor as u64, w, h, fps, opts)
                    .expect("4K GOP encode succeeds");
            chunks += 1;
            for p in pkts {
                encoded_bytes += p.annex_b.len();
                stream.extend_from_slice(&p.annex_b);
            }
            cursor = end;
        }
        (stream, encoded_bytes, chunks)
    }
    /// 4K hybrid probe: can VideoToolbox and the *parallel* software encoder run
    /// concurrently without stealing each other's throughput? Splits one captured
    /// frame set proportionally (VT : SW = solo_vt : solo_sw), runs both at the same
    /// time, and reports the aggregate frames/sec. Full additivity would mean ~VT+SW.
    #[test]
    #[ignore = "4K hybrid VT+software concurrency probe"]
    fn bench_4k_hybrid_probe() {
        use crate::renderer::encoder::video_vt::VideoVtEncoder;
        use crate::renderer::encoder::VideoFrameEncoder;

        const W: u32 = 3840;
        const H: u32 = 2160;
        const FPS: u32 = 60;
        const FRAMES: usize = 180;
        const GOP: usize = 15;

        /// Encode `frames` with `workers` threads pulling GOP chunks from a shared
        /// counter — the same shape as `run_parallel_gop_pipeline`.
        fn sw_parallel(
            frames: &[YuvFrame],
            w: u32,
            h: u32,
            fps: u32,
            gop: usize,
            opts: H264EncoderOptions,
            workers: usize,
        ) -> usize {
            let chunks: usize = frames.len().div_ceil(gop.max(1));
            let next: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            std::thread::scope(|scope| -> usize {
                let frames_ref: &[YuvFrame] = frames;
                let next_ref: &std::sync::atomic::AtomicUsize = &next;
                let mut handles: Vec<std::thread::ScopedJoinHandle<usize>> = Vec::new();
                for _ in 0..workers.max(1) {
                    handles.push(scope.spawn(move || -> usize {
                        let mut out: usize = 0;
                        loop {
                            let ci: usize = next_ref
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            if ci >= chunks {
                                break;
                            }
                            let start: usize = ci * gop;
                            let end: usize = (start + gop).min(frames_ref.len());
                            let pkts: Vec<EncodedVideoPacket> = encode_yuv_gop_chunk(
                                &frames_ref[start..end],
                                start as u64,
                                w,
                                h,
                                fps,
                                opts,
                            )
                            .expect("sw gop encode");
                            for p in pkts {
                                out += p.annex_b.len();
                            }
                        }
                        out
                    }));
                }
                handles
                    .into_iter()
                    .map(|h: std::thread::ScopedJoinHandle<usize>| h.join().expect("sw join"))
                    .sum()
            })
        }

        let cores: usize = std::thread::available_parallelism()
            .map(|c: std::num::NonZeroUsize| c.get())
            .unwrap_or(2);

        let tmp: PathBuf = bench_tmp_dir("my_sekai_bench_4k_hybrid");
        let _ = std::fs::remove_dir_all(&tmp);
        let input: ProjectRenderInput = pg_4k_fixture(&tmp);
        let cfg: VideoExportConfig = VideoExportConfig {
            width: W,
            height: H,
            fps: FPS,
            quality: VideoQualityPreset::Balanced,
            trailing_hold_ms: 0,
            include_audio: false,
            ..Default::default()
        };
        let captured: Vec<YuvFrame> = pg_capture_yuv(&input, &cfg, FRAMES);
        let n: usize = captured.len();
        if n < 16 {
            eprintln!("[HYBRID SKIP] only {n} frames captured");
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        let opts: H264EncoderOptions = H264EncoderOptions {
            quality: VideoQualityPreset::Balanced,
            qp: cfg.resolved_video_qp(),
            bitrate_bps: 0,
            gop_size: GOP as u32,
        };

        // --- solo VideoToolbox (single session, sequential) ---
        let started: Instant = Instant::now();
        let mut vt: VideoVtEncoder = VideoVtEncoder::new_with_options(W, H, FPS, opts).expect("vt");
        let mut vt_bytes: usize = 0;
        for i in 0..n {
            for p in vt
                .encode_yuv(&captured[i], i as f64 / FPS as f64)
                .expect("vt enc")
            {
                vt_bytes += p.annex_b.len();
            }
        }
        for p in vt.finish().expect("vt fin") {
            vt_bytes += p.annex_b.len();
        }
        let vt_secs: f64 = started.elapsed().as_secs_f64();
        let vt_solo: f64 = n as f64 / vt_secs.max(1e-9);
        eprintln!(
            "[HYBRID] vt-solo frames={n} elapsed={vt_secs:.3}s fps={vt_solo:.2} bytes={vt_bytes}"
        );

        // --- solo software, all cores ---
        let started: Instant = Instant::now();
        let sw_bytes: usize = sw_parallel(&captured, W, H, FPS, GOP, opts, cores);
        let sw_secs: f64 = started.elapsed().as_secs_f64();
        let sw_solo: f64 = n as f64 / sw_secs.max(1e-9);
        eprintln!(
            "[HYBRID] sw-solo cores={cores} frames={n} elapsed={sw_secs:.3}s fps={sw_solo:.2} bytes={sw_bytes}"
        );

        // --- concurrent, split proportionally to the solo rates ---
        let vt_share: f64 = vt_solo / (vt_solo + sw_solo).max(1e-9);
        let vt_n: usize = ((n as f64) * vt_share).round().clamp(1.0, (n - 1) as f64) as usize;
        let sw_n: usize = n - vt_n;
        eprintln!("[HYBRID] split vt_frames={vt_n} sw_frames={sw_n} vt_share={vt_share:.2}");
        let started: Instant = Instant::now();
        std::thread::scope(|scope| {
            let vt_slice: &[YuvFrame] = &captured[..vt_n];
            let handle = scope.spawn(move || -> usize {
                let mut enc: VideoVtEncoder =
                    VideoVtEncoder::new_with_options(W, H, FPS, opts).expect("vt");
                let mut bytes: usize = 0;
                for (i, f) in vt_slice.iter().enumerate() {
                    for p in enc.encode_yuv(f, i as f64 / FPS as f64).expect("vt enc") {
                        bytes += p.annex_b.len();
                    }
                }
                for p in enc.finish().expect("vt fin") {
                    bytes += p.annex_b.len();
                }
                bytes
            });
            let _ = sw_parallel(&captured[vt_n..], W, H, FPS, GOP, opts, cores);
            let _ = handle.join().expect("vt join");
        });
        let both_secs: f64 = started.elapsed().as_secs_f64();
        let both_fps: f64 = n as f64 / both_secs.max(1e-9);
        eprintln!(
            "[HYBRID] concurrent frames={n} elapsed={both_secs:.3}s agg_fps={both_fps:.2} sum_solo={:.2} gain_vs_sw={:.2}x",
            vt_solo + sw_solo,
            both_fps / sw_solo.max(1e-9)
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
    /// Deterministic hybrid validation: builds a stream where every 3rd GOP chunk comes
    /// from VideoToolbox and the rest from the software encoder (encoded in parallel, then
    /// concatenated in sequence order), decodes it back with the pure-Rust decoder and
    /// reports frame count + PSNR/SSIM against the rendered source frames. This is the
    /// gate that decides whether interleaving two encoders produces a valid stream.
    #[test]
    #[ignore = "4K hybrid stream decode/quality validation"]
    fn bench_4k_hybrid_validate() {
        use crate::renderer::encoder::video_vt::VideoVtEncoder;
        use crate::renderer::encoder::VideoFrameEncoder;

        const W: u32 = 3840;
        const H: u32 = 2160;
        const FPS: u32 = 60;
        const FRAMES: usize = 120;
        const GOP: usize = 15;

        fn plane_mse(a: &[u8], b: &[u8]) -> f64 {
            let len: usize = a.len().min(b.len());
            if len == 0 {
                return 0.0;
            }
            let mut sum: f64 = 0.0;
            for i in 0..len {
                let d: f64 = a[i] as f64 - b[i] as f64;
                sum += d * d;
            }
            sum / len as f64
        }

        let cores: usize = std::thread::available_parallelism()
            .map(|c: std::num::NonZeroUsize| c.get())
            .unwrap_or(2);

        let tmp: PathBuf = bench_tmp_dir("my_sekai_bench_4k_hybrid_validate");
        let _ = std::fs::remove_dir_all(&tmp);
        let input: ProjectRenderInput = pg_4k_fixture(&tmp);
        let cfg: VideoExportConfig = VideoExportConfig {
            width: W,
            height: H,
            fps: FPS,
            quality: VideoQualityPreset::Balanced,
            trailing_hold_ms: 0,
            include_audio: false,
            ..Default::default()
        };
        let captured: Vec<YuvFrame> = pg_capture_yuv(&input, &cfg, FRAMES);
        let n: usize = captured.len();
        if n < 32 {
            eprintln!("[HYBRID-V] SKIP only {n} frames captured");
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        let chunks: usize = n.div_ceil(GOP);
        let opts: H264EncoderOptions = H264EncoderOptions {
            quality: VideoQualityPreset::Balanced,
            qp: cfg.resolved_video_qp(),
            bitrate_bps: 0,
            gop_size: GOP as u32,
        };

        // Deterministic assignment: every 3rd chunk goes to the hardware encoder.
        fn is_vt(ci: usize) -> bool {
            ci % 3 == 0
        }
        let vt_chunks: usize = (0..chunks).filter(|ci: &usize| is_vt(*ci)).count();
        eprintln!("[HYBRID-V] frames={n} chunks={chunks} gop={GOP} vt_chunks={vt_chunks} cores={cores}");

        let started: Instant = Instant::now();
        let per_chunk_slot: std::sync::Mutex<Vec<Vec<EncodedVideoPacket>>> =
            std::sync::Mutex::new((0..chunks).map(|_| Vec::new()).collect());
        {
            let per_chunk_mut: &std::sync::Mutex<Vec<Vec<EncodedVideoPacket>>> = &per_chunk_slot;
            let next: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            std::thread::scope(|scope| {
                // Hardware side: one worker, its chunks encoded in order.
                let frames_ref: &[YuvFrame] = &captured;
                let handle = scope.spawn(move || {
                    let mut enc: VideoVtEncoder =
                        VideoVtEncoder::new_with_options(W, H, FPS, opts).expect("vt");
                    for ci in 0..chunks {
                        if !is_vt(ci) {
                            continue;
                        }
                        let start: usize = ci * GOP;
                        let end: usize = (start + GOP).min(frames_ref.len());
                        let mut pkts: Vec<EncodedVideoPacket> = Vec::new();
                        for (k, f) in frames_ref[start..end].iter().enumerate() {
                            let pts: f64 = ((start + k) as f64) / FPS as f64;
                            for p in enc.encode_yuv(f, pts).expect("vt enc") {
                                pkts.push(p);
                            }
                        }
                        for p in enc.finish().expect("vt fin") {
                            pkts.push(p);
                        }
                        per_chunk_mut.lock().expect("hybrid chunk store")[ci] = pkts;
                        enc = VideoVtEncoder::new_with_options(W, H, FPS, opts).expect("vt reinit");
                    }
                });
                // Software side: same shape as the production queue (shared counter).
                let next_ref: &std::sync::atomic::AtomicUsize = &next;
                let frames_ref: &[YuvFrame] = &captured;
                let mut hs: Vec<std::thread::ScopedJoinHandle<()>> = Vec::new();
                for _ in 0..cores {
                    hs.push(scope.spawn(move || {
                        loop {
                            let ci: usize = next_ref
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            if ci >= chunks {
                                break;
                            }
                            if is_vt(ci) {
                                continue;
                            }
                            let start: usize = ci * GOP;
                            let end: usize = (start + GOP).min(frames_ref.len());
                            let pkts: Vec<EncodedVideoPacket> = encode_yuv_gop_chunk(
                                &frames_ref[start..end],
                                start as u64,
                                W,
                                H,
                                FPS,
                                opts,
                            )
                            .expect("sw chunk");
                            per_chunk_mut.lock().expect("hybrid chunk store")[ci] = pkts;
                        }
                    }));
                }
                let _ = handle.join().expect("vt join");
                for h in hs {
                    let _ = h.join().expect("sw join");
                }
            });
        }
        let per_chunk: Vec<Vec<EncodedVideoPacket>> =
            per_chunk_slot.into_inner().expect("hybrid chunks");
        let enc_secs: f64 = started.elapsed().as_secs_f64();
        let agg_fps: f64 = n as f64 / enc_secs.max(1e-9);

        let mut stream: Vec<u8> = Vec::new();
        let mut total_bytes: usize = 0;
        for pkts in per_chunk.iter() {
            for p in pkts {
                total_bytes += p.annex_b.len();
                stream.extend_from_slice(&p.annex_b);
            }
        }

        let mut decoder: rusty_h264_decoder::Decoder = rusty_h264_decoder::Decoder::new();
        let decoded = decoder.decode_stream(&stream).expect("decode hybrid stream");
        let cmp: usize = decoded.len().min(captured.len());
        let mut mse_y: f64 = 0.0;
        let mut mse_u: f64 = 0.0;
        let mut mse_v: f64 = 0.0;
        let mut acc_ssim: f64 = 0.0;
        for i in 0..cmp {
            let orig: &YuvFrame = &captured[i];
            let dec = &decoded[i];
            mse_y += plane_mse(&orig.y, &dec.y);
            mse_u += plane_mse(&orig.u, &dec.u);
            mse_v += plane_mse(&orig.v, &dec.v);
            acc_ssim += pg_ssim_8x8(&orig.y, &dec.y, orig.width as usize, orig.height as usize);
        }
        let denom: f64 = cmp.max(1) as f64;
        let mse_w: f64 = (4.0 * (mse_y / denom) + (mse_u / denom) + (mse_v / denom)) / 6.0;
        eprintln!(
            "[HYBRID-V] encoded agg_fps={agg_fps:.2} bytes={total_bytes} secs={enc_secs:.3}"
        );
        eprintln!(
            "[HYBRID-V] decoded={} of {} psnr_y={:.2} psnr_u={:.2} psnr_v={:.2} psnr_w={:.2} ssim_y={:.4}",
            decoded.len(),
            n,
            pg_psnr_from_mse(mse_y / denom),
            pg_psnr_from_mse(mse_u / denom),
            pg_psnr_from_mse(mse_v / denom),
            pg_psnr_from_mse(mse_w),
            acc_ssim / denom
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
    /// Measures how many consecutive rendered 4K frames are byte-identical, i.e. how much
        /// encode work a duplicate-frame fast path could skip.
        /// Measures read bandwidth of an already-mapped GPU readback buffer and compares the
        /// serial plane copy against scoped-thread variants.
        ///
        /// This isolates the 12.4 MB memcpy from rendering and encoding, so background CPU load
        /// (for example another project's test suite) shifts every variant equally instead of
        /// invalidating the comparison the way a full-pipeline benchmark would.
        #[test]
        #[ignore = "mapped readback copy bandwidth (serial vs parallel)"]
        fn bench_mapped_copy_bandwidth() {
            const W: usize = 3840;
            const H: usize = 2160;
            const REPS: usize = 20;

            fn copy_planes(
                threads: usize,
                s_y: &[u8],
                s_u: &[u8],
                s_v: &[u8],
                d_y: &mut [u8],
                d_u: &mut [u8],
                d_v: &mut [u8],
            ) {
                if threads <= 1 {
                    d_y.copy_from_slice(s_y);
                    d_u.copy_from_slice(s_u);
                    d_v.copy_from_slice(s_v);
                    return;
                }
                let y_jobs: usize = threads.saturating_sub(2).max(1);
                let y_chunk: usize = s_y.len().div_ceil(y_jobs).max(1);
                std::thread::scope(|scope| {
                    for (d, s) in d_y.chunks_mut(y_chunk).zip(s_y.chunks(y_chunk)) {
                        scope.spawn(move || d.copy_from_slice(s));
                    }
                    scope.spawn(move || d_u.copy_from_slice(s_u));
                    scope.spawn(move || d_v.copy_from_slice(s_v));
                });
            }

            let y_bytes: usize = W * H;
            let uv_bytes: usize = (W / 2) * (H / 2);
            let u_off: usize = y_bytes;
            let v_off: usize = y_bytes + uv_bytes;
            let total: usize = y_bytes + 2 * uv_bytes;

            let instance: wgpu::Instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::METAL,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapter: wgpu::Adapter = pollster::block_on(instance.request_adapter(
                &wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                    apply_limit_buckets: false,
                },
            ))
            .expect("no Metal adapter for mapped-copy bench");
            let (device, queue): (wgpu::Device, wgpu::Queue) =
                pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                    .expect("device creation failed");

            let buf: wgpu::Buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("mapped-copy-bench"),
                size: total as u64,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let fill: Vec<u8> = vec![0x5A; total];
            queue.write_buffer(&buf, 0, &fill);

            let slice = buf.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |res: Result<(), wgpu::BufferAsyncError>| {
                let _ = tx.send(res);
            });
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            rx.recv().expect("map callback dropped").expect("map failed");

            let mapped = slice
            .get_mapped_range()
            .expect("mapped range unavailable for copy bench");
            let s_y: &[u8] = &mapped[..y_bytes];
            let s_u: &[u8] = &mapped[u_off..u_off + uv_bytes];
            let s_v: &[u8] = &mapped[v_off..v_off + uv_bytes];

            let mut serial_gbs: f64 = 0.0;
            for threads in [1usize, 2, 3, 5] {
                let mut d_y: Vec<u8> = vec![0u8; y_bytes];
                let mut d_u: Vec<u8> = vec![0u8; uv_bytes];
                let mut d_v: Vec<u8> = vec![0u8; uv_bytes];
                copy_planes(threads, s_y, s_u, s_v, &mut d_y, &mut d_u, &mut d_v);
                let start: std::time::Instant = std::time::Instant::now();
                for _ in 0..REPS {
                    copy_planes(threads, s_y, s_u, s_v, &mut d_y, &mut d_u, &mut d_v);
                    std::hint::black_box(&d_y);
                }
                let secs: f64 = start.elapsed().as_secs_f64().max(1e-9);
                let gbs: f64 = (total as f64 * REPS as f64) / secs / 1e9;
                if threads == 1 {
                    serial_gbs = gbs;
                }
                eprintln!(
                    "[MAPPED COPY] threads={threads} reps={REPS} frame_mb={:.2} per_frame_ms={:.3} gbs={:.2} speedup={:.2}x",
                    (total as f64) / (1024.0 * 1024.0),
                    secs * 1000.0 / REPS as f64,
                    gbs,
                    gbs / serial_gbs.max(1e-9)
                );
            }
        }

        #[test]
        #[ignore = "4K duplicate frame ratio measurement"]
        fn bench_4k_duplicate_frame_ratio() {
            const W: u32 = 3840;
            const H: u32 = 2160;
            const FPS: u32 = 60;
            const FRAMES: usize = 180;

            let tmp: PathBuf = bench_tmp_dir("my_sekai_bench_4k_dup_ratio");
            let _ = std::fs::remove_dir_all(&tmp);
            let input: ProjectRenderInput = pg_4k_fixture(&tmp);
            let cfg: VideoExportConfig = VideoExportConfig {
                width: W,
                height: H,
                fps: FPS,
                quality: bench_quality_preset(),
                trailing_hold_ms: 0,
                include_audio: false,
                ..Default::default()
            };
            let frames: Vec<YuvFrame> = pg_capture_yuv(&input, &cfg, FRAMES);
            let n: usize = frames.len();
            if n < 2 {
                eprintln!("[DUP RATIO] only {n} frames captured");
                let _ = std::fs::remove_dir_all(&tmp);
                return;
            }
            let mut duplicates: usize = 0;
            let mut longest_run: usize = 0;
            let mut run: usize = 0;
            for i in 1..n {
                let a: &YuvFrame = &frames[i - 1];
                let b: &YuvFrame = &frames[i];
                if a.y == b.y && a.u == b.u && a.v == b.v {
                    duplicates += 1;
                    run += 1;
                    longest_run = longest_run.max(run);
                } else {
                    run = 0;
                }
            }
            let ratio: f64 = duplicates as f64 / (n - 1) as f64;
            eprintln!(
                "[DUP RATIO] frames={n} duplicates={duplicates} ratio={:.1}% longest_run={longest_run} frame_bytes={}",
                ratio * 100.0,
                frames[0].y.len() + frames[0].u.len() + frames[0].v.len()
            );
            let _ = std::fs::remove_dir_all(&tmp);
        }




    #[test]
    #[ignore = "4K encode quality gate (PSNR/SSIM/bitrate + 4:2:0 loss floor) benchmark; run with --release -- --ignored --nocapture --test-threads=1"]
    fn bench_4k_psnr_ssim_quality_gate() {
        const W: u32 = 3840;
        const H: u32 = 2160;
        const FPS: u32 = 60;
        const DEFAULT_FRAMES: usize = 60;
        const MIN_FRAMES: usize = 16;
        const MAX_FRAMES: usize = 120;

        let want: usize = std::env::var("PSNR_FRAMES")
            .ok()
            .and_then(|v: String| v.trim().parse::<usize>().ok())
            .map(|v: usize| v.clamp(MIN_FRAMES, MAX_FRAMES))
            .unwrap_or(DEFAULT_FRAMES);

        let n_y: usize = (W as usize) * (H as usize);
        let n_uv: usize = (W as usize / 2) * (H as usize / 2);

        let cores: usize = std::thread::available_parallelism()
            .map(|c: std::num::NonZeroUsize| c.get())
            .unwrap_or(2);

        let tmp: PathBuf = bench_tmp_dir("my_sekai_bench_4k_psnr_gate");
        let _ = std::fs::remove_dir_all(&tmp);
        let input: ProjectRenderInput = pg_4k_fixture(&tmp);

        let base_cfg: VideoExportConfig = VideoExportConfig {
            width: W,
            height: H,
            fps: FPS,
            quality: bench_quality_preset(),
            trailing_hold_ms: 0,
            include_audio: false,
            ..Default::default()
        };
        base_cfg.validate().unwrap();

        // Mirrors `run_parallel_gop_pipeline`: at UHD on a >= 6-core desktop without an explicit
        // `gop_frames`, production caps the per-chunk GOP at 15 frames.
        let is_uhd: bool = (W as u64) * (H as u64) > 1920 * 1080;
        let base_gop: u32 = base_cfg.resolved_gop_frames();
        let chunk_gop: usize =
            if !cfg!(target_os = "android") && base_cfg.gop_frames.is_none() && is_uhd && cores >= 6 {
                (base_gop.max(1) as usize).min(15)
            } else {
                base_gop.max(1) as usize
            };

        eprintln!(
            "[PSNR GATE CONFIG] {W}x{H}@{FPS} frames={want} chunk_gop={chunk_gop} (config gop={base_gop}) cores={cores} bitrate_bps={}",
            base_cfg.resolved_video_bitrate_bps()
        );

        // =========================== LAYER 1: encoder fidelity ===========================
        let started_capture: Instant = Instant::now();
        let captured: Vec<YuvFrame> = pg_capture_yuv(&input, &base_cfg, want);
        let capture_secs: f64 = started_capture.elapsed().as_secs_f64();
        assert!(
            captured.len() >= MIN_FRAMES,
            "captured too few frames: {}",
            captured.len()
        );
        let frames_len: usize = captured.len();
        let duration_secs: f64 = frames_len as f64 / FPS as f64;
        eprintln!(
            "[PSNR GATE CAPTURE] frames={frames_len} elapsed={capture_secs:.3}s duration={duration_secs:.3}s"
        );

        // Measure only the quality level selected via `BENCH_QUALITY` (default `balanced`),
        // so this gate can build a quality-vs-speed table across the shipping levels.
        let selected: VideoQualityPreset = bench_quality_preset();
        let selected_qp: u8 = selected.h264_qp();
        let selected_name: String = std::env::var("BENCH_QUALITY")
            .ok()
            .map(|v: String| v.trim().to_ascii_lowercase())
            .filter(|v: &String| !v.is_empty())
            .unwrap_or_else(|| "balanced".to_string());
        let plan: Vec<(VideoQualityPreset, u8, String)> =
            vec![(selected, selected_qp, format!("{selected_name}-QP{selected_qp}"))];

        for (quality, qp, label) in plan {
            let opts: H264EncoderOptions = H264EncoderOptions {
                quality,
                qp,
                bitrate_bps: base_cfg.resolved_video_bitrate_bps(),
                gop_size: chunk_gop as u32,
            };
            let started_enc: Instant = Instant::now();
            let (stream, encoded_bytes, chunks): (Vec<u8>, usize, usize) =
                pg_encode_annex_b(&captured, W, H, FPS, chunk_gop, opts);
            let enc_secs: f64 = started_enc.elapsed().as_secs_f64();

            let started_dec: Instant = Instant::now();
            let mut decoder: rusty_h264_decoder::Decoder = rusty_h264_decoder::Decoder::new();
            let decoded: Vec<YuvFrame> = decoder
                .decode_stream(&stream)
                .expect("4K H.264 decode succeeds");
            let dec_secs: f64 = started_dec.elapsed().as_secs_f64();
            assert_eq!(
                decoded.len(),
                frames_len,
                "decoded frame count must equal the encoder input frame count"
            );

            let mut sse_y: u64 = 0;
            let mut sse_u: u64 = 0;
            let mut sse_v: u64 = 0;
            let mut ssim_y_sum: f64 = 0.0;
            let mut ssim_y_min: f64 = f64::INFINITY;
            let mut worst_y_psnr: f64 = f64::INFINITY;
            let mut worst_y_frame: usize = 0;
            for i in 0..frames_len {
                let orig: &YuvFrame = &captured[i];
                let dec: &YuvFrame = &decoded[i];
                assert_eq!(orig.width, dec.width, "decoded width mismatch at {i}");
                assert_eq!(orig.height, dec.height, "decoded height mismatch at {i}");
                let fse_y: u64 = pg_plane_sse(&orig.y, &dec.y);
                let fse_u: u64 = pg_plane_sse(&orig.u, &dec.u);
                let fse_v: u64 = pg_plane_sse(&orig.v, &dec.v);
                sse_y += fse_y;
                sse_u += fse_u;
                sse_v += fse_v;
                let frame_psnr_y: f64 = pg_psnr_from_sse(fse_y, orig.y.len());
                if frame_psnr_y < worst_y_psnr {
                    worst_y_psnr = frame_psnr_y;
                    worst_y_frame = i;
                }
                let fssim: f64 = pg_ssim_8x8(&orig.y, &dec.y, orig.width, orig.height);
                ssim_y_sum += fssim;
                if fssim < ssim_y_min {
                    ssim_y_min = fssim;
                }
            }

            let total_y: usize = n_y * frames_len;
            let total_uv: usize = n_uv * frames_len;
            let mse_y: f64 = sse_y as f64 / total_y as f64;
            let mse_u: f64 = sse_u as f64 / total_uv as f64;
            let mse_v: f64 = sse_v as f64 / total_uv as f64;
            let weighted_mse: f64 = (n_y as f64 * mse_y
                + n_uv as f64 * mse_u
                + n_uv as f64 * mse_v)
                / ((n_y + 2 * n_uv) as f64);
            let bitrate_bps: f64 = (encoded_bytes as f64) * 8.0 / duration_secs;

            eprintln!(
                "[PSNR GATE L1 {label}] qp={qp} frames={frames_len} chunks={chunks} bytes={encoded_bytes} bitrate_bps={bitrate_bps:.0} bitrate_kbps={:.1} bitrate_Mbps={:.3} mb_per_sec={:.3}",
                bitrate_bps / 1000.0,
                bitrate_bps / 1_000_000.0,
                (encoded_bytes as f64 / 1_000_000.0) / duration_secs
            );
            eprintln!(
                "[PSNR GATE L1 {label}] psnr_y={:.3} psnr_u={:.3} psnr_v={:.3} psnr_weighted_420={:.3} ssim_y={:.5} ssim_y_min_frame={:.5} worst_frame_psnr_y={:.3} (@frame {worst_y_frame})",
                pg_psnr_from_mse(mse_y),
                pg_psnr_from_mse(mse_u),
                pg_psnr_from_mse(mse_v),
                pg_psnr_from_mse(weighted_mse),
                ssim_y_sum / frames_len as f64,
                ssim_y_min,
                worst_y_psnr
            );
            eprintln!(
                "[PSNR GATE L1 {label}] encode_secs={enc_secs:.3} decode_secs={dec_secs:.3} stream_bytes={}",
                stream.len()
            );
        }

        // ======================= LAYER 2: 4:2:0 structural loss floor =======================
        // A real rendered RGBA frame is the ground truth. Pushing it through the production
        // `rgba_to_yuv420p_bt709` (which box-averages chroma over each 2x2 footprint) and
        // upsampling back yields the loss that 4:2:0 itself inflicts, before any H.264 coding.
        {
            let seed: u64 = base_cfg.resolve_seed();
            let scene_cfg: VideoExportConfig = base_cfg.clone();
            let mut scene: StorySceneState<'_> =
                StorySceneState::new(&input, &scene_cfg, seed).expect("4K scene init for layer 2");
            let mut runner: StoryRunner = StoryRunner::new(input.story.clone());
            runner.initialize(&mut scene).expect("runner initialize");

            let frame_dt: f64 = 1000.0 / FPS as f64;
            let max_scan: usize = (want * 4).max(64);

            let mut used: usize = 0;
            let mut scanned: usize = 0;

            // Per-upsampler accumulators: [0] replicate, [1] bilinear.
            let mut sse_y: [u64; 2] = [0; 2];
            let mut sse_u: [u64; 2] = [0; 2];
            let mut sse_v: [u64; 2] = [0; 2];
            let mut sse_r: [u64; 2] = [0; 2];
            let mut sse_g: [u64; 2] = [0; 2];
            let mut sse_b: [u64; 2] = [0; 2];
            let mut ssim_y_sum: f64 = 0.0;
            let mut ssim_y_sum_bi: f64 = 0.0;
            let mut content_std_sum: f64 = 0.0;

            let started_l2: Instant = Instant::now();
            while used < want && scanned < max_scan {
                let rgba: Vec<u8> = scene
                    .render_current_frame()
                    .expect("4K RGBA render for layer 2");
                assert!(
                    rgba.len() >= n_y * 4,
                    "layer-2 RGBA buffer too small: {}",
                    rgba.len()
                );
                scanned += 1;

                let (y444, u444, v444): (Vec<u8>, Vec<u8>, Vec<u8>) =
                    pg_yuv444_from_rgba_bt709(&rgba, W as usize, H as usize);

                // Skip frames that carry no content yet (layout fade-in / background only): a flat
                // frame would report a flattering PSNR and bias the loss floor.
                let std_y: f64 = pg_sampled_std(&y444, n_y, 16);
                if std_y < 6.0 {
                    runner.step_frame(frame_dt, &mut scene).expect("step");
                    continue;
                }
                content_std_sum += std_y;

                let cw: usize = W as usize / 2;
                let ch: usize = H as usize / 2;
                let mut y420: Vec<u8> = Vec::new();
                let mut u420: Vec<u8> = Vec::new();
                let mut v420: Vec<u8> = Vec::new();
                crate::renderer::encoder::rgba_to_yuv420p_bt709(
                    &rgba,
                    W as usize,
                    H as usize,
                    &mut y420,
                    &mut u420,
                    &mut v420,
                );

                for mode in 0..2usize {
                    let bilinear: bool = mode == 1;
                    let u_full: Vec<u8> =
                        pg_upsample_chroma(&u420, cw, ch, W as usize, H as usize, bilinear);
                    let v_full: Vec<u8> =
                        pg_upsample_chroma(&v420, cw, ch, W as usize, H as usize, bilinear);
                    sse_y[mode] += pg_plane_sse(&y444, &y420);
                    sse_u[mode] += pg_plane_sse(&u444, &u_full);
                    sse_v[mode] += pg_plane_sse(&v444, &v_full);

                    let rgb_rt: Vec<u8> =
                        pg_rgba_from_yuv444(&y420, &u_full, &v_full, n_y);
                    sse_r[mode] += pg_channel_sse(&rgba, &rgb_rt, 0, 4);
                    sse_g[mode] += pg_channel_sse(&rgba, &rgb_rt, 1, 4);
                    sse_b[mode] += pg_channel_sse(&rgba, &rgb_rt, 2, 4);

                    if mode == 0 {
                        ssim_y_sum += pg_ssim_8x8(&y444, &y420, W as usize, H as usize);
                    } else {
                        ssim_y_sum_bi += pg_ssim_8x8(&y444, &y420, W as usize, H as usize);
                    }
                }

                used += 1;
                runner.step_frame(frame_dt, &mut scene).expect("step");
            }
            let l2_secs: f64 = started_l2.elapsed().as_secs_f64();

            assert!(
                used >= MIN_FRAMES / 2,
                "layer 2 measured too few content frames: {used} (scanned {scanned})"
            );

            let total_y: usize = n_y * used;
            let total_uv: usize = n_uv * used;
            for mode in 0..2usize {
                let mode_label: &str = if mode == 1 { "bilinear" } else { "replicate" };
                let mse_y: f64 = sse_y[mode] as f64 / total_y as f64;
                let mse_u: f64 = sse_u[mode] as f64 / total_uv as f64;
                let mse_v: f64 = sse_v[mode] as f64 / total_uv as f64;
                let weighted_mse: f64 = (n_y as f64 * mse_y
                    + n_uv as f64 * mse_u
                    + n_uv as f64 * mse_v)
                    / ((n_y + 2 * n_uv) as f64);
                eprintln!(
                    "[PSNR GATE L2 {mode_label}] frames={used} scanned={scanned} psnr_y={:.3} psnr_u={:.3} psnr_v={:.3} psnr_weighted_420={:.3} ssim_y={:.5}",
                    pg_psnr_from_mse(mse_y),
                    pg_psnr_from_mse(mse_u),
                    pg_psnr_from_mse(mse_v),
                    pg_psnr_from_mse(weighted_mse),
                    if mode == 0 {
                        ssim_y_sum / used as f64
                    } else {
                        ssim_y_sum_bi / used as f64
                    }
                );
                eprintln!(
                    "[PSNR GATE L2 {mode_label}] rgb_roundtrip psnr_r={:.3} psnr_g={:.3} psnr_b={:.3} psnr_rgb_weighted={:.3}",
                    pg_psnr_from_sse(sse_r[mode], n_y * used),
                    pg_psnr_from_sse(sse_g[mode], n_y * used),
                    pg_psnr_from_sse(sse_b[mode], n_y * used),
                    pg_psnr_from_mse(
                        (sse_r[mode] + sse_g[mode] + sse_b[mode]) as f64
                            / (3 * n_y * used) as f64
                    )
                );
            }
            eprintln!(
                "[PSNR GATE L2 SUMMARY] frames_used={used} frames_scanned={scanned} mean_luma_std={:.2} elapsed={l2_secs:.3}s",
                content_std_sum / used as f64
            );
            drop(runner);
            drop(scene);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
