export interface RenderAudioEvent {
  voice: string
  startTimeMs: number
  durationMs: number
  speaker?: string
  content?: string
}

export interface ProbeStoryVoiceDurationsPayload {
  storyPath: string
  voices: string[]
}

export interface ProbeStoryVoiceDurationsResponse {
  durations: Record<string, number>
}

export interface FinishFrameExportPayload {
  frameCount: number
  fps: number
  totalDurationMs: number
  audioEvents: RenderAudioEvent[]
}

export interface FinishFrameExportResponse {
  outputDir: string | null
  frameCount: number
  videoPath: string | null
}

export interface FrameExportProgressPayload {
  phase: 'merging'
  percent: number
  message?: string
}
