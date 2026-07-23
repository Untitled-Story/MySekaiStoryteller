import { invoke } from '@tauri-apps/api/core'
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import {
  editorRoutePath,
  exportRoutePath,
  homeRoutePath,
  playerRoutePath,
  prefersInAppNavigation
} from '@/lib/platform'
import { stashPendingRenderConfig } from '@/export/pendingRenderConfig'
import type { RenderConfig } from '@/settings/types'

type NavigateFn = (path: string) => void

let navigateHandler: NavigateFn | null = null

export type StartRenderResult = {
  uploadUrl: string
  sessionId: string
}

export type WorkerPlan = {
  workerIndex: number
  startFrame: number
  endFrame: number
  segmentPath: string
  sessionKey: string
}

export type PrepareParallelExportResult = {
  sessionId: string
  tempDir: string
  workers: WorkerPlan[]
}

export type FfmpegProgressEvent = {
  ratio: number
  outTimeSec: number
  totalDurationSec: number
}

export function registerAppNavigator(navigate: NavigateFn | null): void {
  navigateHandler = navigate
}

function navigateInApp(path: string): void {
  if (navigateHandler) {
    navigateHandler(path)
    return
  }

  const hashPath: string = path.startsWith('/') ? `#${path}` : `#/${path}`
  window.location.hash = hashPath
}

export async function openEditorWindow(projectName: string): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(editorRoutePath(projectName))
    return
  }
  await invoke('open_editor', { projectName })
}

export async function openPlayerWindow(
  projectName: string,
  render: boolean = false,
  renderConfig?: RenderConfig
): Promise<void> {
  // Mobile/Android: single webview — never multi-window open_player for render.
  if (prefersInAppNavigation()) {
    if (render) {
      const config: RenderConfig = {
        ...(renderConfig ?? {
          exportPath: '',
          width: 1280,
          height: 720,
          fps: 30
        }),
        // Parallel workers require extra windows; force single-path on mobile.
        concurrency: 1,
        role: 'single',
        workers: 1
      }
      if (!config.exportPath) {
        throw new Error('渲染路径无效')
      }
      stashPendingRenderConfig(projectName, config)
      navigateInApp(exportRoutePath(projectName))
      return
    }
    navigateInApp(playerRoutePath(projectName))
    return
  }
  await invoke('open_player', {
    projectName,
    render,
    renderConfig: renderConfig ?? null
  })
}

export async function closeEditorWindow(): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(homeRoutePath())
    return
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  } catch {
    navigateInApp(homeRoutePath())
  }
}

export async function closePlayerWindow(): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(homeRoutePath())
    return
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  } catch {
    navigateInApp(homeRoutePath())
  }
}

export function closeExportWorker(workerIndex: number): Promise<void> {
  return invoke('close_export_worker', { workerIndex })
}

export function startRenderSession(
  projectName: string,
  config: RenderConfig & { sessionId?: string }
): Promise<StartRenderResult> {
  return invoke<StartRenderResult>('start_render_session', {
    projectName,
    config: {
      exportPath: config.segmentPath ?? config.exportPath,
      width: config.width,
      height: config.height,
      fps: config.fps,
      sessionId: config.sessionId
    }
  })
}

export function stopRenderSession(projectName: string): Promise<void> {
  return invoke('stop_render_session', { projectName })
}

export function prepareParallelExport(args: {
  projectName: string
  exportPath: string
  concurrency: number
  totalFrames: number
  width: number
  height: number
  fps: number
  dataPath: string
}): Promise<PrepareParallelExportResult> {
  return invoke<PrepareParallelExportResult>('prepare_parallel_export', { args })
}

export function finalizeRenderDelivery(
  sourcePath: string,
  exportPath: string,
  totalDurationSec?: number
): Promise<void> {
  return invoke('finalize_render_delivery', {
    args: {
      sourcePath,
      exportPath,
      totalDurationSec
    }
  })
}

export function concatRenderSegments(
  segmentPaths: string[],
  exportPath: string,
  totalDurationSec?: number
): Promise<void> {
  return invoke('concat_render_segments', {
    args: {
      segmentPaths,
      exportPath,
      totalDurationSec:
        typeof totalDurationSec === 'number' && Number.isFinite(totalDurationSec)
          ? totalDurationSec
          : undefined
    }
  })
}

export function cleanupExportTemp(tempDir: string): Promise<void> {
  return invoke('cleanup_export_temp', { tempDir })
}

/** Returns segment duration seconds; throws if unreadable/incomplete. */
export function validateRenderSegment(
  path: string,
  minDurationSec: number = 0.01
): Promise<number> {
  return invoke<number>('validate_render_segment', {
    path,
    minDurationSec
  })
}

const streamFrameSlotBySession: Map<string, number> = new Map()
/** After IPC fails, prefer file bridge until this timestamp (ms). */
const streamFramePreferFileUntil: Map<string, number> = new Map()
/** Reused canvas for mobile RGBA→JPEG compression (avoids multi-MB IPC). */
let mobileJpegCanvas: HTMLCanvasElement | null = null
let mobileJpegCtx: CanvasRenderingContext2D | null = null

function isMobileUa(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

async function rgbaToJpegBytes(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number = 0.82
): Promise<Uint8Array> {
  if (width < 1 || height < 1) {
    throw new Error('invalid jpeg dimensions')
  }
  const expected = width * height * 4
  if (rgba.byteLength < expected) {
    throw new Error(`rgba too small ${rgba.byteLength} < ${expected}`)
  }
  if (!mobileJpegCanvas) {
    mobileJpegCanvas = document.createElement('canvas')
    mobileJpegCtx = mobileJpegCanvas.getContext('2d', { willReadFrequently: true })
  }
  const canvas = mobileJpegCanvas
  const ctx = mobileJpegCtx
  if (!canvas || !ctx) {
    throw new Error('jpeg canvas unavailable')
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  // Copy into a fresh clamped buffer — ImageData rejects shared/offset views on some WebViews.
  const clamped = new Uint8ClampedArray(expected)
  clamped.set(rgba.subarray(0, expected))
  const imageData = new ImageData(clamped, width, height)
  ctx.putImageData(imageData, 0, 0)
  const blob: Blob | null = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  })
  if (!blob) {
    throw new Error('canvas.toBlob jpeg failed')
  }
  const ab = await blob.arrayBuffer()
  return new Uint8Array(ab)
}

export type StreamFrameOptions = {
  width?: number
  height?: number
}

/** Push packed RGBA frame bytes into the native encode queue. */
export async function streamFrame(
  projectName: string,
  data: Uint8Array | number[],
  options?: StreamFrameOptions
): Promise<void> {
  let bytes: Uint8Array = data instanceof Uint8Array ? data : Uint8Array.from(data)
  // Do NOT Array.from() multi-MB frames into number[] (JSON freezes Android WebView).

  const safeName = projectName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48)
  const slot: number = (streamFrameSlotBySession.get(safeName) ?? 0) + 1
  streamFrameSlotBySession.set(safeName, slot)
  const mobile = isMobileUa()
  // Mobile file bridge: prefer raw RGBA (AppCache).
  // JPEG was added to shrink IPC, but on 13 Pro toBlob+decode cost 300–850ms/frame and
  // dominated wall clock after capture/readback were already ~20ms. RGBA file write is faster
  // overall once encode reuses a GlobalRef NV12 buffer (no per-frame Java OOM).
  // Keep JPEG only as fallback when RGBA file stream fails repeatedly.
  let fileName: string = `render-frame-${safeName}-${slot}.rgba`
  const preferJpeg =
    mobile &&
    bytes.byteLength >= 160 * 90 * 4 &&
    (streamFramePreferFileUntil.get(`${safeName}:jpeg`) ?? 0) > Date.now()
  if (preferJpeg) {
    let w = Math.max(0, Math.floor(options?.width ?? 0))
    let h = Math.max(0, Math.floor(options?.height ?? 0))
    if (w * h * 4 !== bytes.byteLength) {
      const px = bytes.byteLength / 4
      w = 0
      h = 0
      for (const candW of [1920, 1600, 1280, 960, 854, 720, 640, 480]) {
        if (px % candW === 0) {
          const candH = px / candW
          if (candH >= 90 && candH <= 2160) {
            w = candW
            h = candH
            break
          }
        }
      }
    }
    if (w > 0 && h > 0 && w * h * 4 === bytes.byteLength) {
      try {
        bytes = await rgbaToJpegBytes(bytes, w, h, 0.75)
        fileName = `render-frame-${safeName}-${slot}.jpg`
      } catch {
        // Fall through with raw RGBA.
      }
    }
  }

  // Desktop: prefer IPC. Mobile: prefer AppCache file bridge of RGBA (or JPEG fallback).
  // Never use BaseDirectory.Cache on Android (external cache outside $APPCACHE).
  const preferFile = mobile || (streamFramePreferFileUntil.get(safeName) ?? 0) > Date.now()

  async function viaFile(): Promise<void> {
    await writeFile(fileName, bytes, { baseDir: BaseDirectory.AppCache })
    await invoke('stream_frame_file', {
      projectName,
      path: fileName
    })
  }

  async function viaIpc(): Promise<void> {
    await invoke('stream_frame', {
      projectName,
      data: bytes
    })
  }

  if (preferFile) {
    try {
      await viaFile()
      return
    } catch (fileError: unknown) {
      // If raw RGBA file path fails on mobile, try JPEG file for a while (smaller).
      if (mobile && !fileName.endsWith('.jpg') && bytes.byteLength >= 160 * 90 * 4) {
        streamFramePreferFileUntil.set(`${safeName}:jpeg`, Date.now() + 30_000)
      }
      try {
        await viaIpc()
        if (mobile) {
          // Prefer file again soon — multi-MB IPC is still worse than file on Android.
          streamFramePreferFileUntil.set(safeName, Date.now() + 30_000)
        } else {
          streamFramePreferFileUntil.delete(safeName)
        }
        return
      } catch (directError: unknown) {
        const fileMsg = fileError instanceof Error ? fileError.message : String(fileError)
        const directMsg = directError instanceof Error ? directError.message : String(directError)
        throw new Error(`Frame stream failed (file: ${fileMsg}; ipc: ${directMsg})`)
      }
    }
  }

  try {
    await viaIpc()
    return
  } catch (directError: unknown) {
    try {
      await viaFile()
      streamFramePreferFileUntil.set(safeName, Date.now() + 5_000)
      return
    } catch (fileError: unknown) {
      const directMsg = directError instanceof Error ? directError.message : String(directError)
      const fileMsg = fileError instanceof Error ? fileError.message : String(fileError)
      throw new Error(`Frame stream failed (ipc: ${directMsg}; file: ${fileMsg})`)
    }
  }
}

export function publishRenderOutput(sourcePath: string, destination: string): Promise<void> {
  return invoke('publish_render_output', {
    args: { sourcePath, destination }
  })
}
