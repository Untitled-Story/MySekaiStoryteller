import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { FolderSearch } from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { useTranslation } from 'react-i18next'
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
  DEFAULT_EXPORT_PREFS_MOBILE,
  normalizeExportPrefs
} from '@/settings/useSettingsState'
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
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()
  const { exportPrefs, setExportPrefs } = useSettings()
  const [config, setConfig] = useState<RenderConfig | null>(null)
  const [isStarting, setIsStarting] = useState(false)

  // Depend on the *normalized numeric* prefs rather than the raw settings object so
  // unrelated settings churn (language/theme identity changes) does not wipe the
  // user's in-flight edits when the dialog stays open.
  const prefs = normalizeExportPrefs(exportPrefs)

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
        // Mobile: concurrency forced to 1. Prefer 720p when prefs still look like desktop 1080p defaults
        // (legacy installs) so export is usable; user can still raise resolution in the dialog.
        let width = prefs.width
        let height = prefs.height
        const fps = prefs.fps
        if (mobileRuntime && width >= 1920 && height >= 1080) {
          width = DEFAULT_EXPORT_PREFS_MOBILE.width
          height = DEFAULT_EXPORT_PREFS_MOBILE.height
        }
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
  }, [open, projectTitle, mobileRuntime, prefs.width, prefs.height, prefs.fps, prefs.concurrency])

  const handleBrowse = async (): Promise<void> => {
    const selected = await save({
      filters: [{ name: t('render.mp4Filter'), extensions: ['mp4'] }],
      title: t('render.chooseFileTitle'),
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
      // Single source of truth for clamping: caps + even dimensions are owned by
      // normalizeExportPrefs (mirrors Rust clamp_export_config: 4096x2160, fps 120).
      const clamped = normalizeExportPrefs({
        width: config.width,
        height: config.height,
        fps: config.fps,
        concurrency: config.concurrency ?? 1
      })
      const widthClamped = clamped.width
      const heightClamped = clamped.height
      const fps = clamped.fps
      const concurrency = mobileRuntime ? 1 : clamped.concurrency
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
      // Open the player window BEFORE closing the dialog so a failure is visible
      // inside the dialog (which stays open) instead of leaving the user stranded.
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
      onOpenChange(false)
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
      const detail: string =
        error instanceof Error ? error.message : t('render.unknownError')
      window.alert(t('render.startFailed', { error: detail }))
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="select-none">
        <DialogHeader>
          <DialogTitle>{t('render.title')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('render.outputPath')}
            </label>
            <div className="flex gap-2">
              <Input
                value={config?.exportPath ?? ''}
                onChange={(e) =>
                  setConfig((prev) => (prev ? { ...prev, exportPath: e.target.value } : prev))
                }
                placeholder={t('render.pathPlaceholder')}
                className="flex-1"
                readOnly={mobileRuntime}
              />
              {!mobileRuntime ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleBrowse()}
                  aria-label={t('render.browse')}
                >
                  <FolderSearch className="w-4 h-4" />
                </Button>
              ) : null}
            </div>
            {mobileRuntime ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('render.mobilePathNote')}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('render.width')}
              </label>
              <Input
                type="number"
                min={160}
                max={4096}
                value={config?.width ?? 1920}
                onChange={(e) =>
                  setConfig((prev) =>
                    prev ? { ...prev, width: Number.parseInt(e.target.value, 10) || 0 } : prev
                  )
                }
              />
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('render.height')}
              </label>
              <Input
                type="number"
                min={90}
                max={2160}
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
            <label className="text-xs font-medium text-muted-foreground">
              {t('render.fps')}
            </label>
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
                {t('render.concurrency')}
              </label>
              <Input
                type="number"
                min={1}
                max={4}
                step={1}
                value={config?.concurrency ?? 2}
                onChange={(e) => {
                  const raw = Number.parseInt(e.target.value, 10)
                  setConfig((prev) =>
                    prev
                      ? {
                          ...prev,
                          concurrency: Number.isFinite(raw) ? Math.min(4, Math.max(1, raw)) : 1
                        }
                      : prev
                  )
                }}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('render.concurrencyHint')}
              </p>
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('render.mobileConcurrencyNote')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isStarting}>
            {t('render.cancel')}
          </Button>
          <Button
            onClick={() => void handleStart()}
            disabled={isStarting || !config?.exportPath || !projectTitle}
          >
            {isStarting ? t('render.starting') : t('render.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
