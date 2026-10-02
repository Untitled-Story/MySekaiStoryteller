/** Friendly export progress for the main window (not technical Dashboard). */

export type ExportUiStatus = 'running' | 'paused' | 'merging' | 'done' | 'error'

export type ExportUiProgress = {
  sessionId: string
  /** Omitted when the project name is unavailable; consumers show an i18n fallback. */
  projectTitle?: string
  status: ExportUiStatus
  /** 0–1 overall progress for the bar. */
  progress: number
  /** i18n key of the status message; components render t(messageKey). */
  messageKey: string
  /** Optional runtime free text (worker detail / error description), shown verbatim. */
  messageText?: string
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
  /** Omitted when the project name is unavailable; consumers show an i18n fallback. */
  projectTitle?: string
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
  'status' | 'messageKey' | 'messageText' | 'progress' | 'elapsedSec' | 'canPause' | 'canStop'
> {
  const elapsedSec =
    typeof input.wallElapsedSec === 'number' && Number.isFinite(input.wallElapsedSec)
      ? Math.max(0, input.wallElapsedSec)
      : 0
  const progress = Math.min(1, Math.max(0, input.progress))
  const detailText = input.message?.trim() || undefined

  if (input.isPaused || input.status === 'paused') {
    return {
      status: 'paused',
      messageKey: 'render.statusPaused',
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
        messageKey: 'render.statusMerging',
        // Capture ends at 89%; merge occupies 90%–99%; done is 100%.
        progress: Math.min(0.99, Math.max(0.9, progress)),
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'done':
      return {
        status: 'done',
        messageKey: 'render.statusDone',
        messageText: detailText,
        // Always 100% for completed exports — ignore merge-band leftovers.
        progress: 1,
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'error':
      return {
        status: 'error',
        messageKey: 'render.statusError',
        messageText: detailText,
        progress,
        elapsedSec,
        canPause: false,
        canStop: false
      }
    case 'warming':
      return {
        status: 'running',
        messageKey: 'render.statusWarming',
        progress,
        elapsedSec,
        canPause: true,
        canStop: true
      }
    case 'finalizing':
      return {
        status: 'running',
        messageKey: 'render.statusFinalizing',
        progress,
        elapsedSec,
        canPause: false,
        canStop: true
      }
    case 'rendering':
    default:
      return {
        status: 'running',
        messageKey: 'render.statusRendering',
        progress,
        elapsedSec,
        canPause: true,
        canStop: true
      }
  }
}

/** Locale-neutral elapsed-time parts; the component picks its key via i18n. */
export function elapsedParts(seconds: number): { minutes: number; seconds: number } {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return {
    minutes: Math.floor(safe / 60),
    seconds: Math.floor(safe % 60)
  }
}

