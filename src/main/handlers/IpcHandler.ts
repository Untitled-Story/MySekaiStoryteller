import { ILogObj, Logger } from 'tslog'
import { app, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import { SelectStoryResponse, LoadStoryFromPathResponse, CliProgressState } from '../../common/types/IpcResponse'
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
}

interface ProcessResult {
  stdout: string
  stderr: string
}

interface VideoEncoderConfig {
  name: string
  label: string
  globalArgs: string[]
  outputArgs: string[]
}

const frameExportSession: FrameExportSession = {
  outputDir: null,
  storyPath: null,
  storyFolder: null,
  fps: 60,
  width: 0,
  height: 0
}

let encoderProbePromise: Promise<Set<string>> | null = null

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

function resolveFfmpegExecutable(): string {
  return 'ffmpeg'
}

function resolveFfprobeExecutable(): string {
  return 'ffprobe'
}

async function probeFfmpegEncoders(): Promise<Set<string>> {
  if (!encoderProbePromise) {
    encoderProbePromise = runProcess(resolveFfmpegExecutable(), ['-hide_banner', '-encoders']).then(
      ({ stdout, stderr }) => {
        const output = `${stdout}\n${stderr}`.split('------').at(-1) || ''
        const encoders = new Set<string>()
        const encoderPattern = /^\s*[VAS.][F.][S.][X.][B.][D.]\s+([^\s]+)/gmu
        let match: RegExpExecArray | null

        while ((match = encoderPattern.exec(output)) !== null) {
          encoders.add(match[1])
        }

        return encoders
      }
    )
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

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      reject(
        new Error(
          `${command} failed to start. FFmpeg is required. Please install ffmpeg and ensure it is available in PATH.`,
          { cause: error }
        )
      )
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(`${command} exited with code ${code}.\n${stderr}`))
    })
  })
}

async function probeAudioDurationMs(voicePath: string): Promise<number> {
  await fs.promises.access(voicePath, fs.constants.R_OK)

  const { stdout } = await runProcess(resolveFfprobeExecutable(), [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    voicePath
  ])

  const durationSeconds = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`Failed to probe audio duration: ${voicePath}`)
  }

  return durationSeconds * 1000
}

function parseProgressTimeMs(line: string): number | null {
  const [key, value] = line.trim().split('=')
  if (!key || !value) return null

  if (key === 'out_time_us' || key === 'out_time_ms') {
    const raw = Number.parseInt(value, 10)
    if (!Number.isFinite(raw)) return null
    return raw / 1000
  }

  if (key === 'out_time') {
    const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(value)
    if (!match) return null

    const hours = Number.parseInt(match[1], 10)
    const minutes = Number.parseInt(match[2], 10)
    const seconds = Number.parseFloat(match[3])

    return (hours * 3600 + minutes * 60 + seconds) * 1000
  }

  return null
}

function sendFrameExportProgress(
  event: IpcMainInvokeEvent,
  payload: FrameExportProgressPayload
): void {
  event.sender.send('electron:frame-export-progress', payload)
}

function buildFfmpegArgs(
  session: FrameExportSession,
  payload: FinishFrameExportPayload,
  videoPath: string,
  encoder: VideoEncoderConfig
): string[] {
  if (!session.outputDir || !session.storyFolder) {
    throw new Error('Frame export session has not been started.')
  }

  const durationSeconds = Math.max(payload.totalDurationMs / 1000, payload.frameCount / payload.fps)
  const durationText = durationSeconds.toFixed(3)
  const framePattern = path.join(session.outputDir, '%06d.png')

  const args = [
    '-y',
    '-hide_banner',
    ...encoder.globalArgs,
    '-loglevel',
    'error',
    '-progress',
    'pipe:2',
    '-nostats',
    '-framerate',
    payload.fps.toString(),
    '-i',
    framePattern
  ]

  if (payload.audioEvents.length > 0) {
    args.push(
      '-f',
      'lavfi',
      '-t',
      durationText,
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000'
    )

    payload.audioEvents.forEach((audioEvent) => {
      args.push('-i', getVoicePath(session.storyFolder!, audioEvent.voice))
    })

    const filters = payload.audioEvents.map((audioEvent, index) => {
      const inputIndex = index + 2
      const delay = Math.max(0, Math.round(audioEvent.startTimeMs))
      return `[${inputIndex}:a]adelay=${delay}:all=1,aresample=48000[a${index}]`
    })
    const mixInputs = ['[1:a]', ...payload.audioEvents.map((_, index) => `[a${index}]`)].join('')
    filters.push(
      `${mixInputs}amix=inputs=${payload.audioEvents.length + 1}:duration=first:dropout_transition=0[aout]`
    )

    args.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-t',
      durationText,
      '-c:a',
      'aac',
      '-b:a',
      '192k'
    )
  }

  args.push(...encoder.outputArgs, videoPath)

  return args
}

function runFfmpegMerge(
  event: IpcMainInvokeEvent,
  args: string[],
  totalDurationMs: number,
  videoPath: string,
  encoder: VideoEncoderConfig
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(), args, { windowsHide: true })
    let stderr = ''
    let progressBuffer = ''

    sendFrameExportProgress(event, {
      phase: 'merging',
      percent: 0,
      message: `Merging video with ${encoder.label}`
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      progressBuffer += text

      const lines = progressBuffer.split(/\r?\n/u)
      progressBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const outTimeMs = parseProgressTimeMs(line)
        if (outTimeMs === null) continue

        const percent = totalDurationMs > 0 ? Math.min(outTimeMs / totalDurationMs, 1) : 0
        sendFrameExportProgress(event, {
          phase: 'merging',
          percent,
          message: `Merging video with ${encoder.label} ${(percent * 100).toFixed(1)}%`
        })
      }
    })

    child.on('error', (error) => {
      reject(
        new Error(
          'ffmpeg failed to start. FFmpeg is required to merge rendered frames. Please install ffmpeg and ensure it is available in PATH.',
          { cause: error }
        )
      )
    })

    child.on('close', (code) => {
      if (code === 0) {
        sendFrameExportProgress(event, {
          phase: 'merging',
          percent: 1,
          message: `Video merge complete with ${encoder.label}.`
        })
        resolve(videoPath)
        return
      }

      reject(new Error(`ffmpeg exited with code ${code}.\n${stderr}`))
    })
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

  try {
    const args = buildFfmpegArgs(session, payload, videoPath, selectedEncoder)
    return await runFfmpegMerge(event, args, totalDurationMs, videoPath, selectedEncoder)
  } catch (error) {
    if (selectedEncoder.name === fallbackEncoder.name) throw error

    sendFrameExportProgress(event, {
      phase: 'merging',
      percent: 0,
      message: `${selectedEncoder.label} failed, falling back to ${fallbackEncoder.label}.`
    })

    const args = buildFfmpegArgs(session, payload, videoPath, fallbackEncoder)
    return runFfmpegMerge(event, args, totalDurationMs, videoPath, fallbackEncoder)
  }
}

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
      logger.info(`Frame export directory: ${outputDir}`)

      return { success: true, outputDir }
    }
  )

  ipcMain.handle(
    'electron:save-frame',
    async (_event, payload: SaveFramePayload): Promise<string> => {
      if (!frameExportSession.outputDir) {
        throw new Error('Frame export session has not been started.')
      }

      const filename = `${payload.index.toString().padStart(6, '0')}.png`
      const outputPath = path.join(frameExportSession.outputDir, filename)

      await fs.promises.writeFile(outputPath, toFrameBuffer(payload.buffer))

      return outputPath
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

  ipcMain.handle('electron:load-story-from-path', async (_event, storyPath: string): Promise<LoadStoryFromPathResponse> => {
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
  })

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
        const percentStr = state.percent !== undefined ? `${(state.percent * 100).toFixed(1)}%` : '0.0%'
        const frameStr = state.frameIndex !== undefined && state.totalFrameCount !== undefined
          ? `Frame ${state.frameIndex}/${state.totalFrameCount}`
          : ''
        const speedStr = state.speed !== undefined ? `FPS: ${(state.speed * (state.targetFps ?? 60)).toFixed(1)} (${state.speed.toFixed(2)}x)` : ''
        const etaStr = state.etaMs !== undefined ? `ETA: ${formatEta(state.etaMs)}` : ''
        const parts = [percentStr, frameStr, speedStr, etaStr].filter(Boolean)
        process.stdout.write(`\r[rendering]  ${parts.join(' | ')}`)
        break
      }
      case 'merging': {
        const ffmpegPercent = state.ffmpegPercent !== undefined ? `${(state.ffmpegPercent * 100).toFixed(1)}%` : '0.0%'
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
