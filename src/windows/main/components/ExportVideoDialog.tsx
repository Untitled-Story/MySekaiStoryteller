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
import { DEFAULT_EXPORT_PREFS, normalizeExportPrefs } from '@/settings/useSettingsState'
import { getDataPath, getPublicMoviesDir } from '@/workspace/api'
import { openPlayerWindow } from '@/windows/api'
import {
  buildDefaultExportPath,
  buildMoviesExportPath,
  buildPrivateEncodePath
} from '@/windows/main/utils/exportPath'
import { describeError, logger } from '@/lib/logger'
import { isMobileRuntime } from '@/lib/platform'

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
  const mobileRuntime: boolean = isMobileRuntime()
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
        // Android/iOS: thermal/memory-safe defaults + single worker only.
        // Hardware MediaCodec path targets up to 720p30; dialog still forces concurrency=1.
        const width = mobileRuntime ? Math.min(prefs.width, 1280) : prefs.width
        const height = mobileRuntime ? Math.min(prefs.height, 720) : prefs.height
        const fps = mobileRuntime ? Math.min(prefs.fps, 30) : prefs.fps
        let exportPath = buildDefaultExportPath(dataPath, projectTitle)
        if (mobileRuntime) {
          try {
            const moviesDir = await getPublicMoviesDir()
            exportPath = buildMoviesExportPath(moviesDir, projectTitle)
          } catch (error: unknown) {
            logger.warn('export.movies_dir_failed', {
              error: describeError(error)
            })
            // Keep private path as last-resort display if Movies API fails.
            exportPath = buildPrivateEncodePath(dataPath, projectTitle)
          }
        }
        setConfig({
          exportPath,
          width,
          height,
          fps,
          concurrency: mobileRuntime ? 1 : prefs.concurrency
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
  }, [open, projectTitle, exportPrefs, mobileRuntime])

  const handleBrowse = async (): Promise<void> => {
    const selected = await save({
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      title: '选择渲染文件',
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
      let fps = Math.max(1, Math.floor(config.fps) || DEFAULT_EXPORT_PREFS.fps)
      let widthClamped = width
      let heightClamped = height
      if (mobileRuntime) {
        // Hard caps match mobile_encoder + pipeline clamps.
        fps = Math.min(fps, 30)
        widthClamped = Math.min(width, 1280)
        heightClamped = Math.min(height, 720)
        widthClamped -= widthClamped % 2
        heightClamped -= heightClamped % 2
      }
      const concurrency = mobileRuntime ? 1 : Math.max(1, Math.floor(config.concurrency ?? 1) || 1)
      const dataPath = await getDataPath()
      // Display path (Movies on mobile). Encode may use private path then publish.
      let displayPath: string = config.exportPath
      let encodePath: string = displayPath
      if (mobileRuntime) {
        try {
          const moviesDir = await getPublicMoviesDir()
          displayPath = buildMoviesExportPath(moviesDir, projectTitle)
        } catch {
          displayPath = buildPrivateEncodePath(dataPath, projectTitle)
        }
        // Encoder always writes private first (reliable). Publish to Movies on success.
        encodePath = buildPrivateEncodePath(dataPath, projectTitle)
      } else if (displayPath.startsWith('content://') || displayPath.startsWith('file://')) {
        encodePath = buildDefaultExportPath(dataPath, projectTitle)
        displayPath = encodePath
      }
      // Persist last-used export options (not path).
      setExportPrefs({ width: widthClamped, height: heightClamped, fps, concurrency })
      onOpenChange(false)
      const exportGroupId = `exp_ui_${Date.now()}`
      const role = concurrency > 1 ? 'coordinator' : 'single'
      logger.info('export.start_requested', {
        projectTitle,
        exportPath: displayPath,
        encodePath,
        width: widthClamped,
        height: heightClamped,
        fps,
        concurrency,
        role,
        exportGroupId,
        dataPath
      })
      await openPlayerWindow(projectTitle, true, {
        exportPath: encodePath,
        // Final public location for mobile share/publish after encode.
        publishPath: mobileRuntime ? displayPath : undefined,
        width: widthClamped,
        height: heightClamped,
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
      alert('开始渲染失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="select-none">
        <DialogHeader>
          <DialogTitle>渲染视频</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">输出路径</label>
            <div className="flex gap-2">
              <Input
                value={config?.exportPath ?? ''}
                onChange={(e) =>
                  setConfig((prev) => (prev ? { ...prev, exportPath: e.target.value } : prev))
                }
                placeholder="选择输出路径..."
                className="flex-1"
                readOnly={mobileRuntime}
              />
              {!mobileRuntime ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleBrowse()}
                  aria-label="浏览"
                >
                  <FolderSearch className="w-4 h-4" />
                </Button>
              ) : null}
            </div>
            {mobileRuntime ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                移动端写入应用私有目录，完成后可分享到系统相册/文件。
              </p>
            ) : null}
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
          {!mobileRuntime ? (
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">
                并发数（工作线程）
              </label>
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
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              移动端使用应用内单路渲染（并发固定为 1）。
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isStarting}>
            取消
          </Button>
          <Button
            onClick={() => void handleStart()}
            disabled={isStarting || !config?.exportPath || !projectTitle}
          >
            {isStarting ? '启动中...' : '开始渲染'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
