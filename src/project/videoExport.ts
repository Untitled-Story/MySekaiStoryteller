import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { z } from 'zod'
import { runLoggedOperation } from '@/lib/logger'
import type { StoryData } from '@/story/schema'

export const VIDEO_EXPORT_PROGRESS_EVENT: string = 'video-export-progress'
export const VIDEO_EXPORT_CANCELLED_CODE: string = 'VIDEO_EXPORT_CANCELLED'

export const MIN_EXPORT_WIDTH: number = 16
export const MIN_EXPORT_HEIGHT: number = 16
export const MAX_EXPORT_WIDTH: number = 3840
export const MAX_EXPORT_HEIGHT: number = 2160
export const MIN_EXPORT_FPS: number = 1
export const MAX_EXPORT_FPS: number = 120
export const MAX_TRAILING_HOLD_MS: number = 30000
export const MAX_VIDEO_QP: number = 51
export const MIN_VIDEO_BITRATE_KBPS: number = 100
export const MAX_VIDEO_BITRATE_KBPS: number = 100000
export const MIN_GOP_FRAMES: number = 1
export const MAX_GOP_FRAMES: number = 600
export const MIN_AUDIO_BITRATE_KBPS: number = 32
export const MAX_AUDIO_BITRATE_KBPS: number = 512
export const MAX_AUDIO_VOLUME_PERCENT: number = 200
export const DEFAULT_VIDEO_SEED: number = 20260001
export const DEFAULT_BACKGROUND_COLOR: string = '#000000'

const HEX_COLOR_RE: RegExp = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

export const VideoQualityPresetSchema = z.enum(['fast', 'balanced', 'quality'])
export type VideoQualityPreset = z.infer<typeof VideoQualityPresetSchema>

export const RenderBackendSchema = z.enum(['auto', 'metal', 'vulkan', 'cuda', 'dx12', 'gl', 'cpu'])
export type RenderBackend = z.infer<typeof RenderBackendSchema>

export const GpuBackendInfoSchema = z.object({
  backend: RenderBackendSchema,
  wgpuBackend: z.string(),
  adapterName: z.string(),
  deviceType: z.string(),
  vendorId: z.number().int().nonnegative(),
  supportsCompute: z.boolean(),
  supportsHwVideoEncoder: z.boolean()
})
export type GpuBackendInfo = z.infer<typeof GpuBackendInfoSchema>

export const VideoSeedModeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('fixed'),
    seed: z.number().int().nonnegative()
  }),
  z.object({
    mode: z.literal('random')
  })
])
export type VideoSeedMode = z.infer<typeof VideoSeedModeSchema>

export const VideoExportConfigSchema = z.object({
  width: z.number().int().min(MIN_EXPORT_WIDTH).max(MAX_EXPORT_WIDTH),
  height: z.number().int().min(MIN_EXPORT_HEIGHT).max(MAX_EXPORT_HEIGHT),
  fps: z.number().int().min(MIN_EXPORT_FPS).max(MAX_EXPORT_FPS),
  quality: VideoQualityPresetSchema,
  seedMode: VideoSeedModeSchema,
  trailingHoldMs: z.number().int().min(0).max(MAX_TRAILING_HOLD_MS),
  videoQp: z.number().int().min(0).max(MAX_VIDEO_QP).nullable().optional(),
  videoBitrateKbps: z
    .number()
    .int()
    .min(MIN_VIDEO_BITRATE_KBPS)
    .max(MAX_VIDEO_BITRATE_KBPS)
    .nullable()
    .optional(),
  gopFrames: z.number().int().min(MIN_GOP_FRAMES).max(MAX_GOP_FRAMES).nullable().optional(),
  includeAudio: z.boolean(),
  audioBitrateKbps: z
    .number()
    .int()
    .min(MIN_AUDIO_BITRATE_KBPS)
    .max(MAX_AUDIO_BITRATE_KBPS)
    .nullable()
    .optional(),
  audioVolumePercent: z.number().int().min(0).max(MAX_AUDIO_VOLUME_PERCENT),
  backgroundColor: z.string().regex(HEX_COLOR_RE),
  renderBackend: RenderBackendSchema.default('auto')
})
export type VideoExportConfig = z.infer<typeof VideoExportConfigSchema>

export const VideoExportStageSchema = z.enum([
  'preparing',
  'rendering',
  'encodingAudio',
  'muxing',
  'completed'
])
export type VideoExportStage = z.infer<typeof VideoExportStageSchema>

export const VideoExportProgressSchema = z.object({
  stage: VideoExportStageSchema,
  renderedFrames: z.number().int().nonnegative(),
  estimatedTotalFrames: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  fpsActual: z.number().nonnegative()
})
export type VideoExportProgress = z.infer<typeof VideoExportProgressSchema>

export const VideoExportResultSchema = z.object({
  outputPath: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  videoFrames: z.number().int().nonnegative(),
  audioFrames: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  seedUsed: z.number().nonnegative()
})
export type VideoExportResult = z.infer<typeof VideoExportResultSchema>

export type VideoResolutionPresetId =
  | '2160p'
  | '1440p'
  | '1080p'
  | '720p'
  | '480p'
  | 'portrait1080'
  | 'custom'

export type VideoResolutionPreset = {
  id: Exclude<VideoResolutionPresetId, 'custom'>
  width: number
  height: number
}

export const VIDEO_RESOLUTION_PRESETS: readonly VideoResolutionPreset[] = [
  { id: '2160p', width: 3840, height: 2160 },
  { id: '1440p', width: 2560, height: 1440 },
  { id: '1080p', width: 1920, height: 1080 },
  { id: '720p', width: 1280, height: 720 },
  { id: '480p', width: 854, height: 480 },
  { id: 'portrait1080', width: 1080, height: 1920 }
]

export const VIDEO_FPS_OPTIONS: readonly number[] = [24, 25, 30, 48, 50, 60, 90, 120]

export const AUDIO_BITRATE_OPTIONS: readonly number[] = [64, 96, 128, 192, 256, 320]

export type VideoRateControlMode = 'preset' | 'cqp' | 'abr'

export const DEFAULT_VIDEO_EXPORT_CONFIG: VideoExportConfig = {
  width: 1920,
  height: 1080,
  fps: 60,
  quality: 'balanced',
  seedMode: {
    mode: 'fixed',
    seed: DEFAULT_VIDEO_SEED
  },
  trailingHoldMs: 500,
  videoQp: null,
  videoBitrateKbps: null,
  gopFrames: null,
  includeAudio: true,
  audioBitrateKbps: null,
  audioVolumePercent: 100,
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  renderBackend: 'auto'
}

export function validateVideoDimensions(width: number, height: number): 'ok' | 'invalid' | 'odd' {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_EXPORT_WIDTH ||
    height < MIN_EXPORT_HEIGHT ||
    width > MAX_EXPORT_WIDTH ||
    height > MAX_EXPORT_HEIGHT
  ) {
    return 'invalid'
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    return 'odd'
  }
  return 'ok'
}

export function validateExportFps(fps: number): boolean {
  return Number.isInteger(fps) && fps >= MIN_EXPORT_FPS && fps <= MAX_EXPORT_FPS
}

export function isValidExportHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value.trim())
}

export function generateRandomExportSeed(): number {
  const buf: Uint32Array = new Uint32Array(1)
  globalThis.crypto.getRandomValues(buf)
  return buf[0]
}

export function sanitizeVideoFileName(title: string): string {
  const cleaned: string = title.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'video'
}

export function isVideoExportCancelledError(error: unknown): boolean {
  const message: string = error instanceof Error ? error.message : String(error)
  return message.includes(VIDEO_EXPORT_CANCELLED_CODE)
}

export async function exportProjectVideo(params: {
  projectName: string
  destinationPath: string
  config: VideoExportConfig
  storyOverride?: StoryData | null
}): Promise<VideoExportResult> {
  const parsedConfig: VideoExportConfig = VideoExportConfigSchema.parse(params.config)
  return runLoggedOperation(
    'project.exportVideo',
    {
      projectName: params.projectName,
      width: parsedConfig.width,
      height: parsedConfig.height,
      fps: parsedConfig.fps,
      quality: parsedConfig.quality,
      renderBackend: parsedConfig.renderBackend,
      includeAudio: parsedConfig.includeAudio
    },
    async (): Promise<VideoExportResult> => {
      const raw: unknown = await invoke<unknown>('export_project_video', {
        projectName: params.projectName,
        destinationPath: params.destinationPath,
        config: parsedConfig,
        storyOverride: params.storyOverride ?? null
      })
      return VideoExportResultSchema.parse(raw)
    }
  )
}

export function cancelVideoExport(): Promise<boolean> {
  return invoke<boolean>('cancel_video_export')
}

export async function getAvailableRenderBackends(): Promise<GpuBackendInfo[]> {
  const raw: unknown = await invoke<unknown>('get_available_render_backends')
  return z.array(GpuBackendInfoSchema).parse(raw)
}

export function listenVideoExportProgress(
  handler: (progress: VideoExportProgress) => void
): Promise<UnlistenFn> {
  return listen<unknown>(VIDEO_EXPORT_PROGRESS_EVENT, (event): void => {
    const parsed = VideoExportProgressSchema.safeParse(event.payload)
    if (parsed.success) {
      handler(parsed.data)
    }
  })
}
