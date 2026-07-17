import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Archive, LoaderCircle } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import {
  getPendingProjectImports,
  importProjectArchive,
  inspectProjectArchive,
  PROJECT_IMPORT_BROWSER_EVENT,
  PROJECTS_CHANGED_BROWSER_EVENT,
  type ProjectArchiveInspection,
  type ProjectImportConflict
} from '@/project/archive'
import { openEditorWindow } from '@/windows/api'

const TAURI_IMPORT_EVENT = 'project-import-requested'

export function ProjectImportCoordinator(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [queue, setQueue] = useState<string[]>([])
  const [inspection, setInspection] = useState<ProjectArchiveInspection | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [importing, setImporting] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const sourcePath: string | null = queue[0] ?? null

  const enqueue = useCallback((path: string): void => {
    if (!path.toLocaleLowerCase().endsWith('.sest')) return
    setQueue((current: string[]): string[] =>
      current.includes(path) ? current : [...current, path]
    )
  }, [])

  useEffect((): (() => void) => {
    let disposed = false
    let unlisten: UnlistenFn | undefined
    const browserListener = (event: Event): void => {
      const path = (event as CustomEvent<string>).detail
      if (typeof path === 'string') enqueue(path)
    }
    window.addEventListener(PROJECT_IMPORT_BROWSER_EVENT, browserListener)

    const drainPending = async (): Promise<void> => {
      const paths = await getPendingProjectImports()
      if (!disposed) paths.forEach(enqueue)
    }
    void (async (): Promise<void> => {
      try {
        const cleanup = await listen<string>(TAURI_IMPORT_EVENT, (event): void => {
          enqueue(event.payload)
          void drainPending().catch(console.error)
        })
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
        await drainPending()
      } catch (reason) {
        console.error(reason)
      }
    })()

    return (): void => {
      disposed = true
      unlisten?.()
      window.removeEventListener(PROJECT_IMPORT_BROWSER_EVENT, browserListener)
    }
  }, [enqueue])

  useEffect((): (() => void) | void => {
    if (!sourcePath) {
      setInspection(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void inspectProjectArchive(sourcePath)
      .then((value: ProjectArchiveInspection): void => {
        if (!cancelled) setInspection(value)
      })
      .catch((reason: unknown): void => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setInspection(null)
        }
      })
      .finally((): void => {
        if (!cancelled) setLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [sourcePath])

  const closeCurrent = (): void => {
    if (importing) return
    setQueue((current: string[]): string[] => current.slice(1))
  }

  const handleImport = async (conflict: ProjectImportConflict): Promise<void> => {
    if (!sourcePath || !inspection) return
    setImporting(true)
    setError(null)
    try {
      const result = await importProjectArchive(sourcePath, conflict)
      setQueue((current: string[]): string[] => current.slice(1))
      window.dispatchEvent(new Event(PROJECTS_CHANGED_BROWSER_EVENT))
      navigate('/projects')
      await openEditorWindow(result.projectName)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog
      open={Boolean(sourcePath)}
      onOpenChange={(open: boolean): void => {
        if (!open) closeCurrent()
      }}
    >
      <DialogContent className="select-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-5 text-primary" />
            {t('projectArchive.importTitle')}
          </DialogTitle>
          <DialogDescription>{t('projectArchive.importDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-24 rounded-md border border-border bg-muted/35 px-4 py-3">
          {loading ? (
            <div className="flex min-h-18 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t('projectArchive.inspecting')}
            </div>
          ) : inspection ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('projectArchive.projectName')}</span>
                <span className="truncate font-medium">{inspection.title}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('projectArchive.includedModels')}</span>
                <span>{inspection.modelCount}</span>
              </div>
              {inspection.projectExists && (
                <p className="border-t border-border pt-2 text-xs text-amber-600 dark:text-amber-400">
                  {t('projectArchive.conflictHint', { name: inspection.suggestedTitle })}
                </p>
              )}
            </div>
          ) : null}
          {error && <p className="text-sm text-destructive break-words">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeCurrent} disabled={importing}>
            {t('common.cancel')}
          </Button>
          {inspection?.projectExists && (
            <Button
              variant="destructive"
              onClick={(): void => void handleImport('replace')}
              disabled={loading || importing}
            >
              {t('projectArchive.replace')}
            </Button>
          )}
          <Button
            onClick={(): void => void handleImport('rename')}
            disabled={!inspection || loading || importing}
          >
            {importing ? t('projectArchive.importing') : t('projectArchive.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
