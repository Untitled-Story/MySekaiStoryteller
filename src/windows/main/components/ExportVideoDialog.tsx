import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { FolderSearch } from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import type { RenderConfig } from '@/settings/types'
import { useSettings } from '@/settings/useSettings'
import {
  DEFAULT_EXPORT_PREFS,
  normalizeExportPrefs
} from '@/settings/useSettingsState'
import { getDataPath } from '@/workspace/api'
import { openPlayerWindow } from '@/windows/api'
import { buildDefaultExportPath } from '@/windows/main/utils/exportPath'
import { describeError, logger } from '@/lib/logger'

export type ExportVideoDialogProps = {
  projectTitle: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ExportVideoDialog({
  projectTitle,
  open,
  onOpenChange
}: ExportVideoDialogProps): JSX.Element {
  const { exportPrefs, setExportPrefs } = useSettings()
  const [config, setConfig] = useState<RenderConfig | null>(null)
  const [isStarting, setIsStarting] = useState(false)

  useEffect(() => {
    if (!open || !projectTitle) {
      setConfig(null)
      return
    }

    let cancelled = false

    async function initConfig(): Promise<void> {
      try {
        const dataPath = await getDataPath()
        if (cancelled || !projectTitle) return
        const prefs = normalizeExportPrefs(exportPrefs)
        setConfig({
          exportPath: buildDefaultExportPath(dataPath, projectTitle),
          width: prefs.width,
          height: prefs.height,
          fps: prefs.fps,
          concurrency: prefs.concurrency
        })
      } catch (error: unknown) {
        logger.error('export.dialog_init_failed', {
          projectTitle,
          error: describeError(error)
        })
      }
    }

    void initConfig()
    return () => {
      cancelled = true
    }
  }, [open, projectTitle, exportPrefs])

  const handleBrowse = async (): Promise<void> => {
    const selected = await save({
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      title: '选择导出文件',
      defaultPath: config?.exportPath
    })
    if (selected && typeof selected === 'string') {
      setConfig((prev) => (prev ? { ...prev, exportPath: selected } : prev))
    }
  }

  const handleStart = async (): Promise<void> => {
    if (!projectTitle || !config?.exportPath) return
    setIsStarting(true)
    try {
      const width = Math.max(160, Math.floor(config.width) || DEFAULT_EXPORT_PREFS.width)
      const height = Math.max(90, Math.floor(config.height) || DEFAULT_EXPORT_PREFS.height)
      const fps = Math.max(1, Math.floor(config.fps) || DEFAULT_EXPORT_PREFS.fps)
      const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1) || 1)
      const dataPath = await getDataPath()
      // Persist last-used export options (not path).
      setExportPrefs({ width, height, fps, concurrency })
      onOpenChange(false)
      const exportGroupId = `exp_ui_${Date.now()}`
      const role = concurrency > 1 ? 'coordinator' : 'single'
      logger.info('export.start_requested', {
        projectTitle,
        exportPath: config.exportPath,
        width,
        height,
        fps,
        concurrency,
        role,
        exportGroupId,
        dataPath
      })
      await openPlayerWindow(projectTitle, true, {
        exportPath: config.exportPath,
        width,
        height,
        fps,
        concurrency,
        role,
        exportGroupId,
        sessionId: exportGroupId,
        dataPath
      })
      logger.info('export.start_window_opened', {
        projectTitle,
        exportGroupId,
        role
      })
    } catch (error: unknown) {
      logger.error('export.start_failed', {
        projectTitle,
        error: describeError(error)
      })
      alert('开始导出失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="select-none">
        <DialogHeader>
          <DialogTitle>导出视频</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">导出路径</label>
            <div className="flex gap-2">
              <Input
                value={config?.exportPath ?? ''}
                onChange={(e) =>
                  setConfig((prev) => (prev ? { ...prev, exportPath: e.target.value } : prev))
                }
                placeholder="选择导出路径..."
                className="flex-1"
              />
              <Button variant="outline" size="icon" onClick={() => void handleBrowse()} aria-label="浏览">
                <FolderSearch className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">宽度</label>
              <Input
                type="number"
                min={160}
                value={config?.width ?? 1920}
                onChange={(e) =>
                  setConfig((prev) =>
                    prev ? { ...prev, width: Number.parseInt(e.target.value, 10) || 0 } : prev
                  )
                }
              />
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">高度</label>
              <Input
                type="number"
                min={90}
                value={config?.height ?? 1080}
                onChange={(e) =>
                  setConfig((prev) =>
                    prev ? { ...prev, height: Number.parseInt(e.target.value, 10) || 0 } : prev
                  )
                }
              />
            </div>
          </div>
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">帧率 (FPS)</label>
            <Input
              type="number"
              min={1}
              max={120}
              value={config?.fps ?? 60}
              onChange={(e) =>
                setConfig((prev) =>
                  prev ? { ...prev, fps: Number.parseInt(e.target.value, 10) || 0 } : prev
                )
              }
            />
          </div>
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">并发数（工作线程）</label>
            <Input
              type="number"
              min={1}
              step={1}
              value={config?.concurrency ?? 2}
              onChange={(e) => {
                const raw = Number.parseInt(e.target.value, 10)
                setConfig((prev) =>
                  prev
                    ? {
                        ...prev,
                        concurrency: Number.isFinite(raw) ? Math.max(1, raw) : 1
                      }
                    : prev
                )
              }}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              同时渲染的任务数，任意正整数，推荐 2，过高会占更多内存/显存。
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isStarting}>
            取消
          </Button>
          <Button
            onClick={() => void handleStart()}
            disabled={isStarting || !config?.exportPath || !projectTitle}
          >
            {isStarting ? '启动中...' : '开始导出'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
