import { ILogObj, Logger } from 'tslog'
import { app, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import * as fs from 'node:fs'
import Ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { PassThrough } from 'node:stream'
import {
  SelectStoryResponse,
  LoadStoryFromPathResponse,
  CliProgressState
} from '../../common/types/IpcResponse'
import { StoryData, StorySchema } from '../../common/types/Story'
import { z } from 'zod'
import { mainWindow, cliArgs } from '../index'
import {
  FinishFrameExportPayload,
  FinishFrameExportResponse,
  FrameExportProgressPayload,
  ProbeStoryVoiceDurationsPayload,
  ProbeStoryVoiceDurationsResponse,
  RenderAudioEvent
} from '../../common/types/FrameExport'

// ── FFmpeg/FFprobe binary path setup ────────────────────────────────────────
if (ffmpegPath) {
  Ffmpeg.setFfmpegPath(ffmpegPath)
}
if (ffprobeInstaller?.path) {
  Ffmpeg.setFfprobePath(ffprobeInstaller.path)
}

// ── Local type definitions ──────────────────────────────────────────────────

interface SelectExportDirectoryResponse {
  canceled: boolean
  path?: string
}

interface StartFrameExportPayload {
  storyPath: string
  outputRoot: string
  fps: number
  width: number
  height: number
}

interface StartFrameExportResponse {
  success: boolean
  outputDir: string
}

interface SaveFramePayload {
  index: number
  buffer: ArrayBuffer | Uint8Array
}

interface FrameExportSession {
  outputDir: string | null
  storyPath: string | null
  storyFolder: string | null
  fps: number
  width: number
  height: number
  frameBuffers: Buffer[]
}

interface VideoEncoderConfig {
  name: string
  label: string
  globalArgs: string[]
  outputArgs: string[]
}

// ── Module state ─────────────────────────────────────────────────────────────

const frameExportSession: FrameExportSession = {
  outputDir: null,
  storyPath: null,
  storyFolder: null,
  fps: 60,
  width: 0,
  height: 0,
  frameBuffers: []
}

let encoderProbePromise: Promise<Set<string>> | null = null
let lavfiCache: boolean | null = null

// ── Utility functions ────────────────────────────────────────────────────────

function sanitizeFileName(name: string): string {
  const invalidCharacters = '<>:"/\\|?*'

  return name
    .split('')
    .map((char) => {
      if (char.charCodeAt(0) < 32 || invalidCharacters.includes(char)) return '_'
      return char
    })
    .join('')
    .replace(/\s+/g, '_')
}

function toFrameBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  if (data instanceof Uint8Array) return Buffer.from(data)

  return Buffer.from(new Uint8Array(data))
}

function createTimestamp(): string {
  const now = new Date()
  const pad = (value: number): string => value.toString().padStart(2, '0')

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function getStoryName(storyPath: string): string {
  return sanitizeFileName(path.basename(storyPath).replace(/\.sekai-story\.json$/u, ''))
}

function getVoicePath(storyFolder: string, voice: string): string {
  return path.resolve(storyFolder, 'voices', voice)
}

// ── lavfi / silent WAV helpers ─────────────────────────────────────────────

/**
 * Checks whether the ffmpeg binary supports the lavfi input device (anullsrc, etc.).
 * Result is cached after first check.
 */
async function probeLavfiSupport(): Promise<boolean> {
  if (lavfiCache !== null) return lavfiCache

  // Quick probe: run a minimal lavfi command that produces no output.
  // Exit code 0 = supported, non-zero = not available.
  try {
    await new Promise<void>((resolve, reject) => {
      const cmd = Ffmpeg()
        .input('anullsrc=r=48000:channel_layout=stereo')
        .inputOptions(['-f', 'lavfi', '-t', '0.01'])
        .outputOptions('-f', 'null', '-')
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .run()
      void cmd // suppress unused variable warning
    })
    lavfiCache = true
  } catch {
    lavfiCache = false
  }

  return lavfiCache
}

/**
 * Generates a minimal silent WAV file using Node.js alone (PCM 16-bit, 48kHz, stereo).
 * This avoids depending on lavfi support in the ffmpeg binary.
 * The generated file is exactly `durationSeconds` long.
 */
async function createSilentWavFile(outputPath: string, durationSeconds: number): Promise<void> {
  const sampleRate = 48000
  const channels = 2
  const bitsPerSample = 16
  const numSamples = Math.ceil(sampleRate * durationSeconds)
  const dataSize = numSamples * channels * (bitsPerSample / 8)
  const fileSize = 36 + dataSize

  const buf = Buffer.alloc(44 + dataSize)

  // RIFF header
  buf.write('RIFF', 0)
  buf.writeUInt32LE(fileSize, 4)
  buf.write('WAVE', 8)

  // fmt chunk
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // chunk size
  buf.writeUInt16LE(1, 20) // audio format (PCM)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28) // byte rate
  buf.writeUInt16LE((channels * bitsPerSample) / 8, 32) // block align
  buf.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  // PCM silence is all zeros — buffer is already zero-filled

  await fs.promises.writeFile(outputPath, buf)
}

// ── Encoder detection ───────────────────────────────────────────────────────

async function probeFfmpegEncoders(): Promise<Set<string>> {
  if (!encoderProbePromise) {
    encoderProbePromise = new Promise<Set<string>>((resolve, reject) => {
      Ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) {
          reject(
            new Error(
              'Failed to probe FFmpeg encoders. FFmpeg is required. Please install ffmpeg and ensure it is available in PATH.',
              { cause: err }
            )
          )
        } else {
          resolve(new Set(Object.keys(encoders)))
        }
      })
    })
  }

  return encoderProbePromise
}

function hasVaapiDevice(): boolean {
  return fs.existsSync('/dev/dri/renderD128')
}

function selectVideoEncoder(encoders: Set<string>): VideoEncoderConfig {
  const software: VideoEncoderConfig = {
    name: 'libx264',
    label: 'Software H.264 (libx264)',
    globalArgs: [],
    outputArgs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium']
  }

  const candidates: VideoEncoderConfig[] = []

  if (process.platform === 'darwin') {
    candidates.push({
      name: 'h264_videotoolbox',
      label: 'Hardware H.264 (VideoToolbox)',
      globalArgs: [],
      outputArgs: ['-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', '-b:v', '12000k']
    })
  }

  candidates.push(
    {
      name: 'h264_nvenc',
      label: 'Hardware H.264 (NVIDIA NVENC)',
      globalArgs: [],
      outputArgs: ['-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-cq', '18']
    },
    {
      name: 'h264_qsv',
      label: 'Hardware H.264 (Intel Quick Sync)',
      globalArgs: [],
      outputArgs: ['-c:v', 'h264_qsv', '-pix_fmt', 'nv12', '-global_quality', '18']
    },
    {
      name: 'h264_amf',
      label: 'Hardware H.264 (AMD AMF)',
      globalArgs: [],
      outputArgs: ['-c:v', 'h264_amf', '-pix_fmt', 'yuv420p', '-quality', 'quality', '-qp_i', '18']
    }
  )

  if (process.platform === 'linux' && hasVaapiDevice()) {
    candidates.push({
      name: 'h264_vaapi',
      label: 'Hardware H.264 (VAAPI)',
      globalArgs: ['-vaapi_device', '/dev/dri/renderD128'],
      outputArgs: ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '20']
    })
  }

  return candidates.find((candidate) => encoders.has(candidate.name)) ?? software
}

// ── Audio duration probing ──────────────────────────────────────────────────

async function probeAudioDurationMs(voicePath: string): Promise<number> {
  await fs.promises.access(voicePath, fs.constants.R_OK)

  return new Promise<number>((resolve, reject) => {
    Ffmpeg.ffprobe(voicePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe audio duration: ${voicePath}`, { cause: err }))
      } else if (metadata?.format?.duration != null) {
        resolve(metadata.format.duration * 1000)
      } else {
        reject(new Error(`No duration found for: ${voicePath}`))
      }
    })
  })
}

// ── Progress helpers ────────────────────────────────────────────────────────

function parseTimeMarkToMs(timemark: string): number {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(timemark)
  if (!match) return 0
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  const seconds = Number.parseFloat(match[3])

  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

function sendFrameExportProgress(
  event: IpcMainInvokeEvent,
  payload: FrameExportProgressPayload
): void {
  event.sender.send('electron:frame-export-progress', payload)
}

// ── Streaming merge (core FFmpeg operation) ─────────────────────────────────

function runStreamingMerge(
  event: IpcMainInvokeEvent,
  session: FrameExportSession,
  payload: FinishFrameExportPayload,
  videoPath: string,
  encoder: VideoEncoderConfig,
  totalDurationMs: number,
  lavfiAvailable: boolean,
  silentWavPath: string | null
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Create a PassThrough stream and write all buffered frames into it
    const frameStream = new PassThrough()

    // Write frames asynchronously so fluent-ffmpeg has time to set up its pipe listener
    setImmediate(() => {
      for (const buffer of session.frameBuffers) {
        frameStream.write(buffer)
      }
      frameStream.end()
    })

    // Build the ffmpeg command
    const command = Ffmpeg()

    // ── video input (stdin pipe: image2pipe) ──
    command
      .input(frameStream)
      .inputOptions([
        ...encoder.globalArgs,
        '-f',
        'image2pipe',
        '-framerate',
        payload.fps.toString()
      ])

    // ── audio inputs ──
    const durationSeconds = Math.max(
      payload.totalDurationMs / 1000,
      payload.frameCount / payload.fps
    )
    const durationText = durationSeconds.toFixed(3)

    if (payload.audioEvents.length > 0) {
      // Use lavfi anullsrc if available, otherwise use the pre-generated silent WAV
      if (lavfiAvailable) {
        // Silent reference track via lavfi (supported on system ffmpeg)
        command
          .input('anullsrc=channel_layout=stereo:sample_rate=48000')
          .inputOptions(['-f', 'lavfi', '-t', durationText])
      } else if (silentWavPath) {
        // Use the silent WAV as reference audio, looping indefinitely
        command.input(silentWavPath).inputOptions(['-stream_loop', '-1', '-t', durationText])
      }

      // Individual voice files
      for (const audioEvent of payload.audioEvents) {
        command.input(getVoicePath(session.storyFolder!, audioEvent.voice))
      }

      // Build filter_complex for audio delay + mixing
      const filterParts: string[] = payload.audioEvents.map((audioEvent, index) => {
        const inputIndex = index + 2
        const delay = Math.max(0, Math.round(audioEvent.startTimeMs))
        return `[${inputIndex}:a]adelay=${delay}:all=1,aresample=48000[a${index}]`
      })
      const mixInputs = ['[1:a]', ...payload.audioEvents.map((_, i) => `[a${i}]`)].join('')
      filterParts.push(
        `${mixInputs}amix=inputs=${payload.audioEvents.length + 1}:duration=first:dropout_transition=0[aout]`
      )

      command
        .complexFilter(filterParts)
        .outputOptions('-map', '0:v')
        .outputOptions('-map', '[aout]')
        .outputOptions('-t', durationText)
        .audioCodec('aac')
        .audioBitrate('192k')
    }

    // ── encoder-specific output args ──
    command.outputOptions(encoder.outputArgs)

    // ── progress reporting ──
    sendFrameExportProgress(event, {
      phase: 'merging',
      percent: 0,
      message: `Merging video with ${encoder.label}`
    })

    command
      .on('progress', (info) => {
        const progress =
          info.percent !== undefined
            ? info.percent / 100
            : totalDurationMs > 0
              ? parseTimeMarkToMs(info.timemark) / totalDurationMs
              : 0
        const clamped = Math.min(progress, 1)
        sendFrameExportProgress(event, {
          phase: 'merging',
          percent: clamped,
          message: `Merging video with ${encoder.label} ${(clamped * 100).toFixed(1)}%`
        })
      })
      .on('end', () => {
        sendFrameExportProgress(event, {
          phase: 'merging',
          percent: 1,
          message: `Video merge complete with ${encoder.label}.`
        })
        if (silentWavPath) {
          fs.promises.unlink(silentWavPath).catch(() => {
            /* ignore cleanup errors */
          })
        }
        resolve(videoPath)
      })
      .on('error', (err) => {
        if (silentWavPath) {
          fs.promises.unlink(silentWavPath).catch(() => {
            /* ignore cleanup errors */
          })
        }
        reject(new Error(`FFmpeg error (${encoder.name}): ${err.message}`))
      })
      .output(videoPath)
      .run()
  })
}

async function mergeFramesWithFfmpeg(
  event: IpcMainInvokeEvent,
  session: FrameExportSession,
  payload: FinishFrameExportPayload
): Promise<string> {
  if (!session.outputDir) {
    throw new Error('Frame export session has not been started.')
  }

  // CLI 模式下使用指定的视频输出路径
  const videoPath = cliArgs ? cliArgs.outputFile : path.join(session.outputDir, 'output.mp4')

  // 确保视频输出目录存在
  const videoDir = path.dirname(videoPath)
  await fs.promises.mkdir(videoDir, { recursive: true })

  const totalDurationMs = Math.max(
    payload.totalDurationMs,
    (payload.frameCount / payload.fps) * 1000
  )
  const encoders = await probeFfmpegEncoders()
  const selectedEncoder = selectVideoEncoder(encoders)
  const fallbackEncoder = selectVideoEncoder(new Set(['libx264']))

  // Probe lavfi support and generate silent WAV outside the Promise
  // so the Promise executor stays synchronous (avoids no-async-promise-executor lint error)
  const lavfiAvailable = payload.audioEvents.length > 0 ? await probeLavfiSupport() : false
  let silentWavPath: string | null = null
  if (!lavfiAvailable && payload.audioEvents.length > 0) {
    const tmpSilentWav = path.join(
      session.outputDir ?? process.env.TMPDIR ?? '/tmp',
      `mss-silence-${Date.now()}.wav`
    )
    await createSilentWavFile(tmpSilentWav, 1)
    silentWavPath = tmpSilentWav
  }

  try {
    return await runStreamingMerge(
      event,
      session,
      payload,
      videoPath,
      selectedEncoder,
      totalDurationMs,
      lavfiAvailable,
      silentWavPath
    )
  } catch (error) {
    if (selectedEncoder.name === fallbackEncoder.name) throw error

    sendFrameExportProgress(event, {
      phase: 'merging',
      percent: 0,
      message: `${selectedEncoder.label} failed, falling back to ${fallbackEncoder.label}.`
    })

    return await runStreamingMerge(
      event,
      session,
      payload,
      videoPath,
      fallbackEncoder,
      totalDurationMs,
      lavfiAvailable,
      silentWavPath
    )
  } finally {
    // Release frame buffer memory
    session.frameBuffers = []
  }
}

// ── IPC handler setup ────────────────────────────────────────────────────────

async function setupIpcHandlers(logger: Logger<ILogObj>): Promise<void> {
  ipcMain.handle(
    'electron:select-story-file-until-selected',
    async (): Promise<SelectStoryResponse> => {
      logger.info('Handle IPC event: electron:select-story-file-until-selected')
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select a story file',
        filters: [
          {
            name: 'Sekai Story File',
            extensions: ['sekai-story.json']
          }
        ],
        properties: ['openFile']
      })

      if (canceled) {
        app.exit(0)
      }

      const filePath = filePaths[0]

      try {
        const normalizedPath: string = path.resolve(filePath!)

        const rawData = await fs.promises.readFile(normalizedPath, 'utf8')

        const parsedData: StoryData = StorySchema.parse(JSON.parse(rawData))

        return { success: true, path: normalizedPath, data: parsedData }
      } catch (error) {
        if (error instanceof z.ZodError) {
          const errorMessage = error.issues
            .map((issue) => `'${issue.path.join('.')}': ${issue.message}`)
            .join('\n')
          return { success: false, zodIssueMessage: errorMessage, error: error }
        } else {
          return { success: false, error: error }
        }
      }
    }
  )

  ipcMain.on(
    'electron:on-error',
    (
      _event,
      err: {
        name: string
        message: string
        stack?: string
        cause?: unknown
      }
    ) => {
      logger.info('Handle IPC event: electron:on-error')
      console.error(typeof err)

      let detail: string
      if (err.cause && err.stack) {
        detail = `${err.stack}\n\nCause: \n${JSON.stringify(err.cause, undefined, 2).replace(
          '\\n',
          '\n'
        )}`
      } else if (err.stack) {
        detail = err.stack
      } else {
        detail = `${err.name}: ${err.message}`
      }

      dialog
        .showMessageBox({
          type: 'error',
          title: 'Render Error',
          message: 'An error occurred.',
          detail: detail,
          buttons: ['Reload', 'Exit']
        })
        .then((resp) => {
          if (resp.response === 0) mainWindow.reload()
          else app.quit()
        })
    }
  )

  ipcMain.on('electron:resize', (_event, width: number, height: number) => {
    logger.info('Handle IPC event: electron:resize')
    logger.info(`Resize size: ${width}x${height}`)

    const [oldX, oldY] = mainWindow.getPosition()
    const [oldWidth, oldHeight] = mainWindow.getSize()

    const centerX = oldX + oldWidth / 2
    const centerY = oldY + oldHeight / 2

    const newX = Math.floor(centerX - width / 2)
    const newY = Math.floor(centerY - height / 2)

    mainWindow.setContentSize(width, height, true)
    mainWindow.setPosition(newX, newY, true)
  })

  ipcMain.handle(
    'electron:select-export-directory',
    async (): Promise<SelectExportDirectoryResponse> => {
      logger.info('Handle IPC event: electron:select-export-directory')

      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select export directory',
        properties: ['openDirectory', 'createDirectory']
      })

      if (canceled || filePaths.length === 0) {
        return { canceled: true }
      }

      return { canceled: false, path: filePaths[0] }
    }
  )

  ipcMain.handle(
    'electron:probe-story-voice-durations',
    async (
      _event,
      payload: ProbeStoryVoiceDurationsPayload
    ): Promise<ProbeStoryVoiceDurationsResponse> => {
      logger.info('Handle IPC event: electron:probe-story-voice-durations')

      const storyFolder = path.dirname(payload.storyPath)
      const uniqueVoices = Array.from(new Set(payload.voices))
      const durations: Record<string, number> = {}

      for (const voice of uniqueVoices) {
        durations[voice] = await probeAudioDurationMs(getVoicePath(storyFolder, voice))
      }

      return { durations }
    }
  )

  ipcMain.handle(
    'electron:start-frame-export',
    async (_event, payload: StartFrameExportPayload): Promise<StartFrameExportResponse> => {
      logger.info('Handle IPC event: electron:start-frame-export')

      // CLI 模式下使用指定的输出目录
      let outputDir: string
      if (cliArgs) {
        outputDir = cliArgs.outputDir
      } else {
        const storyName = getStoryName(payload.storyPath)
        outputDir = path.join(payload.outputRoot, `${storyName}-${createTimestamp()}`)
      }

      await fs.promises.mkdir(outputDir, { recursive: true })
      await fs.promises.writeFile(
        path.join(outputDir, 'metadata.json'),
        JSON.stringify(
          {
            storyPath: payload.storyPath,
            fps: payload.fps,
            width: payload.width,
            height: payload.height,
            createdAt: new Date().toISOString()
          },
          undefined,
          2
        ),
        'utf8'
      )

      frameExportSession.outputDir = outputDir
      frameExportSession.storyPath = payload.storyPath
      frameExportSession.storyFolder = path.dirname(payload.storyPath)
      frameExportSession.fps = payload.fps
      frameExportSession.width = payload.width
      frameExportSession.height = payload.height
      frameExportSession.frameBuffers = []
      logger.info(`Frame export directory: ${outputDir}`)

      return { success: true, outputDir }
    }
  )

  ipcMain.handle(
    'electron:save-frame',
    async (_event, payload: SaveFramePayload): Promise<boolean> => {
      if (!frameExportSession.outputDir) {
        throw new Error('Frame export session has not been started.')
      }

      // Buffer in memory instead of writing individual PNG files to disk
      frameExportSession.frameBuffers.push(toFrameBuffer(payload.buffer))

      return true
    }
  )

  ipcMain.handle(
    'electron:finish-frame-export',
    async (event, payload: FinishFrameExportPayload): Promise<FinishFrameExportResponse> => {
      logger.info('Handle IPC event: electron:finish-frame-export')
      logger.info(`Frame export finished, frame count: ${payload.frameCount}`)

      if (!frameExportSession.outputDir) {
        throw new Error('Frame export session has not been started.')
      }

      await fs.promises.writeFile(
        path.join(frameExportSession.outputDir, 'audio-manifest.json'),
        JSON.stringify(payload.audioEvents satisfies RenderAudioEvent[], undefined, 2),
        'utf8'
      )

      const videoPath = await mergeFramesWithFfmpeg(event, frameExportSession, payload)
      const outputDir = frameExportSession.outputDir

      frameExportSession.outputDir = null
      frameExportSession.storyPath = null
      frameExportSession.storyFolder = null
      frameExportSession.frameBuffers = []

      return { outputDir, frameCount: payload.frameCount, videoPath }
    }
  )

  ipcMain.on('electron:render-finished', () => {
    logger.info('Handle IPC event: electron:render-finished')

    try {
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.focus()
      mainWindow.flashFrame(true)
      mainWindow.moveTop()
    } catch (error) {
      logger.error('Failed to bring main window to front after render finished.', error)
    }
  })

  // CLI 模式相关 IPC handlers
  ipcMain.handle('electron:get-cli-args', () => {
    logger.info('Handle IPC event: electron:get-cli-args')
    return cliArgs
  })

  ipcMain.handle(
    'electron:load-story-from-path',
    async (_event, storyPath: string): Promise<LoadStoryFromPathResponse> => {
      logger.info('Handle IPC event: electron:load-story-from-path')
      logger.info(`Loading story from path: ${storyPath}`)

      try {
        const normalizedPath = path.resolve(storyPath)
        const rawData = await fs.promises.readFile(normalizedPath, 'utf8')
        const parsedData = StorySchema.parse(JSON.parse(rawData))

        return { success: true, path: normalizedPath, data: parsedData }
      } catch (error) {
        if (error instanceof z.ZodError) {
          const errorMessage = error.issues
            .map((issue) => `'${issue.path.join('.')}': ${issue.message}`)
            .join('\n')
          return { success: false, error: errorMessage }
        } else {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    }
  )

  ipcMain.on('electron:cli-render-finished', () => {
    logger.info('Handle IPC event: electron:cli-render-finished')

    if (cliArgs?.exit) {
      logger.info('CLI mode: --exit flag set, quitting app')
      app.quit()
    }
  })

  ipcMain.on('electron:cli-progress', (_event, state: CliProgressState) => {
    if (!cliArgs) return

    const formatEta = (ms: number | null | undefined): string => {
      if (ms === null || ms === undefined || ms < 0) return '--:--'
      const seconds = Math.floor(ms / 1000)
      const minutes = Math.floor(seconds / 60)
      const hours = Math.floor(minutes / 60)
      if (hours > 0) {
        return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
      }
      return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`
    }

    switch (state.phase) {
      case 'preparing':
        if (state.message) {
          console.log(`[preparing] ${state.message}`)
        }
        break
      case 'rendering': {
        const percentStr =
          state.percent !== undefined ? `${(state.percent * 100).toFixed(1)}%` : '0.0%'
        const frameStr =
          state.frameIndex !== undefined && state.totalFrameCount !== undefined
            ? `Frame ${state.frameIndex}/${state.totalFrameCount}`
            : ''
        const speedStr =
          state.speed !== undefined
            ? `FPS: ${(state.speed * (state.targetFps ?? 60)).toFixed(1)} (${state.speed.toFixed(2)}x)`
            : ''
        const etaStr = state.etaMs !== undefined ? `ETA: ${formatEta(state.etaMs)}` : ''
        const parts = [percentStr, frameStr, speedStr, etaStr].filter(Boolean)
        process.stdout.write(`\r[rendering]  ${parts.join(' | ')}`)
        break
      }
      case 'merging': {
        const ffmpegPercent =
          state.ffmpegPercent !== undefined ? `${(state.ffmpegPercent * 100).toFixed(1)}%` : '0.0%'
        console.log(`\n[merging]    FFmpeg: ${ffmpegPercent}`)
        break
      }
      case 'done': {
        const videoPath = state.outputFile || state.outputDir || 'unknown'
        console.log(`\n[done]       Video saved: ${videoPath}`)
        break
      }
      case 'error':
        console.error(`\n[error]      ${state.message ?? 'Unknown error'}`)
        break
      default:
        if (state.message) {
          console.log(`[${state.phase}] ${state.message}`)
        }
    }
  })
}

export default setupIpcHandlers
