/** Friendly export progress for the main window (not technical Dashboard). */

export type ExportUiStatus = 'running' | 'paused' | 'merging' | 'done' | 'error'

export type ExportUiProgress = {
  sessionId: string
  projectTitle: string
  status: ExportUiStatus
  /** 0–1 overall progress for the bar. */
  progress: number
  /** Short user-facing Chinese message. */
  message: string
  elapsedSec: number
  canPause: boolean
  canStop: boolean
  exportPath?: string
  error?: string
}

export const EXPORT_UI_PROGRESS_EVENT = 'export-ui-progress'
export const EXPORT_CONTROL_EVENT = 'export-control'
/** Full technical stats for the export debug dashboard window. */
export const EXPORT_DEBUG_STATS_EVENT = 'export-debug-stats'
/** Debug window asks the progress host to re-emit the latest snapshot. */
export const EXPORT_DEBUG_REQUEST_EVENT = 'export-debug-request'

export type ExportControlAction = 'pause' | 'resume' | 'stop' | 'truncate'

export type ExportControlPayload = {
  groupId: string
  action: ExportControlAction
  endFrame?: number
}

/** Technical stats mirror of player RenderStats (debug-only). */
export type ExportDebugStats = {
  progress: number
  frameCount: number
  totalFrames: number
  currentTime: number
  totalDuration: number
  fps: number
  speed: number
  status: string
  message?: string
  workerLabel?: string
  wallElapsedSec?: number
  canPause?: boolean
  canStop?: boolean
  isPaused?: boolean
  efficiency?: number
  doneWorkers?: number
  totalWorkers?: number
  exportPath?: string
  workerCards?: Array<{
    index: number
    status: string
    progress: number
    frameCount: number
    totalFrames: number
    warmProgress: number
    warmFrameCount: number
    warmTotalFrames: number
    fps: number
    speed: number
    message?: string
  }>
  timingSpans?: Array<{
    id: string
    label: string
    lane: string
    phase: 'warm' | 'capture' | 'finalize' | 'merge' | 'other'
    startSec: number
    endSec: number
    state: 'running' | 'done' | 'error'
  }>
  chunkSegments?: Array<{
    id: string
    jobId?: number
    startFrame: number
    endFrame: number
    progress: number
    state: string
    label?: string
  }>
  detailLines?: string[]
}

export type ExportDebugStatsEvent = {
  sessionId: string
  /** Original UI export group id when different from prepared sessionId. */
  exportGroupId?: string
  projectTitle: string
  exportPath?: string
  stats: ExportDebugStats
}

export type ExportDebugRequestEvent = {
  sessionId?: string
}

export function mapRenderStatusToUi(input: {
  status: string
  isPaused?: boolean
  message?: string
  progress: number
  wallElapsedSec?: number
  exportPath?: string
}): Pick<
  ExportUiProgress,
  'status' | 'message' | 'progress' | 'elapsedSec' | 'canPause' | 'canStop'
> {
  const elapsedSec =
    typeof input.wallElapsedSec === 'number' && Number.isFinite(input.wallElapsedSec)
      ? Math.max(0, input.wallElapsedSec)
      : 0
  const progress = Math.min(1, Math.max(0, input.progress))

  if (input.isPaused || input.status === 'paused') {
    return {
      status: 'paused',
      message: '已暂停',
      progress,
      elapsedSec,
      canPause: true,
      canStop: true
    }
  }

  switch (input.status) {
    case 'concatenating':
      return {
        status: 'merging',
        message: '正在合成视频…',
        // Capture ends at 89%; merge occupies 90%–99%; done is 100%.
        progress: Math.min(0.99, Math.max(0.9, progress)),
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'done':
      return {
        status: 'done',
        message: input.message?.trim() || '导出完成',
        // Always 100% for completed exports — ignore merge-band leftovers.
        progress: 1,
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'error':
      return {
        status: 'error',
        message: input.message?.trim() || '导出失败',
        progress,
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'warming':
      return {
        status: 'running',
        message: '正在准备画面…',
        progress,
        elapsedSec,
        canPause: true,
        canStop: true
      }
    case 'finalizing':
      return {
        status: 'running',
        message: '正在保存片段…',
        progress,
        elapsedSec,
        canPause: false,
        canStop: true
      }
    case 'rendering':
    default:
      return {
        status: 'running',
        message: '正在导出…',
        progress,
        elapsedSec,
        canPause: true,
        canStop: true
      }
  }
}

export function formatElapsed(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  if (mins <= 0) return `${secs} 秒`
  return `${mins} 分 ${secs.toString().padStart(2, '0')} 秒`
}
