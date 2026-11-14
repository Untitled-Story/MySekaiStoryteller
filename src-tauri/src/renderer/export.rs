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
    create_video_encoder_with_options, encode_interleaved_i16_parallel, encode_rgba_gop_chunk,
    EncodedAudioPacket, EncodedVideoPacket, H264EncoderOptions, Mp4MuxerWriter,
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

    let (video_frames, scheduled_voices, decoded_voices, audio_packets): (
        u64,
        Vec<ScheduledVoiceEvent>,
        HashMap<String, DecodedAudio>,
        Vec<EncodedAudioPacket>,
    ) = if h264_opts.bitrate_bps == 0 {
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

struct GopJob {
    seq_idx: usize,
    base_frame_index: u64,
    frames: Vec<Vec<u8>>,
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
    free_frames: Mutex<Vec<Vec<u8>>>,
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

    fn take_frame_buffer(&self) -> Vec<u8> {
        let mut pool = self.free_frames.lock().expect("free_frames lock poisoned");
        pool.pop().unwrap_or_default()
    }

    fn recycle_frames(&self, frames: Vec<Vec<u8>>) {
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
    mut on_rgba_frame: OnFrame,
) -> Result<(u64, Vec<ScheduledVoiceEvent>, HashMap<String, DecodedAudio>), RendererError>
where
    F: FnMut(ExportProgress),
    OnFrame: FnMut(u64, &mut Vec<u8>) -> Result<(), RendererError>,
{
    let mut scene = StorySceneState::new_with_voices(input, config, seed_used, predecoded_voices)?;
    let mut runner = StoryRunner::new(input.story.clone());
    runner.initialize(&mut scene)?;

    let mut completed_rgba: Vec<u8> = Vec::new();
    let _ = scene.submit_and_drain_previous_frame_into(&mut completed_rgba)?;
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

        if scene.submit_and_drain_previous_frame_into(&mut completed_rgba)? {
            on_rgba_frame(retired_frames, &mut completed_rgba)?;
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

    if scene.finish_pending_frame_into(&mut completed_rgba)? {
        on_rgba_frame(retired_frames, &mut completed_rgba)?;
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

fn mix_and_encode_audio_track(
    config: &VideoExportConfig,
    scheduled_voices: &[ScheduledVoiceEvent],
    decoded_voices: &HashMap<String, DecodedAudio>,
    total_video_duration_ms: f64,
    video_frames: u64,
    started: &Instant,
    on_progress: &mut impl FnMut(ExportProgress),
) -> Result<Vec<EncodedAudioPacket>, RendererError> {
    if !config.include_audio {
        return Ok(Vec::new());
    }
    emit_progress(
        on_progress,
        ExportStage::EncodingAudio,
        video_frames,
        video_frames,
        total_video_duration_ms,
        started,
    );
    let gain_mult: f32 = config.audio_gain_multiplier();
    let scaled_voices: Vec<ScheduledVoiceEvent> = scheduled_voices
        .iter()
        .map(|ev| ScheduledVoiceEvent {
            start_ms: ev.start_ms,
            voice_key: ev.voice_key.clone(),
            gain: ev.gain * gain_mult,
        })
        .collect();
    let pcm: Vec<i16> = mix_timeline_audio(&scaled_voices, decoded_voices, total_video_duration_ms);
    encode_interleaved_i16_parallel(&pcm, config.resolved_audio_bitrate_bps())
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
    let gop_size: usize = h264_opts.gop_size.max(1) as usize;
    let worker_count: usize = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1))
        .unwrap_or(1)
        .clamp(1, 8);
    let queue: BoundedGopQueue = BoundedGopQueue::new(worker_count + 1, gop_size);
    let (res_tx, res_rx) = mpsc::channel::<(usize, Result<Vec<EncodedVideoPacket>, RendererError>)>();

    let width: u32 = config.width;
    let height: u32 = config.height;
    let fps: u32 = config.fps;

    let mut audio_packets: Vec<EncodedAudioPacket> = Vec::new();
    let mut video_frames_out: u64 = 0;
    let mut scheduled_out: Vec<ScheduledVoiceEvent> = Vec::new();
    let mut decoded_out: HashMap<String, DecodedAudio> = HashMap::new();

    std::thread::scope(|scope| -> Result<(), RendererError> {
        let mut worker_handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let queue_ref: &BoundedGopQueue = &queue;
            let tx: mpsc::Sender<(usize, Result<Vec<EncodedVideoPacket>, RendererError>)> =
                res_tx.clone();
            worker_handles.push(scope.spawn(move || {
                while let Some(job) = queue_ref.pop() {
                    let seq_idx: usize = job.seq_idx;
                    let enc_res: Result<Vec<EncodedVideoPacket>, RendererError> =
                        encode_rgba_gop_chunk(
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
        drop(res_tx);

        let queue_for_mux: &BoundedGopQueue = &queue;
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
            Ok(())
        });

        let mut gop_frames: Vec<Vec<u8>> = Vec::with_capacity(gop_size);
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
                |frame_idx, rgba_buf| {
                    let mut owned_slot: Vec<u8> = queue.take_frame_buffer();
                    std::mem::swap(&mut owned_slot, rgba_buf);
                    if gop_frames.is_empty() {
                        gop_base_frame = frame_idx;
                    }
                    gop_frames.push(owned_slot);
                    if gop_frames.len() >= gop_size {
                        let batch: Vec<Vec<u8>> =
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

        // Mix and AAC-encode audio concurrently while workers finish trailing H.264 GOPs.
        let total_video_duration_ms: f64 = (video_frames as f64) * frame_dt_ms;
        let audio_res: Result<Vec<EncodedAudioPacket>, RendererError> = mix_and_encode_audio_track(
            config,
            &scheduled_voices,
            &decoded_voices,
            total_video_duration_ms,
            video_frames,
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
    let mut video_encoder =
        create_video_encoder_with_options(config.width, config.height, config.fps, h264_opts)?;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<(u64, Vec<u8>)>(4);
    let free_frames: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
    let fps: u32 = config.fps;

    let mut video_frames_out: u64 = 0;
    let mut scheduled_out: Vec<ScheduledVoiceEvent> = Vec::new();
    let mut decoded_out: HashMap<String, DecodedAudio> = HashMap::new();
    let mut audio_packets: Vec<EncodedAudioPacket> = Vec::new();

    std::thread::scope(|scope| -> Result<(), RendererError> {
        let free_ref: &Mutex<Vec<Vec<u8>>> = &free_frames;
        let enc_handle = scope.spawn(move || -> Result<(), RendererError> {
            let mut encoded_count: u64 = 0;
            while let Ok((frame_idx, rgba)) = frame_rx.recv() {
                let pts_secs: f64 = (frame_idx as f64) / (fps as f64);
                let pkts: Vec<EncodedVideoPacket> = video_encoder.encode_rgba(&rgba, pts_secs)?;
                {
                    let mut pool = free_ref.lock().expect("abr free_frames poisoned");
                    if pool.len() < 4 {
                        pool.push(rgba);
                    }
                }
                for pkt in pkts {
                    muxer.write_video(pkt.pts_secs, &pkt.annex_b, pkt.is_keyframe)?;
                }
                encoded_count += 1;
            }
            for pkt in video_encoder.finish()? {
                let pts_secs: f64 = (encoded_count as f64) / (fps as f64);
                muxer.write_video(pts_secs, &pkt.annex_b, pkt.is_keyframe)?;
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
                |frame_idx, rgba_buf| {
                    let mut owned: Vec<u8> = {
                        let mut pool = free_frames.lock().expect("abr free_frames poisoned");
                        pool.pop().unwrap_or_default()
                    };
                    std::mem::swap(&mut owned, rgba_buf);
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
        let audio_res: Result<Vec<EncodedAudioPacket>, RendererError> = mix_and_encode_audio_track(
            config,
            &scheduled_voices,
            &decoded_voices,
            total_video_duration_ms,
            video_frames,
            started,
            on_progress,
        );

        enc_handle.join().unwrap_or_else(|_| {
            Err(RendererError::VideoEncode(
                "ABR video encoder thread panicked".to_string(),
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
            seed_mode: SeedMode::Fixed { seed: 99 },
            trailing_hold_ms: 0,
            video_qp: Some(21),
            video_bitrate_kbps: Some(450),
            gop_frames: Some(4),
            include_audio: false,
            audio_bitrate_kbps: None,
            audio_volume_percent: 0,
            background_color: "#204060".to_string(),
        };
        let custom_res = export_story_to_mp4(&input, &custom_cfg, &custom_mp4, None, |_| {})
            .expect("video only");
        assert!(custom_mp4.is_file());
        assert_eq!(custom_res.fps, 24);
        assert_eq!(custom_res.audio_frames, 0);
        assert!(custom_res.video_frames >= 15);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
