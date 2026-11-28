import { invoke } from '@tauri-apps/api/core'
import { isMobileRuntime } from '../lib/platform'
import type { FfmpegCapabilities, FinishExportResponse, StartExportResponse } from './types'

export type StartExportRequest = {
  mode: 'webcodecs' | 'ffmpeg'
  container: 'mp4' | 'webm' | 'mov'
  videoCodec: 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores'
  audioCodec: 'aac' | 'opus' | 'pcm_s16le'
  pixelFormat: 'encoded' | 'nv12' | 'nv16' | 'yuv444p' | 'rgba'
  width: number
  height: number
  fps: number
  bitrateKbps?: number
  crf?: number
  hardwareAccel: boolean
  ffmpegPath?: string
}

/** 能力探测会启动子进程执行 `ffmpeg -encoders`（实测 80~112 ms）。导出流程与设置界面
 *  都会调用它，因此按 ffmpegPath 缓存结果，避免每次导出都付这笔固定开销。 */
const FFMPEG_CAPABILITY_TTL_MS: number = 5 * 60 * 1000
const ffmpegCapabilityCache: Map<string, { at: number; value: FfmpegCapabilities }> = new Map()

export function probeFfmpegCapabilities(ffmpegPath?: string): Promise<FfmpegCapabilities> {
  const key: string = ffmpegPath ?? ''
  const cached = ffmpegCapabilityCache.get(key)
  if (cached && Date.now() - cached.at < FFMPEG_CAPABILITY_TTL_MS) {
    return Promise.resolve(cached.value)
  }
  return invoke<FfmpegCapabilities>('probe_ffmpeg_capabilities', {
    ffmpegPath: ffmpegPath ?? null
  }).then((value: FfmpegCapabilities): FfmpegCapabilities => {
    ffmpegCapabilityCache.set(key, { at: Date.now(), value })
    return value
  })
}

/** 用户更改 ffmpeg 路径或重新安装后，主动作废缓存。 */
export function invalidateFfmpegCapabilityCache(): void {
  ffmpegCapabilityCache.clear()
}

export function startExportSession(request: StartExportRequest): Promise<StartExportResponse> {
  return invoke<StartExportResponse>('export_start_session', { request })
}

export function writeExportChunk(
  sessionId: string,
  data: Uint8Array,
  offset?: number
): Promise<void> {
  const headers: Record<string, string> = {
    'x-export-id': sessionId
  }
  if (offset !== undefined) {
    headers['x-offset'] = String(offset)
  }
  // Android WebResourceRequest has no body API, so Tauri v2 serializes invoke() via JSON.
  if (isMobileRuntime()) {
    return invoke<void>(
      'export_write_chunk',
      { dataBase64: encodeUint8ArrayToBase64(data) },
      { headers }
    )
  }
  const payload: Uint8Array = toExactUint8Array(data)
  return invoke<void>('export_write_chunk', payload, { headers })
}

export function pushVideoBatch(sessionId: string, batchData: Uint8Array): Promise<void> {
  const payload: Uint8Array = toExactUint8Array(batchData)
  return invoke<void>('export_push_video_batch', payload, {
    headers: {
      'x-export-id': sessionId
    }
  })
}

/**
 * 让后端把「上一批已写入的原始字节」再写 repeatCount 遍。
 * 用于重复帧：像素与上一批完全相同时，不必再走一次 IPC 传输。
 */
export function repeatVideoBatch(sessionId: string, repeatCount: number): Promise<void> {
  return invoke<void>('export_repeat_video_batch', { sessionId, repeatCount })
}

export function uploadExportWav(sessionId: string, wavData: Uint8Array): Promise<void> {
  const payload: Uint8Array = toExactUint8Array(wavData)
  return invoke<void>('export_upload_wav', payload, {
    headers: {
      'x-export-id': sessionId
    }
  })
}

export function finishExportSession(
  sessionId: string,
  destinationPath: string,
  hasAudio: boolean
): Promise<FinishExportResponse> {
  return invoke<FinishExportResponse>('export_finish_session', {
    sessionId,
    destinationPath,
    hasAudio
  })
}

export function abortExportSession(sessionId: string): Promise<void> {
  return invoke<void>('export_abort_session', { sessionId })
}

function toExactUint8Array(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data
  }
  return data.slice()
}

function encodeUint8ArrayToBase64(data: Uint8Array): string {
  const nativeEncoder = (data as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof nativeEncoder === 'function') {
    return nativeEncoder.call(data)
  }

  const chunkSize: number = 0x8000
  const parts: string[] = []
  for (let offset: number = 0; offset < data.length; offset += chunkSize) {
    const slice: Uint8Array = data.subarray(offset, offset + chunkSize)
    parts.push(String.fromCharCode(...slice))
  }
  return btoa(parts.join(''))
}
