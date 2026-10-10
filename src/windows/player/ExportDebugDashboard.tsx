import type { JSX } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ExportDebugStats } from '@/export/exportUi'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card'
import { cn } from '@/lib/style'

type TimingSpan = NonNullable<ExportDebugStats['timingSpans']>[number]
type ChunkSegment = NonNullable<ExportDebugStats['chunkSegments']>[number]
type WorkerCardData = NonNullable<ExportDebugStats['workerCards']>[number]

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const cs = Math.floor((safe % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${cs
    .toString()
    .padStart(2, '0')}`
}

function formatWorkerStatusText(t: TFunction, status: string, message?: string): string {
  switch (status) {
    case 'idle':
      return t('render.debugBadgeIdle')
    case 'warming':
      return t('render.debugBadgeWarming')
    case 'rendering':
      return t('render.debugBadgeRendering')
    case 'finalizing':
      return t('render.debugBadgeFinalizing')
    case 'concatenating':
      return t('render.debugBadgeConcatenating')
    case 'paused':
      return t('render.debugBadgePaused')
    case 'done':
      return t('render.debugBadgeDone')
    case 'error':
      return message ? t('render.debugBadgeErrorDetail', { message }) : t('render.debugBadgeError')
    default:
      return status
  }
}

function statusBadgeClass(status: string, isPaused?: boolean): string {
  if (isPaused || status === 'paused') {
    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
  }
  if (status === 'done') {
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  }
  if (status === 'error') {
    return 'bg-destructive/15 text-destructive'
  }
  if (status === 'warming') {
    return 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
  }
  if (status === 'concatenating' || status === 'finalizing') {
    return 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
  }
  return 'bg-muted text-muted-foreground'
}

function chunkStateClass(state: string): string {
  switch (state) {
    case 'done':
      return 'bg-emerald-500'
    case 'running':
      return 'bg-primary'
    case 'warming':
      return 'bg-sky-500'
    case 'queued':
      return 'bg-amber-500/60'
    case 'error':
      return 'bg-destructive'
    case 'pending':
    default:
      return 'bg-muted-foreground/20'
  }
}

function StatusBadge({
  status,
  isPaused,
  message
}: {
  status: string
  isPaused?: boolean
  message?: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        statusBadgeClass(status, isPaused)
      )}
    >
      {isPaused ? t('render.debugBadgePaused') : formatWorkerStatusText(t, status, message)}
    </span>
  )
}

function ChunkProgressBar({
  segments,
  totalFrames,
  fallbackProgress
}: {
  segments?: ChunkSegment[]
  totalFrames: number
  fallbackProgress: number
}): JSX.Element {
  const total = Math.max(1, totalFrames)
  if (!segments || segments.length === 0) {
    const pct = Math.min(100, Math.max(0, fallbackProgress * 100))
    return (
      <div className="h-2.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted p-0.5">
      {segments.map((seg) => {
        const span = Math.max(1, seg.endFrame - seg.startFrame)
        const flex = span / total
        const fillPct = Math.min(100, Math.max(0, seg.progress * 100))
        const isHollow = seg.state === 'queued' || seg.state === 'pending'
        return (
          <div
            key={seg.id}
            className="relative min-w-[3px] overflow-hidden rounded-sm bg-background/60"
            style={{ flexGrow: flex, flexBasis: 0 }}
            title={`${seg.label ?? seg.id} [${seg.startFrame},${seg.endFrame}) ${Math.round(fillPct)}%`}
          >
            <div
              className={cn(
                'absolute inset-y-0 left-0 transition-[width] duration-200',
                chunkStateClass(seg.state),
                isHollow && fillPct <= 0 ? 'opacity-40' : '',
                seg.state === 'running' || seg.state === 'warming' ? 'animate-pulse' : ''
              )}
              style={{
                width:
                  isHollow && fillPct <= 0
                    ? '100%'
                    : `${Math.max(fillPct, seg.state === 'done' ? 100 : fillPct)}%`
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

function timingPhaseClass(phase: TimingSpan['phase'], state: TimingSpan['state']): string {
  if (state === 'error') return 'bg-destructive/80'
  switch (phase) {
    case 'warm':
      return 'bg-chart-2'
    case 'capture':
      return 'bg-chart-1'
    case 'finalize':
      return 'bg-chart-4'
    case 'merge':
      return 'bg-chart-5'
    default:
      return 'bg-muted-foreground/50'
  }
}

function TimingWaterfall({
  spans,
  wallSec
}: {
  spans: TimingSpan[]
  wallSec: number
}): JSX.Element {
  const { t } = useTranslation()
  const horizon = Math.max(
    0.001,
    wallSec,
    ...spans.map((s) => s.endSec),
    ...spans.map((s) => s.startSec)
  )
  const lanes = [...new Set(spans.map((s) => s.lane))]
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('render.debugWallClock', { end: formatTime(horizon) })}
        </p>
      </div>
      <div className="space-y-1.5 rounded-lg border bg-muted/20 px-3 py-2.5">
        {lanes.map((lane) => {
          const laneSpans = spans.filter((s) => s.lane === lane)
          return (
            <div key={lane} className="grid grid-cols-[3.25rem_1fr] items-center gap-2">
              <div className="truncate text-xs font-medium text-muted-foreground">{lane}</div>
              <div className="relative h-5 overflow-hidden rounded-md bg-muted">
                {laneSpans.map((span) => {
                  const left = Math.min(100, Math.max(0, (span.startSec / horizon) * 100))
                  const width = Math.min(
                    100 - left,
                    Math.max(0.4, ((span.endSec - span.startSec) / horizon) * 100)
                  )
                  const dur = Math.max(0, span.endSec - span.startSec)
                  const runningTag =
                    span.state === 'running'
                      ? ` · ${t('render.debugRunningTag')}`
                      : ''
                  return (
                    <div
                      key={span.id}
                      title={`${span.label} · ${formatTime(dur)}${runningTag}`}
                      className={cn(
                        'absolute inset-y-0.5 rounded-sm',
                        timingPhaseClass(span.phase, span.state),
                        span.state === 'running' ? 'animate-pulse' : ''
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-2.5 rounded-sm bg-chart-2" />
            {t('render.debugPhaseWarm')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-2.5 rounded-sm bg-chart-1" />
            {t('render.debugPhaseCapture')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-2.5 rounded-sm bg-chart-4" />
            {t('render.debugPhaseFinalize')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-2.5 rounded-sm bg-chart-5" />
            {t('render.debugPhaseMerge')}
          </span>
        </div>
        <div className="grid max-h-28 gap-0.5 overflow-y-auto text-[11px] text-muted-foreground sm:grid-cols-2">
          {spans.map((span) => (
            <div key={`${span.id}-leg`} className="truncate tabular-nums">
              {span.label}: {formatTime(Math.max(0, span.endSec - span.startSec))}
              {span.state === 'running' ? '…' : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function WorkerGrid({ workers }: { workers: WorkerCardData[] }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {workers.map((worker) => {
        const capturePct = Math.min(100, Math.max(0, worker.progress * 100))
        const warmPct = Math.min(100, Math.max(0, worker.warmProgress * 100))
        const isWarming = worker.status === 'warming'
        return (
          <div key={worker.index} className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">W{worker.index}</span>
                <StatusBadge status={worker.status} message={worker.message} />
              </div>
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {worker.fps.toFixed(1)} fps · {worker.speed.toFixed(2)}x
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('render.debugWorkerCapture')}</span>
                <span className="tabular-nums">
                  {worker.frameCount}/{worker.totalFrames} · {capturePct.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{ width: `${capturePct}%` }}
                />
              </div>

              {worker.warmTotalFrames > 0 ? (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{isWarming ? t('render.debugWorkerWarm') : t('render.debugWorkerWarmDone')}</span>
                    <span className="tabular-nums">
                      {worker.warmFrameCount}/{worker.warmTotalFrames} · {warmPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-sky-500/80 transition-[width] duration-200"
                      style={{ width: `${warmPct}%` }}
                    />
                  </div>
                </>
              ) : null}
              {worker.message ? (
                <div className="truncate text-[11px] text-muted-foreground">{worker.message}</div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ExportDebugDashboard({
  projectTitle,
  sessionId,
  exportPath,
  stats
}: {
  projectTitle?: string
  sessionId?: string
  exportPath?: string
  stats: ExportDebugStats | null
}): JSX.Element {
  const { t } = useTranslation()
  if (!stats) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background px-6 text-sm text-muted-foreground select-none">
        {t('render.debugWaiting')}
      </div>
    )
  }

  const isFinished = stats.status === 'done' || stats.status === 'error'
  const progressPct = Math.min(
    100,
    Math.max(0, (stats.status === 'done' ? 1 : stats.progress) * 100)
  )
  const wallSec =
    typeof stats.wallElapsedSec === 'number' && Number.isFinite(stats.wallElapsedSec)
      ? Math.max(0, stats.wallElapsedSec)
      : 0
  const overallFps = wallSec > 0 ? stats.frameCount / wallSec : 0
  const overallSpeed =
    wallSec > 0 ? (stats.currentTime > 0 ? stats.currentTime : stats.totalDuration) / wallSec : 0
  const efficiency =
    typeof stats.efficiency === 'number' && isFinished
      ? stats.efficiency
      : wallSec > 0
        ? (stats.currentTime > 0 ? stats.currentTime : stats.totalDuration) / wallSec
        : typeof stats.efficiency === 'number'
          ? stats.efficiency
          : 0
  const displayFps = isFinished ? overallFps : stats.fps
  const displaySpeed = isFinished ? overallSpeed : stats.speed
  const path = exportPath ?? stats.exportPath

  const metrics: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: t('render.debugMetricProgress'),
      value: `${progressPct.toFixed(1)}%`,
      hint: isFinished
        ? t('render.debugHintAll')
        : t('render.debugHintCaptured')
    },
    {
      label: t('render.debugMetricFrames'),
      value: `${stats.frameCount}/${stats.totalFrames || '—'}`,
      hint: t('render.debugHintCaptureOnly')
    },
    {
      label: t('render.debugMetricTimeline'),
      value: `${formatTime(stats.currentTime)} / ${formatTime(stats.totalDuration)}`
    },
    {
      label: isFinished ? t('render.debugMetricFpsAvg') : t('render.debugMetricFps'),
      value: displayFps.toFixed(1),
      hint: isFinished ? t('render.debugHintWall') : t('render.debugHintInstant')
    },
    {
      label: isFinished ? t('render.debugMetricSpeedAvg') : t('render.debugMetricSpeed'),
      value: `${displaySpeed.toFixed(2)}x`,
      hint: isFinished ? t('render.debugHintWall') : t('render.debugHintInstant')
    },
    {
      label: t('render.debugMetricTotal'),
      value: wallSec > 0 ? formatTime(wallSec) : '—'
    },
    {
      label: t('render.debugMetricEfficiency'),
      value: `${efficiency.toFixed(2)}x`,
      hint: t('render.debugHintWall')
    },
    {
      label: t('render.debugMetricWorkers'),
      value:
        typeof stats.totalWorkers === 'number'
          ? `${stats.doneWorkers ?? 0}/${stats.totalWorkers}`
          : stats.workerCards && stats.workerCards.length > 0
            ? String(stats.workerCards.length)
            : '1'
    }
  ]

  return (
    <div className="h-screen w-screen overflow-auto bg-background text-foreground select-none">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b bg-background px-5 py-4">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('render.debugHeader')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">
                {t('render.debugDashboard')}
              </h1>
              <StatusBadge
                status={stats.status}
                isPaused={stats.isPaused}
                message={stats.message}
              />
              {stats.workerLabel ? (
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {stats.workerLabel}
                </span>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {projectTitle ?? t('render.projectFallback')}
            </p>
            {sessionId ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground/80">{sessionId}</p>
            ) : null}
            {stats.message ? (
              <p className="max-w-[42rem] text-xs text-muted-foreground">{stats.message}</p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tracking-tight tabular-nums">
              {progressPct.toFixed(1)}
              <span className="ml-1 text-base font-medium text-muted-foreground">%</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('render.debugReadonly')}</p>
          </div>
        </header>

        <div className="space-y-4 px-5 py-4">
          <Card className="gap-0 py-0 shadow-sm">
            <CardHeader className="border-b px-4 py-3 [.border-b]:pb-3">
              <CardTitle className="text-sm">{t('render.debugCaptureTitle')}</CardTitle>
              <CardDescription>{t('render.debugCaptureDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-4 py-4">
              <ChunkProgressBar
                segments={stats.chunkSegments}
                totalFrames={stats.totalFrames}
                fallbackProgress={stats.progress}
              />
              {stats.chunkSegments && stats.chunkSegments.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-2.5 rounded-sm bg-emerald-500" />
                    {t('render.debugChunkDone')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-2.5 rounded-sm bg-primary" />
                    {t('render.debugChunkRunning')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-2.5 rounded-sm bg-sky-500" />
                    {t('render.debugChunkWarming')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-2.5 rounded-sm bg-amber-500/70" />
                    {t('render.debugChunkQueued')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-2.5 rounded-sm bg-muted-foreground/20" />
                    {t('render.debugChunkUnassigned')}
                  </span>
                  <span className="ml-auto tabular-nums">
                    {t('render.debugChunksCount', {
                      done: stats.chunkSegments.filter((s) => s.state === 'done').length,
                      total: stats.chunkSegments.length
                    })}
                  </span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map((metric) => (
              <Card key={metric.label} className="gap-0 py-0 shadow-sm">
                <CardContent className="px-3 py-3">
                  <p className="text-xs text-muted-foreground">{metric.label}</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums">{metric.value}</p>
                  {metric.hint ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.hint}</p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="gap-0 py-0 shadow-sm">
            <CardHeader className="border-b px-4 py-3 [.border-b]:pb-3">
              <CardTitle className="text-sm">{t('render.debugWaterfallTitle')}</CardTitle>
              <CardDescription>{t('render.debugWaterfallDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="px-4 py-4">
              {stats.timingSpans && stats.timingSpans.length > 0 ? (
                <TimingWaterfall spans={stats.timingSpans} wallSec={wallSec} />
              ) : (
                <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  {t('render.debugWaterfallEmpty')}
                </div>
              )}
            </CardContent>
          </Card>

          {stats.workerCards && stats.workerCards.length > 0 ? (
            <Card className="gap-0 py-0 shadow-sm">
              <CardHeader className="border-b px-4 py-3 [.border-b]:pb-3">
                <CardTitle className="text-sm">{t('render.debugWorkersTitle')}</CardTitle>
                <CardDescription>{t('render.debugWorkersDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="px-4 py-4">
                <WorkerGrid workers={stats.workerCards} />
              </CardContent>
            </Card>
          ) : null}

          {stats.detailLines && stats.detailLines.length > 0 ? (
            <Card className="gap-0 py-0 shadow-sm">
              <CardHeader className="border-b px-4 py-3 [.border-b]:pb-3">
                <CardTitle className="text-sm">{t('render.debugDetailsTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 px-4 py-3 text-xs text-muted-foreground sm:grid-cols-2">
                {stats.detailLines.map((line) => (
                  <div key={line} className="truncate">
                    {line}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {path ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{path}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
