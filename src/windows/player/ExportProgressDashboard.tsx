import type { JSX } from 'react'
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import { isMobileRuntime } from '@/lib/platform'
import type { RenderConfig } from '@/settings/types'
import { elapsedParts, mapRenderStatusToUi } from '@/export/exportUi'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/style'

export type ExportProgressStats = {
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
  detailLines?: string[]
}

/** Estimate remaining wall time from elapsed and progress (0–1). */
function estimateRemainingSec(elapsedSec: number, progress: number): number | null {
  if (!(elapsedSec > 0.5) || !(progress > 0.02) || progress >= 0.999) {
    if (progress >= 0.999) return 0
    return null
  }
  const remaining = elapsedSec * (1 / progress - 1)
  if (!Number.isFinite(remaining) || remaining < 0) return null
  return remaining
}

export function ExportProgressDashboard({
  role,
  stats,
  onTogglePause,
  onStop,
  onOpenDetails,
  projectTitle,
  exportPath
}: {
  role: RenderConfig['role'] | undefined
  stats: ExportProgressStats
  onTogglePause: () => void
  onStop: () => void
  onOpenDetails?: () => void
  projectTitle?: string
  exportPath?: string
}): JSX.Element {
  const { t } = useTranslation()
  const wallSec =
    typeof stats.wallElapsedSec === 'number' && Number.isFinite(stats.wallElapsedSec)
      ? Math.max(0, stats.wallElapsedSec)
      : 0
  const mapped = mapRenderStatusToUi({
    status: stats.status,
    isPaused: stats.isPaused,
    message: stats.message,
    progress: stats.progress,
    wallElapsedSec: wallSec
  })
  // Terminal done always shows 100% even if last merge event was 0.99.
  const pct = Math.min(100, Math.max(0, (mapped.status === 'done' ? 1 : mapped.progress) * 100))
  const statusTitleKey =
    mapped.status === 'done'
      ? 'render.titleDone'
      : mapped.status === 'error'
        ? 'render.titleError'
        : mapped.status === 'paused'
          ? 'render.titlePaused'
          : mapped.status === 'merging'
            ? 'render.titleMerging'
            : 'render.titleRunning'
  const title = t(statusTitleKey)
  const statusMessage = mapped.messageText ?? t(mapped.messageKey)

  const remainingSec = estimateRemainingSec(wallSec, mapped.progress)
  const remainingLabel =
    mapped.status === 'done'
      ? t('render.remainingDone')
      : mapped.status === 'error'
        ? '—'
        : mapped.status === 'paused'
          ? t('render.remainingPaused')
          : remainingSec === null
            ? t('render.remainingComputing')
            : remainingSec < 1
              ? t('render.remainingSoon')
              : (() => {
                  const parts = elapsedParts(remainingSec)
                  return parts.minutes > 0
                    ? t('render.remainingEta', { elapsed: t('render.elapsedLong', parts) })
                    : t('render.remainingEta', {
                        elapsed: t('render.elapsedShort', { seconds: parts.seconds })
                      })
                })()

  // Use design-system primary (white in dark theme) for the default fill.
  const barFillClass =
    mapped.status === 'error'
      ? 'bg-destructive'
      : mapped.status === 'done'
        ? 'bg-emerald-500'
        : 'bg-primary'

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-foreground select-none">
      <div className="flex w-full flex-1 flex-col gap-3 p-6 sm:p-8 sm:justify-center">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="truncate text-sm sm:text-base text-muted-foreground">
              {projectTitle ?? t('render.projectFallback')}
              {role === 'worker' && stats.workerLabel ? ` · ${stats.workerLabel}` : ''}
            </p>
            <p className="text-sm sm:text-base text-muted-foreground">{statusMessage}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-3xl sm:text-4xl font-semibold tabular-nums tracking-tight">
              {pct.toFixed(1)}
              <span className="ml-0.5 text-sm sm:text-base font-medium text-muted-foreground">
                %
              </span>
            </div>
            {stats.status !== 'done' && stats.status !== 'error' && stats.fps > 0 ? (
              <div className="mt-1 text-xs sm:text-sm text-muted-foreground">
                {t('render.fpsReadout', { fps: stats.fps.toFixed(2) })}
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="h-3 sm:h-4 w-full overflow-hidden rounded-full border border-border bg-muted my-4"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label={t('render.ariaProgress')}
        >
          <div
            className={cn(
              'h-full min-w-0 rounded-full transition-[width] duration-300 ease-out',
              barFillClass
            )}
            style={{ width: `${Math.max(pct, pct > 0 ? 0.8 : 0)}%` }}
          />
        </div>

        <div className="text-sm sm:text-base text-muted-foreground">{remainingLabel}</div>

        <div className="mt-auto sm:mt-6 pt-4 flex flex-wrap items-center gap-3">
          {stats.canPause ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 px-4 sm:h-10"
              onClick={onTogglePause}
            >
              {stats.isPaused || stats.status === 'paused'
                ? t('render.btnResume')
                : t('render.btnPause')}
            </Button>
          ) : null}
          {stats.canStop ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-9 px-4 sm:h-10"
              onClick={onStop}
            >
              {t('render.btnStop')}
            </Button>
          ) : null}
          {mapped.status === 'done' && (exportPath || stats.exportPath) ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-9 px-4 sm:h-10"
              onClick={() => {
                const path = exportPath ?? stats.exportPath
                if (!path) return
                if (isMobileRuntime()) {
                  type MssShareBridge = {
                    shareFile?: (filePath: string, mimeType: string) => string
                  }
                  const bridge = (window as unknown as { MssShare?: MssShareBridge }).MssShare
                  console.log('MssShare bridge object:', !!bridge, !!bridge?.shareFile, path)
                  try {
                    if (bridge?.shareFile) {
                      const result = bridge.shareFile(path, 'video/mp4')
                      console.log('MssShare bridge result:', result)
                      if (typeof result === 'string' && result.startsWith('error:')) {
                        throw new Error(result)
                      }
                      return
                    }
                  } catch (error: unknown) {
                    console.warn('MssShare bridge failed', error)
                  }
                  // Fallback: Rust command (may fail if ClassLoader/ACL is incomplete)
                  void invoke('share_file', { args: { path, mimeType: 'video/mp4' } }).catch(
                    (error: unknown) => {
                      console.warn('share_file failed', error)
                      void openPath(path).catch((openError: unknown) => {
                        console.warn('open export path failed', openError)
                        void revealItemInDir(path).catch(() => undefined)
                      })
                    }
                  )
                  return
                }
                void revealItemInDir(path).catch((error: unknown) => {
                  console.warn('reveal export path failed', error)
                })
              }}
            >
              {isMobileRuntime() ? t('render.btnOpenShare') : t('render.btnOpenLocation')}
            </Button>
          ) : null}
          {onOpenDetails ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="ml-auto h-auto px-0 text-xs sm:text-sm text-muted-foreground"
              onClick={onOpenDetails}
            >
              {t('render.btnDetails')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
