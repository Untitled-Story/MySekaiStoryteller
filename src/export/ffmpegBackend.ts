import {
  abortExportSession,
  finishExportSession,
  pushVideoBatch,
  repeatVideoBatch,
  startExportSession,
  uploadExportWav
} from './exportApi'
import { encodeAudioBufferToWav } from './audioTimeline'
import { GlFramePacker } from './glNv12Packer'
import { resolveChromaMode } from './presets'
import type { FinishExportResponse, VideoExportConfig } from './types'

/** 单次 IPC 传输的目标载荷上限，决定「多少个 PBO 批次攒成一次 IPC」。 */
const IPC_BATCH_BUDGET_BYTES: number = 100 * 1024 * 1024
/** 单次 IPC 最多合并的帧数，避免极小分辨率的帧被攒成超大缓冲。 */
const MAX_IPC_BATCH_FRAMES: number = 8
/** 允许同时在飞的 IPC 批次数量，用于重叠「打包」与「传输」。 */
const IN_FLIGHT_LIMIT: number = 3

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
    {
      chromaMode: resolveChromaMode(config.renderQuality, config.videoCodec),
      ...(sharedGl
        ? {
            sharedGl,
            resetExternalState: resetRendererState,
            flipTextureY
          }
        : {})
    }
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

  const packerBatchFrames: number = packer.batchGroupFrames
  const frameBytes: number = packer.frameBytes
  // IPC 批次与 PBO 批次解耦：PBO 的 batchGroupFrames 受显存预算约束（RGBA 4K 下退化为 1 帧），
  // 若直接照搬就会变成"每帧一次 IPC 往返"。这里把多个 PBO 批次攒成一次传输，
  // 实测 IPC 吞吐可从 856 MB/s 提升到 1238 MB/s（+45%）。
  // IPC 批次必须能被 PBO 批次整除，否则第二次 getBatchDestination 的写入窗口会越过缓冲区尾部。
  // 例如 1080p RGBA：PBO 批次 6 帧、预算只够 8 帧时，直接取 8 会让 6+6 > 8 而越界。
  const targetIpcFrames: number = Math.min(
    MAX_IPC_BATCH_FRAMES,
    Math.max(packerBatchFrames, Math.floor(IPC_BATCH_BUDGET_BYTES / frameBytes))
  )
  const ipcBatchFrames: number = Math.max(
    packerBatchFrames,
    Math.ceil(targetIpcFrames / packerBatchFrames) * packerBatchFrames
  )
  const ipcBatchBytes: number = ipcBatchFrames * frameBytes
  const packerBatchBytes: number = packerBatchFrames * frameBytes
  // 实验结论：在飞深度 2/3/4 对 4K 端到端帧率几乎无影响（50.1 / 51.8 / 52.1 fps，差异在噪声内），
  // 说明瓶颈不在流水线深度。取 3 以兼顾内存与余量（4K yuv444p 下 4 缓冲区约 380 MB）。
  const inFlightLimit: number = IN_FLIGHT_LIMIT
  // 缓冲区数量 = 在飞上限 + 1，保证"正被 IPC 读取的那批"不会被下一次打包覆盖。
  const batchBuffers: Uint8Array[] = Array.from(
    { length: inFlightLimit + 1 },
    (): Uint8Array => new Uint8Array(ipcBatchBytes)
  )
  let activeBufferIndex: number = 0
  let bufferedFrames: number = 0
  const inFlight: Promise<void>[] = []
  let inFlightError: unknown = null
  let aborted: boolean = false
  let finished: boolean = false

  const awaitOldestInFlight = async (): Promise<void> => {
    const oldest: Promise<void> | undefined = inFlight.shift()
    if (!oldest) return
    await oldest
    if (inFlightError !== null) {
      const errorToThrow: unknown = inFlightError
      inFlightError = null
      throw errorToThrow
    }
  }

  // ---- 重复帧检测 ----------------------------------------------------------
  // 剧情导出里静止镜头很多：像素与上一批完全相同时，让后端把上一批字节再写一遍，
  // 省掉一次 IPC 传输（4K RGBA 下约 38 ms/批）。判定必须逐字节完全一致，绝不能"看起来像"。
  let lastDispatchedBufferIndex: number = -1
  let lastDispatchedFrames: number = 0

  const drainAllInFlight = async (): Promise<void> => {
    while (inFlight.length > 0) {
      await awaitOldestInFlight()
    }
  }

  /** 稀疏采样预检：任何一处不同立即返回 false，几乎零成本。 */
  const matchSparse = (a: Uint8Array, b: Uint8Array, length: number): boolean => {
    const samples: number = 64
    const stride: number = Math.max(1, Math.floor(length / samples))
    for (let offset = 0; offset < length; offset += stride) {
      if (a[offset] !== b[offset]) return false
    }
    return a[length - 1] === b[length - 1] && a[length >>> 1] === b[length >>> 1]
  }

  const isDuplicateOfLast = (buffer: Uint8Array, byteLength: number): boolean => {
    if (lastDispatchedBufferIndex < 0 || lastDispatchedFrames !== bufferedFrames) return false
    const previous: Uint8Array = batchBuffers[lastDispatchedBufferIndex]
    if (previous === buffer) return false
    if (!matchSparse(previous, buffer, byteLength)) return false
    for (let i = 0; i < byteLength; i += 1) {
      if (previous[i] !== buffer[i]) return false
    }
    return true
  }

  const dispatchActiveBatch = async (): Promise<void> => {
    if (bufferedFrames === 0 || aborted || !sessionId) return

    const currentBuffer: Uint8Array = batchBuffers[activeBufferIndex]
    const byteLength: number = bufferedFrames * frameBytes
    // 整块提交时 byteOffset 为 0、长度等于容量，pushVideoBatch 内部不会再 slice 拷贝一次。
    const payload: Uint8Array =
      byteLength === currentBuffer.byteLength
        ? currentBuffer
        : currentBuffer.subarray(0, byteLength)

    if (isDuplicateOfLast(currentBuffer, byteLength)) {
      const session: string = sessionId
      const frames: number = bufferedFrames
      bufferedFrames = 0
      activeBufferIndex = (activeBufferIndex + 1) % batchBuffers.length
      // 重复指令依赖后端手里的「上一批」，因此必须先排空在飞批次，保证顺序与内容都对得上。
      await drainAllInFlight()
      if (aborted || !sessionId) return
      const repeat: Promise<void> = repeatVideoBatch(session, 1).catch((err: unknown): void => {
        if (inFlightError === null) inFlightError = err
      })
      inFlight.push(repeat)
      lastDispatchedFrames = frames
      return
    }

    const dispatchedIndex: number = activeBufferIndex
    const dispatchedFrames: number = bufferedFrames
    bufferedFrames = 0
    activeBufferIndex = (activeBufferIndex + 1) % batchBuffers.length

    while (inFlight.length >= inFlightLimit) {
      await awaitOldestInFlight()
    }
    if (aborted || !sessionId) return

    const session: string = sessionId
    const push: Promise<void> = pushVideoBatch(session, payload).catch((err: unknown): void => {
      if (inFlightError === null) inFlightError = err
    })
    inFlight.push(push)
    lastDispatchedBufferIndex = dispatchedIndex
    lastDispatchedFrames = dispatchedFrames
  }

  const getBatchDestination = (): Uint8Array => {
    const buffer: Uint8Array = batchBuffers[activeBufferIndex]
    const offset: number = bufferedFrames * frameBytes
    return buffer.subarray(offset, offset + packerBatchBytes)
  }

  const handleBatchWritten = async (frameCount: number): Promise<void> => {
    if (aborted || frameCount <= 0) return
    bufferedFrames += frameCount
    if (bufferedFrames >= ipcBatchFrames) {
      await dispatchActiveBatch()
    }
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
        while (inFlight.length > 0) {
          await awaitOldestInFlight()
        }

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
      await Promise.all(inFlight).catch((): void => undefined)
      inFlight.length = 0
      dispose()
      if (sessionId) {
        await abortExportSession(sessionId).catch((): void => undefined)
      }
    }
  }
}
