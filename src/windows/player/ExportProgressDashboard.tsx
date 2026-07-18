import type { JSX } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type { RenderConfig } from '@/settings/types'
import { formatElapsed, mapRenderStatusToUi } from '@/export/exportUi'
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
  const pct = Math.min(
    100,
    Math.max(0, (mapped.status === 'done' ? 1 : mapped.progress) * 100)
  )
  const title =
    mapped.status === 'done'
      ? '渲染完成'
      : mapped.status === 'error'
        ? '渲染失败'
        : mapped.status === 'paused'
          ? '已暂停'
          : mapped.status === 'merging'
            ? '正在合成'
            : '正在渲染'

  const remainingSec = estimateRemainingSec(wallSec, mapped.progress)
  const remainingLabel =
    mapped.status === 'done'
      ? '已完成'
      : mapped.status === 'error'
        ? '—'
        : mapped.status === 'paused'
          ? '已暂停'
          : remainingSec === null
            ? '计算中…'
            : remainingSec < 1
              ? '即将完成'
              : `预计剩余 ${formatElapsed(remainingSec)}`

  // Use design-system primary (white in dark theme) for the default fill.
  const barFillClass =
    mapped.status === 'error'
      ? 'bg-destructive'
      : mapped.status === 'done'
        ? 'bg-emerald-500'
        : 'bg-primary'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-base font-semibold tracking-tight">{title}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {projectTitle ?? '项目'}
              {role === 'worker' && stats.workerLabel ? ` · ${stats.workerLabel}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{mapped.message}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-3xl font-semibold tabular-nums tracking-tight">
              {pct.toFixed(1)}
              <span className="ml-0.5 text-sm font-medium text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <div
          className="h-3 w-full overflow-hidden rounded-full border border-border bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="渲染进度"
        >
          <div
            className={cn(
              'h-full min-w-0 rounded-full transition-[width] duration-300 ease-out',
              barFillClass
            )}
            style={{ width: `${Math.max(pct, pct > 0 ? 0.8 : 0)}%` }}
          />
        </div>

        <div className="text-xs text-muted-foreground">{remainingLabel}</div>

        <div className="mt-auto flex flex-wrap items-center gap-2">
          {stats.canPause ? (
            <Button type="button" variant="outline" size="sm" onClick={onTogglePause}>
              {stats.isPaused || stats.status === 'paused' ? '继续' : '暂停'}
            </Button>
          ) : null}
          {stats.canStop ? (
            <Button type="button" variant="destructive" size="sm" onClick={onStop}>
              停止
            </Button>
          ) : null}
          {mapped.status === 'done' && (exportPath || stats.exportPath) ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                const path = exportPath ?? stats.exportPath
                if (!path) return
                void revealItemInDir(path).catch((error: unknown) => {
                  console.warn('reveal export path failed', error)
                })
              }}
            >
              打开文件位置
            </Button>
          ) : null}
          {onOpenDetails ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="ml-auto h-auto px-0 text-xs text-muted-foreground"
              onClick={onOpenDetails}
            >
              详细信息
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
