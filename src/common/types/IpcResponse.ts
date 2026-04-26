import { StoryData } from './Story'

export interface SelectStoryResponse {
  success: boolean
  path?: string
  data?: StoryData
  zodIssueMessage?: string
  error?: unknown
}

export interface LoadStoryFromPathResponse {
  success: boolean
  path?: string
  data?: StoryData
  error?: unknown
}

export interface CliArgs {
  storyFile: string
  outputDir: string
  outputFile: string
  width: number
  height: number
  fps: number
  quality: number
  exit: boolean
  headless: boolean
}

export interface CliProgressState {
  phase: string
  message?: string
  frameIndex?: number
  totalFrameCount?: number
  percent?: number
  speed?: number
  targetFps?: number
  elapsedRenderMs?: number
  etaMs?: number | null
  ffmpegPercent?: number
  outputDir?: string | null
  outputFile?: string | null
}
