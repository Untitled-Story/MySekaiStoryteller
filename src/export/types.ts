export type ResolutionPresetId = '720p' | '1080p' | '2k' | '4k' | 'custom'

export type VideoContainerFormat = 'mp4' | 'webm' | 'mov'

export type ExportVideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores'

export type ExportAudioCodec = 'aac' | 'opus' | 'pcm_s16le'

export type ExportEngineMode = 'auto' | 'webcodecs' | 'ffmpeg'

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
