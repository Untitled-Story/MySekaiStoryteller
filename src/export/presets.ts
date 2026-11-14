import type {
  ExportAudioCodec,
  ExportVideoCodec,
  ResolutionPreset,
  VideoContainerFormat,
  VideoExportConfig
} from './types'

export const LOGICAL_STAGE_WIDTH: number = 1920
export const LOGICAL_STAGE_HEIGHT: number = 1080
export const MIN_EXPORT_WIDTH: number = 320
export const MAX_EXPORT_WIDTH: number = 7680
export const MIN_EXPORT_HEIGHT: number = 240
export const MAX_EXPORT_HEIGHT: number = 4320
export const MIN_EXPORT_FPS: number = 1
export const MAX_EXPORT_FPS: number = 240
export const MAX_SUBSTEP_MS: number = 1000 / 60

export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { id: '720p', width: 1280, height: 720 },
  { id: '1080p', width: 1920, height: 1080 },
  { id: '2k', width: 2560, height: 1440 },
  { id: '4k', width: 3840, height: 2160 }
]

export const FPS_PRESETS: readonly number[] = [24, 30, 60, 120]

export const CONTAINER_VIDEO_CODECS: Record<VideoContainerFormat, readonly ExportVideoCodec[]> = {
  mp4: ['h264', 'hevc', 'av1'],
  webm: ['vp9', 'av1'],
  mov: ['hevc', 'h264', 'prores']
}

export const CONTAINER_AUDIO_CODECS: Record<VideoContainerFormat, readonly ExportAudioCodec[]> = {
  mp4: ['aac', 'opus'],
  webm: ['opus'],
  mov: ['aac', 'pcm_s16le']
}

export type StageFitLayout = {
  logicalWidth: number
  logicalHeight: number
  rendererResolution: number
  renderedWidth: number
  renderedHeight: number
  directMatch: boolean
  offsetX: number
  offsetY: number
}

export function normalizeEvenDimension(value: number, min: number, max: number): number {
  const finite: number = Number.isFinite(value) ? value : min
  const clamped: number = Math.min(max, Math.max(min, Math.round(finite)))
  const even: number = clamped - (clamped % 2)
  return even < min ? min + (min % 2) : even
}

export function normalizeExportFps(value: number): number {
  const finite: number = Number.isFinite(value) ? value : 60
  return Math.min(MAX_EXPORT_FPS, Math.max(MIN_EXPORT_FPS, Math.round(finite * 1000) / 1000))
}

export function computeStageFitLayout(targetWidth: number, targetHeight: number): StageFitLayout {
  const safeWidth: number = normalizeEvenDimension(targetWidth, MIN_EXPORT_WIDTH, MAX_EXPORT_WIDTH)
  const safeHeight: number = normalizeEvenDimension(
    targetHeight,
    MIN_EXPORT_HEIGHT,
    MAX_EXPORT_HEIGHT
  )
  const rendererResolution: number = Math.min(
    safeWidth / LOGICAL_STAGE_WIDTH,
    safeHeight / LOGICAL_STAGE_HEIGHT
  )
  const renderedWidth: number = Math.round(LOGICAL_STAGE_WIDTH * rendererResolution)
  const renderedHeight: number = Math.round(LOGICAL_STAGE_HEIGHT * rendererResolution)
  const directMatch: boolean = renderedWidth === safeWidth && renderedHeight === safeHeight

  return {
    logicalWidth: LOGICAL_STAGE_WIDTH,
    logicalHeight: LOGICAL_STAGE_HEIGHT,
    rendererResolution,
    renderedWidth,
    renderedHeight,
    directMatch,
    offsetX: Math.floor((safeWidth - renderedWidth) / 2),
    offsetY: Math.floor((safeHeight - renderedHeight) / 2)
  }
}

export function computeRecommendedBitrateMbps(
  width: number,
  height: number,
  fps: number,
  codec: ExportVideoCodec
): number {
  const pixelRatio: number = (width * height) / (LOGICAL_STAGE_WIDTH * LOGICAL_STAGE_HEIGHT)
  const fpsRatio: number = Math.pow(Math.max(fps, 1) / 60, 0.7)
  const codecFactor: Record<ExportVideoCodec, number> = {
    h264: 1.0,
    hevc: 0.72,
    vp9: 0.78,
    av1: 0.65,
    prores: 6.5
  }
  const raw: number = 14 * pixelRatio * fpsRatio * codecFactor[codec]
  return Math.min(400, Math.max(2, Math.round(raw)))
}

export function createDefaultExportConfig(memorySizeMb: number): VideoExportConfig {
  return {
    presetId: '1080p',
    width: 1920,
    height: 1080,
    fps: 60,
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    engineMode: 'auto',
    bitrateMbps: computeRecommendedBitrateMbps(1920, 1080, 60, 'h264'),
    crf: 18,
    hardwareAccel: true,
    transparentAlpha: false,
    memorySizeMb
  }
}

export function coerceCodecsForContainer(
  container: VideoContainerFormat,
  videoCodec: ExportVideoCodec,
  audioCodec: ExportAudioCodec,
  transparentAlpha: boolean
): {
  videoCodec: ExportVideoCodec
  audioCodec: ExportAudioCodec
  transparentAlpha: boolean
} {
  const allowedVideo: readonly ExportVideoCodec[] = CONTAINER_VIDEO_CODECS[container]
  const nextVideo: ExportVideoCodec = allowedVideo.includes(videoCodec)
    ? videoCodec
    : allowedVideo[0]
  const allowedAudio: readonly ExportAudioCodec[] = CONTAINER_AUDIO_CODECS[container]
  const nextAudio: ExportAudioCodec = allowedAudio.includes(audioCodec)
    ? audioCodec
    : allowedAudio[0]
  const supportsAlpha: boolean = container === 'webm' || nextVideo === 'prores'

  return {
    videoCodec: nextVideo,
    audioCodec: nextAudio,
    transparentAlpha: supportsAlpha ? transparentAlpha : false
  }
}

export function splitSubStepDeltas(deltaMs: number, maxStepMs: number = MAX_SUBSTEP_MS): number[] {
  if (!(deltaMs > 0)) return []
  const stepCount: number = Math.max(1, Math.ceil(deltaMs / maxStepMs))
  const stepMs: number = deltaMs / stepCount
  const steps: number[] = []
  let accumulated: number = 0
  for (let i = 0; i < stepCount; i += 1) {
    if (i === stepCount - 1) {
      steps.push(Math.max(0, deltaMs - accumulated))
    } else {
      steps.push(stepMs)
      accumulated += stepMs
    }
  }
  return steps
}

export function computeWebCodecsString(
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
  isWebKit: boolean
): string | undefined {
  const lumaSamples: number = width * height
  const lumaRate: number = lumaSamples * fps
  const totalMacroblocks: number = Math.ceil(width / 16) * Math.ceil(height / 16)
  const macroblockRate: number = totalMacroblocks * fps

  if (codec === 'h264') {
    const profile: string = isWebKit ? '4240' : '6400'
    type AvcLevel = { code: string; maxMb: number; maxMbPerSec: number }
    const levels: readonly AvcLevel[] = [
      { code: '1f', maxMb: 3600, maxMbPerSec: 108000 },
      { code: '28', maxMb: 8192, maxMbPerSec: 245760 },
      { code: '29', maxMb: 8192, maxMbPerSec: 245760 },
      { code: '2a', maxMb: 8704, maxMbPerSec: 522240 },
      { code: '32', maxMb: 22080, maxMbPerSec: 589824 },
      { code: '33', maxMb: 36864, maxMbPerSec: 983040 },
      { code: '34', maxMb: 36864, maxMbPerSec: 2073600 },
      { code: '3c', maxMb: 139264, maxMbPerSec: 4177920 },
      { code: '3d', maxMb: 139264, maxMbPerSec: 8355840 },
      { code: '3e', maxMb: 139264, maxMbPerSec: 16711680 }
    ]
    const picked: AvcLevel =
      levels.find(
        (lvl: AvcLevel): boolean =>
          totalMacroblocks <= lvl.maxMb && macroblockRate <= lvl.maxMbPerSec
      ) ?? levels[levels.length - 1]
    return `avc1.${profile}${picked.code}`
  }

  if (codec === 'hevc') {
    type HevcLevel = { code: number; maxSamples: number; maxRate: number }
    const levels: readonly HevcLevel[] = [
      { code: 120, maxSamples: 2228224, maxRate: 66846720 },
      { code: 123, maxSamples: 2228224, maxRate: 133693440 },
      { code: 150, maxSamples: 8912896, maxRate: 267386880 },
      { code: 153, maxSamples: 8912896, maxRate: 534773760 },
      { code: 156, maxSamples: 8912896, maxRate: 1069547520 },
      { code: 180, maxSamples: 35651584, maxRate: 1069547520 },
      { code: 183, maxSamples: 35651584, maxRate: 2139095040 },
      { code: 186, maxSamples: 35651584, maxRate: 4278190080 }
    ]
    const picked: HevcLevel =
      levels.find(
        (lvl: HevcLevel): boolean => lumaSamples <= lvl.maxSamples && lumaRate <= lvl.maxRate
      ) ?? levels[levels.length - 1]
    return `hvc1.1.6.L${picked.code}.B0`
  }

  if (codec === 'vp9') {
    type Vp9Level = { code: string; maxSamples: number; maxRate: number }
    const levels: readonly Vp9Level[] = [
      { code: '40', maxSamples: 2228224, maxRate: 72089600 },
      { code: '41', maxSamples: 2228224, maxRate: 144179200 },
      { code: '50', maxSamples: 8912896, maxRate: 288358400 },
      { code: '51', maxSamples: 8912896, maxRate: 576716800 },
      { code: '52', maxSamples: 8912896, maxRate: 1153433600 },
      { code: '60', maxSamples: 35651584, maxRate: 1153433600 },
      { code: '61', maxSamples: 35651584, maxRate: 2306867200 },
      { code: '62', maxSamples: 35651584, maxRate: 4613734400 }
    ]
    const picked: Vp9Level =
      levels.find(
        (lvl: Vp9Level): boolean => lumaSamples <= lvl.maxSamples && lumaRate <= lvl.maxRate
      ) ?? levels[levels.length - 1]
    return `vp09.00.${picked.code}.08`
  }

  if (codec === 'av1') {
    type Av1Level = { code: string; maxSamples: number; maxRate: number }
    const levels: readonly Av1Level[] = [
      { code: '08M', maxSamples: 2228224, maxRate: 70778880 },
      { code: '09M', maxSamples: 2228224, maxRate: 141557760 },
      { code: '12M', maxSamples: 8912896, maxRate: 283115520 },
      { code: '13M', maxSamples: 8912896, maxRate: 566231040 },
      { code: '14M', maxSamples: 8912896, maxRate: 1132462080 },
      { code: '15M', maxSamples: 8912896, maxRate: 2264924160 },
      { code: '16M', maxSamples: 35651584, maxRate: 1132462080 },
      { code: '17M', maxSamples: 35651584, maxRate: 2264924160 },
      { code: '18M', maxSamples: 35651584, maxRate: 4529848320 }
    ]
    const picked: Av1Level =
      levels.find(
        (lvl: Av1Level): boolean => lumaSamples <= lvl.maxSamples && lumaRate <= lvl.maxRate
      ) ?? levels[levels.length - 1]
    return `av01.0.${picked.code}.08`
  }

  return undefined
}
