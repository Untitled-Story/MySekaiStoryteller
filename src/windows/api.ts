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

/** Push packed RGBA frame bytes into the native encode queue. */
export async function streamFrame(
  projectName: string,
  data: Uint8Array | number[]
): Promise<void> {
  const bytes: Uint8Array =
    data instanceof Uint8Array ? data : Uint8Array.from(data)

  // 1) Prefer raw binary IPC (Uint8Array → Vec<u8>). Do NOT Array.from() into number[]:
  //    that expands multi-MB frames into JSON and freezes Android WebView.
  try {
    await invoke('stream_frame', {
      projectName,
      data: bytes
    })
    return
  } catch (directError: unknown) {
    // 2) Fallback: write cache file then let Rust read it (works when binary IPC is blocked).
    const fileName: string = `render-frame-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.rgba`
    try {
      await writeFile(fileName, bytes, { baseDir: BaseDirectory.Cache })
      await invoke('stream_frame_file', {
        projectName,
        path: fileName
      })
      return
    } catch (fileError: unknown) {
      const directMsg =
        directError instanceof Error ? directError.message : String(directError)
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
