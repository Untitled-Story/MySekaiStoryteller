import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/Button'
import {
  EXPORT_CONTROL_EVENT,
  EXPORT_UI_PROGRESS_EVENT,
  formatElapsed,
  type ExportUiProgress
} from '@/export/exportUi'

export function ExportProgressHost(): JSX.Element | null {
  const [progress, setProgress] = useState<ExportUiProgress | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<ExportUiProgress>(EXPORT_UI_PROGRESS_EVENT, (event) => {
      setProgress(event.payload)
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  if (!progress) return null
  if (
    progress.status === 'done' ||
    progress.status === 'error' ||
    progress.status === 'running' ||
    progress.status === 'paused' ||
    progress.status === 'merging'
  ) {
    // always show while we have a session payload
  }

  const pct = Math.min(100, Math.max(0, progress.progress * 100))
  const statusLabel =
    progress.status === 'paused'
      ? '已暂停'
      : progress.status === 'merging'
        ? '合成中'
        : progress.status === 'done'
          ? '已完成'
          : progress.status === 'error'
            ? '失败'
            : '导出中'

  const sendControl = (action: 'pause' | 'resume' | 'stop'): void => {
    void emit(EXPORT_CONTROL_EVENT, { groupId: progress.sessionId, action })
    if (action === 'stop') {
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              status: 'error',
              message: '已停止',
              canPause: false,
              canStop: false
            }
          : prev
      )
    }
  }

  const dismiss = (): void => {
    setProgress(null)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-border bg-background/95 shadow-xl shadow-black/20 backdrop-blur-md">
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="text-xs font-medium text-muted-foreground">导出视频</div>
              <div className="truncate text-sm font-semibold text-foreground">
                {progress.projectTitle}
              </div>
              <div className="text-xs text-muted-foreground">
                {statusLabel}
                {progress.message ? ` · ${progress.message}` : ''}
              </div>
            </div>
            <div className="shrink-0 text-right text-2xl font-semibold tabular-nums text-foreground">
              {pct.toFixed(0)}
              <span className="ml-0.5 text-sm font-medium text-muted-foreground">%</span>
            </div>
          </div>

          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                progress.status === 'error'
                  ? 'bg-destructive'
                  : progress.status === 'done'
                    ? 'bg-emerald-500'
                    : 'bg-primary'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>已用时 {formatElapsed(progress.elapsedSec)}</span>
            {progress.status === 'error' && progress.error ? (
              <span className="max-w-[14rem] truncate text-destructive">{progress.error}</span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {progress.canPause ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  sendControl(progress.status === 'paused' ? 'resume' : 'pause')
                }
              >
                {progress.status === 'paused' ? '继续' : '暂停'}
              </Button>
            ) : null}
            {progress.canStop ? (
              <Button type="button" variant="outline" size="sm" onClick={() => sendControl('stop')}>
                停止
              </Button>
            ) : null}
            {progress.status === 'done' && progress.exportPath ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void revealItemInDir(progress.exportPath!).catch(() => {
                    // ignore if reveal fails
                  })
                }}
              >
                打开位置
              </Button>
            ) : null}
            {progress.status === 'done' || progress.status === 'error' ? (
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                关闭
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
