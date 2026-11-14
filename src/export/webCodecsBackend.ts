import {
  AudioBufferSource,
  CanvasSource,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec
} from 'mediabunny'
import {
  abortExportSession,
  finishExportSession,
  startExportSession,
  writeExportChunk
} from './exportApi'
import { isMobileRuntime } from '../lib/platform'
import { computeStageFitLayout, computeWebCodecsString, type StageFitLayout } from './presets'
import type {
  ExportAudioCodec,
  ExportVideoCodec,
  FinishExportResponse,
  VideoContainerFormat,
  VideoExportConfig
} from './types'

export type WebCodecsSupportStatus = {
  supported: boolean
  reason?: string
  codecString?: string
  hardwareAcceleration: 'prefer-hardware' | 'no-preference'
  latencyMode?: 'quality' | 'realtime'
}

export type WebCodecsPipeline = {
  readonly engineUsed: 'webcodecs'
  readonly selectedEncoder: string | null
  readonly dispose: () => void
  pushFrame: (timestampSec: number, durationSec: number) => Promise<void>
  finalize: (audioBuffer: AudioBuffer | null) => Promise<FinishExportResponse>
  abort: () => Promise<void>
}

export function isWebKitBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua: string = navigator.userAgent
  return /AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)
}

function mapVideoCodec(codec: ExportVideoCodec): VideoCodec | null {
  switch (codec) {
    case 'h264':
      return 'avc'
    case 'hevc':
      return 'hevc'
    case 'vp9':
      return 'vp9'
    case 'av1':
      return 'av1'
    default:
      return null
  }
}

function mapAudioCodec(codec: ExportAudioCodec): AudioCodec {
  switch (codec) {
    case 'aac':
      return 'aac'
    case 'opus':
      return 'opus'
    case 'pcm_s16le':
      return 'pcm-s16'
  }
}

export async function probeWebCodecsSupport(
  config: VideoExportConfig,
  hasAudioTrack: boolean
): Promise<WebCodecsSupportStatus> {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    (hasAudioTrack && typeof AudioEncoder === 'undefined' && config.audioCodec !== 'pcm_s16le')
  ) {
    return {
      supported: false,
      reason: 'WebCodecs API unavailable in current webview',
      hardwareAcceleration: 'no-preference'
    }
  }

  const mappedVideo: VideoCodec | null = mapVideoCodec(config.videoCodec)
  if (!mappedVideo) {
    return {
      supported: false,
      reason: `Codec ${config.videoCodec} requires FFmpeg`,
      hardwareAcceleration: 'no-preference'
    }
  }

  const codecString: string | undefined = computeWebCodecsString(
    config.videoCodec,
    config.width,
    config.height,
    config.fps,
    isWebKitBrowser()
  )
  if (!codecString) {
    return {
      supported: false,
      reason: `Unsupported WebCodecs codec ${config.videoCodec}`,
      hardwareAcceleration: 'no-preference'
    }
  }

  const accelCandidates: readonly ('prefer-hardware' | 'no-preference')[] = config.hardwareAccel
    ? ['prefer-hardware', 'no-preference']
    : ['no-preference']

  let selectedAccel: 'prefer-hardware' | 'no-preference' | null = null
  let selectedLatencyMode: 'quality' | 'realtime' | undefined = undefined
  const mobileRuntime: boolean = isMobileRuntime()
  for (const hardwareAcceleration of accelCandidates) {
    const preferredLatency: 'realtime' | undefined =
      mobileRuntime || hardwareAcceleration === 'no-preference' ? 'realtime' : undefined
    const latencyCandidates: readonly ('realtime' | undefined)[] = preferredLatency
      ? ['realtime', undefined]
      : [undefined]
    for (const latencyMode of latencyCandidates) {
      try {
        const support: VideoEncoderSupport = await VideoEncoder.isConfigSupported({
          codec: codecString,
          width: config.width,
          height: config.height,
          framerate: config.fps,
          bitrate: Math.round(config.bitrateMbps * 1_000_000),
          hardwareAcceleration,
          ...(latencyMode ? { latencyMode } : {}),
          alpha: config.transparentAlpha ? 'keep' : 'discard'
        })
        if (support.supported) {
          selectedAccel = hardwareAcceleration
          selectedLatencyMode = latencyMode
          break
        }
      } catch {
        // Try next configuration candidate
      }
    }
    if (selectedAccel) {
      break
    }
  }

  if (!selectedAccel) {
    return {
      supported: false,
      reason: `WebCodecs video configuration unsupported (${codecString}, ${config.width}x${config.height}@${config.fps})`,
      codecString,
      hardwareAcceleration: 'no-preference'
    }
  }

  if (hasAudioTrack && config.audioCodec !== 'pcm_s16le') {
    const audioCodecString: string = config.audioCodec === 'aac' ? 'mp4a.40.2' : 'opus'
    try {
      const audioSupport: AudioEncoderSupport = await AudioEncoder.isConfigSupported({
        codec: audioCodecString,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 192_000
      })
      if (!audioSupport.supported) {
        return {
          supported: false,
          reason: `WebCodecs audio codec unsupported (${audioCodecString})`,
          codecString,
          hardwareAcceleration: selectedAccel
        }
      }
    } catch {
      return {
        supported: false,
        reason: `WebCodecs audio codec check failed (${audioCodecString})`,
        codecString,
        hardwareAcceleration: selectedAccel
      }
    }
  }

  return {
    supported: true,
    codecString,
    hardwareAcceleration: selectedAccel,
    ...(selectedLatencyMode ? { latencyMode: selectedLatencyMode } : {})
  }
}

function createFormatInstance(
  container: VideoContainerFormat
): Mp4OutputFormat | MovOutputFormat | WebMOutputFormat {
  switch (container) {
    case 'mp4':
      return new Mp4OutputFormat({ fastStart: false })
    case 'mov':
      return new MovOutputFormat({ fastStart: false })
    case 'webm':
      return new WebMOutputFormat()
  }
}

export async function createWebCodecsPipeline(params: {
  config: VideoExportConfig
  appCanvas: HTMLCanvasElement
  destinationPath: string
  hasAudioTrack: boolean
  support: WebCodecsSupportStatus
}): Promise<WebCodecsPipeline> {
  const { config, appCanvas, destinationPath, hasAudioTrack, support } = params
  const mediabunnyCodec: VideoCodec | null = mapVideoCodec(config.videoCodec)
  if (!mediabunnyCodec || !support.codecString) {
    throw new Error(`WebCodecs 不支持视频编码格式: ${config.videoCodec}`)
  }

  const layout: StageFitLayout = computeStageFitLayout(config.width, config.height)
  let compositeCanvas: HTMLCanvasElement | null = null
  let compositeCtx: CanvasRenderingContext2D | null = null
  let encodeCanvas: HTMLCanvasElement = appCanvas

  if (!layout.directMatch) {
    compositeCanvas = document.createElement('canvas')
    compositeCanvas.width = config.width
    compositeCanvas.height = config.height
    compositeCtx = compositeCanvas.getContext('2d', { alpha: config.transparentAlpha })
    if (!compositeCtx) {
      throw new Error('无法创建自定义分辨率画布上下文')
    }
    encodeCanvas = compositeCanvas
  }

  const session = await startExportSession({
    mode: 'webcodecs',
    container: config.container,
    videoCodec: config.videoCodec,
    audioCodec: config.audioCodec,
    pixelFormat: 'encoded',
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrateKbps: Math.round(config.bitrateMbps * 1000),
    crf: config.crf,
    hardwareAccel: config.hardwareAccel,
    ffmpegPath: config.ffmpegPath
  })

  let aborted: boolean = false
  let closed: boolean = false

  const writable: WritableStream<StreamTargetChunk> = new WritableStream<StreamTargetChunk>({
    write: async (chunk: StreamTargetChunk): Promise<void> => {
      if (aborted) return
      await writeExportChunk(session.sessionId, chunk.data, chunk.position)
    }
  })

  const output: Output = new Output({
    format: createFormatInstance(config.container),
    target: new StreamTarget(writable, {
      chunked: true,
      chunkSize: isMobileRuntime() ? 1024 * 1024 : 4 * 1024 * 1024
    })
  })

  const videoSource: CanvasSource = new CanvasSource(encodeCanvas, {
    codec: mediabunnyCodec,
    fullCodecString: support.codecString,
    bitrate: Math.round(config.bitrateMbps * 1_000_000),
    hardwareAcceleration: support.hardwareAcceleration,
    ...(support.latencyMode ? { latencyMode: support.latencyMode } : {}),
    alpha: config.transparentAlpha ? 'keep' : 'discard',
    keyFrameInterval: 2
  })
  output.addVideoTrack(videoSource, { frameRate: config.fps })

  let audioSource: AudioBufferSource | null = null
  const audioCodec: AudioCodec = mapAudioCodec(config.audioCodec)
  if (hasAudioTrack) {
    audioSource = new AudioBufferSource(
      audioCodec === 'pcm-s16' ? { codec: audioCodec } : { codec: audioCodec, bitrate: 192_000 }
    )
    output.addAudioTrack(audioSource)
  }

  try {
    await output.start()
  } catch (error: unknown) {
    await abortExportSession(session.sessionId).catch((): void => undefined)
    throw error
  }

  const dispose = (): void => {
    if (compositeCanvas) {
      compositeCanvas.width = 0
      compositeCanvas.height = 0
      compositeCanvas = null
      compositeCtx = null
    }
  }

  return {
    engineUsed: 'webcodecs',
    selectedEncoder: `webcodecs:${support.codecString}`,
    dispose,
    pushFrame: async (timestampSec: number, durationSec: number): Promise<void> => {
      if (aborted) return
      if (compositeCanvas && compositeCtx) {
        if (config.transparentAlpha) {
          compositeCtx.clearRect(0, 0, config.width, config.height)
        } else {
          compositeCtx.fillStyle = '#000000'
          compositeCtx.fillRect(0, 0, config.width, config.height)
        }
        compositeCtx.drawImage(
          appCanvas,
          layout.offsetX,
          layout.offsetY,
          layout.renderedWidth,
          layout.renderedHeight
        )
      }
      await videoSource.add(timestampSec, durationSec)
    },
    finalize: async (audioBuffer: AudioBuffer | null): Promise<FinishExportResponse> => {
      try {
        if (audioSource) {
          const targetAudioBuffer: AudioBuffer = audioBuffer ?? createSilentAudioBuffer(48000, 480)
          await audioSource.add(targetAudioBuffer)
          audioSource.close()
        }
        videoSource.close()
        await output.finalize()
        closed = true
        return await finishExportSession(session.sessionId, destinationPath, hasAudioTrack)
      } catch (error: unknown) {
        if (!aborted) {
          await abortExportSession(session.sessionId).catch((): void => undefined)
        }
        throw error
      } finally {
        dispose()
      }
    },
    abort: async (): Promise<void> => {
      if (aborted || closed) return
      aborted = true
      try {
        await output.cancel()
      } catch {
        // Ignore cancel cleanup errors
      }
      await abortExportSession(session.sessionId).catch((): void => undefined)
      dispose()
    }
  }
}

function createSilentAudioBuffer(sampleRate: number, length: number): AudioBuffer {
  const ctx: OfflineAudioContext = new OfflineAudioContext(2, length, sampleRate)
  return ctx.createBuffer(2, length, sampleRate)
}
