import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Eye,
  FileEdit,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/ContextMenu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Toast, type ToastVariant } from '@/components/ui/Toast'
import { useViewportMode, type ViewportMode } from '@/hooks/useViewportMode'
import { errorMessage } from '@/lib/errorMessage'
import { describeError, logger } from '@/lib/logger'
import { isMobileRuntime } from '@/lib/platform'
import { cn } from '@/lib/style'
import {
  deleteGlobalModel,
  getModelReferences,
  getModelRegistry,
  renameGlobalModel
} from '@/modelRegistry/api'
import { isStaticModelEntry } from '@/modelRegistry/isStaticModelEntry'
import { MAX_MODEL_NAME_CHARS } from '@/modelRegistry/limits'
import type { ModelRegistry, ModelRegistryEntry } from '@/modelRegistry/schema'
import { ModelImportDialog } from '@/windows/main/components/ModelImportDialog'
import { useSpinOnce } from '@/windows/main/hooks/useSpinOnce'

// Pixi and the Live2D engine are only needed once a model is previewed.
const ModelPreviewDialog = lazy(() => import('@/windows/main/components/ModelPreviewDialog'))

/** How long a deleted row takes to collapse before it leaves the list. */
const ROW_LEAVE_MS: number = 200

type ModelRow = {
  id: string
  name: string
  staticPortrait: boolean
}

type Notice = {
  id: number
  message: string
  variant: ToastVariant
}

type RenameTarget = {
  id: string
  name: string
}

type DeleteTarget = {
  id: string
  name: string
  /** Projects still registering the model; `null` while they are being looked up. */
  references: string[] | null
}

type PreviewState = {
  id: string
  open: boolean
}

export default function ModelsPage(): JSX.Element {
  const { t } = useTranslation()
  const { spinning, spin } = useSpinOnce()
  const viewportMode: ViewportMode = useViewportMode()
  const phoneLayout: boolean = viewportMode === 'phone'
  const mobileRuntime: boolean = isMobileRuntime()

  const [registry, setRegistry] = useState<ModelRegistry | null>(null)
  const [loadFailed, setLoadFailed] = useState<boolean>(false)
  // Rows present when the list first appears do not animate in; rows added later do.
  const [listSettled, setListSettled] = useState<boolean>(false)
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set())
  const [importOpen, setImportOpen] = useState<boolean>(false)
  // The targets outlive their dialogs so the content stays put while the dialog fades out.
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameOpen, setRenameOpen] = useState<boolean>(false)
  const [isRenaming, setIsRenaming] = useState<boolean>(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false)
  const [isDeleting, setIsDeleting] = useState<boolean>(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)

  function showNotice(message: string, variant: ToastVariant): void {
    setNotice({ id: Date.now(), message, variant })
  }

  async function loadRegistry(): Promise<void> {
    try {
      setRegistry(await getModelRegistry())
      setLoadFailed(false)
    } catch (error: unknown) {
      logger.error('models.load_failed', { error: describeError(error) })
      setLoadFailed(true)
      showNotice(t('models.loadFailed'), 'error')
    }
  }

  useEffect((): void => {
    void loadRegistry()
    // Load once when the page opens; later changes come from the mutation results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect((): void => {
    if (registry !== null) setListSettled(true)
  }, [registry])

  const rows: ModelRow[] = Object.entries(registry?.models ?? {})
    .map(
      ([id, entry]): ModelRow => ({
        id,
        name: entry.name ?? id,
        staticPortrait: isStaticModelEntry(entry.entry)
      })
    )
    .sort((left: ModelRow, right: ModelRow): number => left.name.localeCompare(right.name))

  function openPreview(id: string): void {
    setPreview({ id, open: true })
  }

  function openRename(row: ModelRow): void {
    setRenameTarget({ id: row.id, name: row.name })
    setRenameOpen(true)
  }

  async function confirmRename(): Promise<void> {
    if (!renameTarget || isRenaming) return
    const name: string = renameTarget.name.trim()
    if (!name) return

    setIsRenaming(true)
    try {
      setRegistry(await renameGlobalModel(renameTarget.id, name))
      setRenameOpen(false)
    } catch (error: unknown) {
      showNotice(
        t('models.renameFailed', { error: errorMessage(error, t('common.unknownError')) }),
        'error'
      )
    } finally {
      setIsRenaming(false)
    }
  }

  function requestDelete(row: ModelRow): void {
    setDeleteTarget({ id: row.id, name: row.name, references: null })
    setDeleteOpen(true)
    getModelReferences(row.id).then(
      (references: string[]): void =>
        setDeleteTarget((current: DeleteTarget | null): DeleteTarget | null =>
          current?.id === row.id ? { ...current, references } : current
        ),
      (error: unknown): void => {
        setDeleteOpen(false)
        showNotice(
          t('models.deleteFailed', { error: errorMessage(error, t('common.unknownError')) }),
          'error'
        )
      }
    )
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || isDeleting) return

    const { id }: DeleteTarget = deleteTarget
    setIsDeleting(true)
    try {
      const next: ModelRegistry = await deleteGlobalModel(id)
      setDeleteOpen(false)
      // Collapse the row first so the rows below it slide up instead of jumping.
      setLeavingIds((current: ReadonlySet<string>): ReadonlySet<string> => new Set(current).add(id))
      await new Promise<void>((resolve: () => void): void => {
        window.setTimeout(resolve, ROW_LEAVE_MS)
      })
      setRegistry(next)
      setLeavingIds((current: ReadonlySet<string>): ReadonlySet<string> => {
        const remaining: Set<string> = new Set(current)
        remaining.delete(id)
        return remaining
      })
    } catch (error: unknown) {
      showNotice(
        t('models.deleteFailed', { error: errorMessage(error, t('common.unknownError')) }),
        'error'
      )
      setDeleteOpen(false)
    } finally {
      setIsDeleting(false)
    }
  }

  const deleteInUse: boolean = (deleteTarget?.references?.length ?? 0) > 0
  const previewEntry: ModelRegistryEntry | undefined = preview
    ? registry?.models[preview.id]
    : undefined

  return (
    <div className="flex h-full select-none flex-col">
      <div className={cn('shrink-0 px-8 pt-8 pb-6', phoneLayout && 'px-4 pt-5 pb-4')}>
        <div
          className={cn(
            'flex items-center justify-between gap-3',
            phoneLayout && 'flex-col items-stretch gap-4'
          )}
        >
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold">{t('models.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {rows.length > 0
                ? t('models.count', { count: rows.length })
                : t('models.description')}
            </p>
          </div>
          <div
            className={cn('flex items-center gap-2', phoneLayout && 'grid grid-cols-[auto_1fr]')}
          >
            <Button
              variant="outline"
              size={phoneLayout ? 'icon' : 'sm'}
              className={phoneLayout ? 'size-11' : undefined}
              aria-label={t('models.refresh')}
              onClick={(): void => void spin(loadRegistry)}
            >
              <RefreshCw className={cn('size-4', spinning && 'spin-once')} />
            </Button>
            <Button
              size="sm"
              className={phoneLayout ? 'h-11' : undefined}
              onClick={(): void => setImportOpen(true)}
            >
              <Upload className="mr-1 size-4" />
              {t('models.import')}
            </Button>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'flex-1 overflow-auto overscroll-none px-8 pb-6 scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent',
          mobileRuntime && 'mobile-page-scrollbar',
          phoneLayout && 'px-4 pb-5'
        )}
      >
        {registry === null ? (
          loadFailed ? (
            <div className="flex h-full flex-col items-center justify-center pb-16 text-center">
              <Box className="mb-4 size-12 text-muted-foreground/60" />
              <p className="mb-4 text-sm text-muted-foreground">{t('models.loadFailed')}</p>
              <Button size="sm" variant="outline" onClick={(): void => void loadRegistry()}>
                <RefreshCw className="mr-1 size-4" />
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            <ModelListSkeleton />
          )
        ) : rows.length > 0 ? (
          <div className="animate-in divide-y divide-border duration-150 fade-in-0 motion-reduce:animate-none">
            {rows.map(
              (row: ModelRow): JSX.Element => (
                <ContextMenu key={row.id}>
                  <ContextMenuTrigger className={phoneLayout ? 'block' : undefined}>
                    <div
                      className={cn(
                        'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                        !phoneLayout && '-mx-2',
                        listSettled && 'starting:grid-rows-[0fr] starting:opacity-0',
                        leavingIds.has(row.id)
                          ? 'grid-rows-[0fr] opacity-0'
                          : 'grid-rows-[1fr] opacity-100'
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className={phoneLayout ? 'pb-3' : undefined}>
                          <div
                            className={cn(
                              'group relative flex cursor-pointer items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-accent/50',
                              phoneLayout &&
                                'min-h-16 rounded-xl border bg-card px-3 py-2 shadow-xs active:bg-accent/70'
                            )}
                          >
                            {/* The preview button stretches over the whole row; the actions sit above it. */}
                            <button
                              type="button"
                              aria-label={t('models.previewAria', { name: row.name })}
                              onClick={(): void => openPreview(row.id)}
                              className="flex min-w-0 flex-1 items-center gap-3 rounded-[inherit] text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                            >
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                {row.staticPortrait ? (
                                  <ImageIcon className="size-5" />
                                ) : (
                                  <Box className="size-5" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {row.name}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                  {row.staticPortrait
                                    ? t('models.kindStatic')
                                    : t('models.kindLive2d')}{' '}
                                  · <span className="font-mono">{row.id}</span>
                                </span>
                              </span>
                            </button>
                            <div
                              className={cn(
                                'relative z-10 flex items-center gap-1 transition-opacity motion-reduce:transition-none',
                                mobileRuntime
                                  ? 'opacity-100'
                                  : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
                              )}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className={phoneLayout ? 'size-10' : 'size-9'}
                                aria-label={t('common.rename')}
                                title={t('common.rename')}
                                onClick={(): void => openRename(row)}
                              >
                                <FileEdit className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={phoneLayout ? 'size-10' : 'size-9'}
                                aria-label={t('common.delete')}
                                title={t('common.delete')}
                                onClick={(): void => requestDelete(row)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="select-none font-medium">
                    <ContextMenuItem onClick={(): void => openPreview(row.id)}>
                      <Eye className="mr-2 size-4" />
                      {t('models.preview')}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={(): void => openRename(row)}>
                      <FileEdit className="mr-2 size-4" />
                      {t('common.rename')}
                    </ContextMenuItem>
                    <ContextMenuItem variant="destructive" onClick={(): void => requestDelete(row)}>
                      <Trash2 className="mr-2 size-4" />
                      {t('common.delete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            )}
          </div>
        ) : (
          <div className="flex h-full animate-in flex-col items-center justify-center pb-16 text-center duration-150 fade-in-0 motion-reduce:animate-none">
            <Box className="mb-4 size-12 text-muted-foreground/60" />
            <p className="mb-4 text-sm text-muted-foreground">{t('models.empty')}</p>
            <Button size="sm" onClick={(): void => setImportOpen(true)}>
              <Plus className="mr-1 size-4" />
              {t('models.import')}
            </Button>
          </div>
        )}
      </div>

      {preview && previewEntry ? (
        <Suspense fallback={null}>
          <ModelPreviewDialog
            open={preview.open}
            modelId={preview.id}
            name={previewEntry.name ?? preview.id}
            entry={previewEntry}
            description={`${
              isStaticModelEntry(previewEntry.entry)
                ? t('models.kindStatic')
                : t('models.kindLive2d')
            } · ${preview.id}`}
            onClose={(): void =>
              setPreview((current: PreviewState | null): PreviewState | null =>
                current ? { ...current, open: false } : current
              )
            }
          />
        </Suspense>
      ) : null}

      <ModelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(result): void => {
          setRegistry(result.registry)
          showNotice(t('models.imported'), 'success')
        }}
      />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="select-none">
          <DialogHeader>
            <DialogTitle>{t('models.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameTarget?.name ?? ''}
            placeholder={t('models.renamePlaceholder')}
            maxLength={MAX_MODEL_NAME_CHARS}
            disabled={isRenaming}
            onChange={(event): void => {
              const name: string = event.currentTarget.value
              setRenameTarget((current: RenameTarget | null): RenameTarget | null =>
                current ? { ...current, name } : current
              )
            }}
            onKeyDown={(event): void => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void confirmRename()
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isRenaming}
              onClick={(): void => setRenameOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={isRenaming || !renameTarget?.name.trim()}
              onClick={(): void => void confirmRename()}
            >
              {isRenaming ? t('common.renaming') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open: boolean): void => {
          if (!open && !isDeleting) setDeleteOpen(false)
        }}
      >
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.references === null
                ? t('models.deleteChecking')
                : deleteInUse
                  ? t('models.deleteInUse', {
                      name: deleteTarget?.name,
                      projects: deleteTarget?.references?.join(', ')
                    })
                  : t('models.deleteDescription', { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting || deleteTarget?.references == null || deleteInUse}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event): void => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {isDeleting ? t('common.deleting') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {notice && (
        <Toast
          key={notice.id}
          message={notice.message}
          variant={notice.variant}
          closeLabel={t('common.close')}
          onDismiss={(): void => setNotice(null)}
        />
      )}
    </div>
  )
}

function ModelListSkeleton(): JSX.Element {
  return (
    <div className="divide-y divide-border" aria-busy="true">
      {[0, 1, 2, 3].map(
        (index: number): JSX.Element => (
          <div key={index} className="-mx-2 flex h-[65px] items-center gap-3 px-2">
            <div className="size-10 rounded-lg bg-muted" />
            <div className="space-y-2">
              <div className="h-3.5 w-36 rounded-sm bg-muted" />
              <div className="h-2.5 w-24 rounded-sm bg-muted/70" />
            </div>
          </div>
        )
      )}
    </div>
  )
}
