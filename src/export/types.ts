export type ResolutionPresetId = '720p' | '1080p' | '2k' | '4k' | 'custom'

export type VideoContainerFormat = 'mp4' | 'webm' | 'mov'

export type ExportVideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores'

export type ExportAudioCodec = 'aac' | 'opus' | 'pcm_s16le'

export type ExportEngineMode = 'auto' | 'webcodecs' | 'ffmpeg'

/**
 * 渲染质量档位：直接决定导出帧的色度采样率，是「画质 vs 速度」的总开关。
 * - speed    4:2:0  NV12  11.87 MB/帧 @4K，色度 V 平面约 35.95 dB
 * - balanced 4:2:2  NV16  16.59 MB/帧 @4K，色度 V 平面约 38.33 dB
 * - quality  4:4:4  RGBA  33.18 MB/帧 @4K，色度无损
 * 帧率与每帧字节数近似成反比（Tauri IPC 约 0.9~1.5 GB/s 是主要瓶颈）。
 */
export type RenderQuality = 'speed' | 'balanced' | 'quality'

/** 打包器实际输出的像素排布 */
export type ChromaMode = '420' | '422' | '444' | '444p'

export type ResolutionPreset = {
  id: Exclude<ResolutionPresetId, 'custom'>
  width: number
  height: number
}

export type VideoExportConfig = {
  presetId: ResolutionPresetId
  width: number
  height: number
  fps: number
  container: VideoContainerFormat
  videoCodec: ExportVideoCodec
  audioCodec: ExportAudioCodec
  engineMode: ExportEngineMode
  bitrateMbps: number
  crf: number
  hardwareAccel: boolean
  transparentAlpha: boolean
  /** 未设置时按 'quality' 处理，保持与既有行为一致（不静默降质） */
  renderQuality?: RenderQuality
  memorySizeMb: number
  ffmpegPath?: string
}

export type FfmpegCapabilities = {
  available: boolean
  executablePath: string | null
  version: string | null
  customPathInvalid: boolean
  hardwareEncoders: string[]
  softwareEncoders: string[]
}

export type StartExportResponse = {
  sessionId: string
  selectedEncoder: string | null
  expectedFrameBytes: number
}

export type FinishExportResponse = {
  outputPath: string
  fileSizeBytes: number
}

export type ExportAudioEvent = {
  voiceKey: string
  voiceUrl: string
  startMs: number
  maxDurationMs: number
  volume: number
}

export type VideoExportPhase =
  | 'preparing'
  | 'rendering'
  | 'encodingAudio'
  | 'muxing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type VideoExportProgress = {
  phase: VideoExportPhase
  renderedFrames: number
  estimatedTotalFrames: number
  virtualTimeMs: number
  elapsedMs: number
  renderElapsedMs: number
  fpsSpeed: number
  etaMs: number | null
  detail?: string
}

export type VideoExportResult = {
  outputPath: string
  fileSizeBytes: number
  totalFrames: number
  durationMs: number
  engineUsed: 'webcodecs' | 'ffmpeg'
  selectedEncoder: string | null
}
