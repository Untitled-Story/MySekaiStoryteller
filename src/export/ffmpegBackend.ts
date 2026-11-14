import {
  abortExportSession,
  finishExportSession,
  pushVideoBatch,
  startExportSession,
  uploadExportWav
} from './exportApi'
import { encodeAudioBufferToWav } from './audioTimeline'
import { GlFramePacker } from './glNv12Packer'
import type { FinishExportResponse, VideoExportConfig } from './types'

export type FfmpegPipeline = {
  readonly engineUsed: 'ffmpeg'
  readonly selectedEncoder: string | null
  readonly dispose: () => void
  pushFrame: () => Promise<void>
  finalize: (audioBuffer: AudioBuffer | null) => Promise<FinishExportResponse>
  abort: () => Promise<void>
}

export async function createFfmpegPipeline(params: {
  config: VideoExportConfig
  appCanvas: HTMLCanvasElement
  destinationPath: string
  sharedGl?: WebGL2RenderingContext
  getSourceTexture?: () => WebGLTexture | null
  resetRendererState?: () => void
  flipTextureY?: boolean
}): Promise<FfmpegPipeline> {
  const {
    config,
    appCanvas,
    destinationPath,
    sharedGl,
    getSourceTexture,
    resetRendererState,
    flipTextureY
  } = params
  const packer: GlFramePacker = new GlFramePacker(
    config.width,
    config.height,
    config.transparentAlpha,
    sharedGl
      ? {
          sharedGl,
          resetExternalState: resetRendererState,
          flipTextureY
        }
      : undefined
  )

  let sessionId: string | null = null
  let selectedEncoder: string | null = null
  try {
    const startRes = await startExportSession({
      mode: 'ffmpeg',
      container: config.container,
      videoCodec: config.videoCodec,
      audioCodec: config.audioCodec,
      pixelFormat: packer.pixelFormat,
      width: config.width,
      height: config.height,
      fps: config.fps,
      bitrateKbps: Math.round(config.bitrateMbps * 1000),
      crf: config.crf,
      hardwareAccel: config.hardwareAccel,
      ffmpegPath: config.ffmpegPath
    })
    sessionId = startRes.sessionId
    selectedEncoder = startRes.selectedEncoder
    if (startRes.expectedFrameBytes !== packer.frameBytes) {
      throw new Error(
        `前后端单帧字节数不一致 (${packer.frameBytes} !== ${startRes.expectedFrameBytes})`
      )
    }
  } catch (error: unknown) {
    packer.dispose()
    throw error
  }

  const batchFrameLimit: number = packer.batchGroupFrames
  const batchBytes: number = batchFrameLimit * packer.frameBytes
  const batchBuffers: readonly [Uint8Array, Uint8Array] = [
    new Uint8Array(batchBytes),
    new Uint8Array(batchBytes)
  ]
  let activeBufferIndex: 0 | 1 = 0
  let bufferedFrames: number = 0
  let inFlightPush: Promise<void> | null = null
  let inFlightError: unknown = null
  let aborted: boolean = false
  let finished: boolean = false

  const awaitInFlightPush = async (): Promise<void> => {
    if (!inFlightPush) return
    await inFlightPush
    inFlightPush = null
    if (inFlightError !== null) {
      const errorToThrow: unknown = inFlightError
      inFlightError = null
      throw errorToThrow
    }
  }

  const dispatchActiveBatch = async (): Promise<void> => {
    if (bufferedFrames === 0 || aborted || !sessionId) return
    await awaitInFlightPush()
    if (aborted || !sessionId) return

    const byteLength: number = bufferedFrames * packer.frameBytes
    const currentBuffer: Uint8Array = batchBuffers[activeBufferIndex]
    const sliceToSend: Uint8Array =
      byteLength === currentBuffer.byteLength
        ? currentBuffer
        : currentBuffer.subarray(0, byteLength)

    bufferedFrames = 0
    activeBufferIndex = activeBufferIndex === 0 ? 1 : 0

    inFlightError = null
    inFlightPush = pushVideoBatch(sessionId, sliceToSend).catch((err: unknown): void => {
      inFlightError = err
    })
  }

  const getBatchDestination = (): Uint8Array => {
    return batchBuffers[activeBufferIndex]
  }

  const handleBatchWritten = async (frameCount: number): Promise<void> => {
    if (aborted || frameCount <= 0) return
    bufferedFrames = frameCount
    await dispatchActiveBatch()
  }

  const dispose = (): void => {
    packer.dispose()
  }

  return {
    engineUsed: 'ffmpeg',
    selectedEncoder,
    dispose,
    pushFrame: async (): Promise<void> => {
      if (aborted) return
      const sourceTexture: WebGLTexture | null = getSourceTexture ? getSourceTexture() : null
      if (packer.sharedContext && sourceTexture) {
        await packer.pushTextureBatchDirect(sourceTexture, getBatchDestination, handleBatchWritten)
        return
      }
      await packer.pushCanvasBatchDirect(appCanvas, getBatchDestination, handleBatchWritten)
    },
    finalize: async (audioBuffer: AudioBuffer | null): Promise<FinishExportResponse> => {
      if (!sessionId) {
        throw new Error('FFmpeg 导出会话未初始化')
      }
      try {
        await packer.flushBatchDirect(getBatchDestination, handleBatchWritten)
        await dispatchActiveBatch()
        await awaitInFlightPush()

        const hasAudio: boolean = audioBuffer !== null
        if (audioBuffer) {
          const wavBytes: Uint8Array = encodeAudioBufferToWav(audioBuffer)
          await uploadExportWav(sessionId, wavBytes)
        }

        finished = true
        return await finishExportSession(sessionId, destinationPath, hasAudio)
      } catch (error: unknown) {
        if (!aborted && sessionId) {
          await abortExportSession(sessionId).catch((): void => undefined)
        }
        throw error
      } finally {
        dispose()
      }
    },
    abort: async (): Promise<void> => {
      if (aborted || finished) return
      aborted = true
      await inFlightPush?.catch((): void => undefined)
      inFlightPush = null
      dispose()
      if (sessionId) {
        await abortExportSession(sessionId).catch((): void => undefined)
      }
    }
  }
}
