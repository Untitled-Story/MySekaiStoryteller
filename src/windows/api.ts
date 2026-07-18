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

/** Push packed RGBA frame bytes into the native encode queue. */
export async function streamFrame(projectName: string, data: Uint8Array | number[]): Promise<void> {
  const bytes: Uint8Array = data instanceof Uint8Array ? data : Uint8Array.from(data)
  // Do NOT Array.from() multi-MB frames into number[] (JSON freezes Android WebView).

  const safeName = projectName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48)
  const slot: number = (streamFrameSlotBySession.get(safeName) ?? 0) ^ 1
  streamFrameSlotBySession.set(safeName, slot)
  const fileName: string = `render-frame-${safeName}-${slot}.rgba`
  // Prefer binary IPC (no multi-MB disk I/O). File bridge only as fallback.
  const preferFile = (streamFramePreferFileUntil.get(safeName) ?? 0) > Date.now()

  async function viaFile(): Promise<void> {
    await writeFile(fileName, bytes, { baseDir: BaseDirectory.Cache })
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

  if (!preferFile) {
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

  try {
    await viaFile()
    return
  } catch (fileError: unknown) {
    try {
      await viaIpc()
      streamFramePreferFileUntil.delete(safeName)
      return
    } catch (directError: unknown) {
      const fileMsg = fileError instanceof Error ? fileError.message : String(fileError)
      const directMsg = directError instanceof Error ? directError.message : String(directError)
      throw new Error(`Frame stream failed (file: ${fileMsg}; ipc: ${directMsg})`)
    }
  }
}

export function publishRenderOutput(sourcePath: string, destination: string): Promise<void> {
  return invoke('publish_render_output', {
    args: { sourcePath, destination }
  })
}
