import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toast, type ToastVariant } from '@/components/ui/Toast'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  ArrowUpDown,
  Edit3,
  Play,
  FileEdit,
  Trash2,
  Clock,
  Download,
  Upload
} from 'lucide-react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useSettings } from '@/settings/useSettings'
import { useViewportMode, type ViewportMode } from '@/hooks/useViewportMode'
import { isMobileRuntime } from '@/lib/platform'

import { cn } from '@/lib/style'
import { CreateProjectDialog } from '@/windows/main/components/CreateProjectDialog'
import { useProjectsMetadata } from '@/windows/main/hooks/useProjectsMetadata'
import { useSpinOnce } from '@/windows/main/hooks/useSpinOnce'
import type { ProjectMetadata } from '@/project/metadata'
import { deleteProject, renameProject } from '@/project/api'
import { timeAgo } from '@/windows/main/utils/time'
import { openEditorWindow, openPlayerWindow } from '@/windows/api'
import { exportProjectArchive, requestProjectImport } from '@/project/archive'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/ContextMenu'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/Dialog'

type SortMode = 'recent' | 'name'

type ExportNotice = {
  id: number
  message: string
  variant: ToastVariant
}

export default function ProjectsPage(): JSX.Element {
  const { t } = useTranslation()
  const { projects, fetchProjects, loading } = useProjectsMetadata()
  const { spinning, spin } = useSpinOnce()
  const { interaction } = useSettings()
  const viewportMode: ViewportMode = useViewportMode()
  const phoneLayout: boolean = viewportMode === 'phone'
  const mobileRuntime: boolean = isMobileRuntime()
  const alwaysShowRowActions: boolean = phoneLayout || interaction.touchMode

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [exportingProject, setExportingProject] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)

  const filtered = useMemo(() => {
    let result: ProjectMetadata[] = [...projects]

    if (search.trim()) {
      const query = search.trim().toLowerCase()
      result = result.filter((p) => p.title.toLowerCase().includes(query))
    }

    if (sortMode === 'recent') {
      result.sort((a, b) => b.lastModified - a.lastModified)
    } else {
      result.sort((a, b) => a.title.localeCompare(b.title))
    }

    return result
  }, [projects, search, sortMode])

  const toggleSort = (): void =>
    setSortMode((prev: SortMode): SortMode => (prev === 'recent' ? 'name' : 'recent'))

  const handleOpenEditor = async (title: string): Promise<void> => {
    try {
      await openEditorWindow(title)
    } catch (error) {
      alert(
        t('project.openEditorFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    }
  }

  const handleOpenPlayer = async (title: string): Promise<void> => {
    try {
      await openPlayerWindow(title)
    } catch (error) {
      alert(
        t('project.openPlayerFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    }
  }

  const handleProjectCreated = (projectName: string): void => {
    spin(fetchProjects)
    void handleOpenEditor(projectName)
  }

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await deleteProject(deleteTarget)
      spin(fetchProjects)
    } catch (error) {
      alert(
        t('project.deleteFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }

  const handleRename = async (): Promise<void> => {
    if (!renameTarget || !newName.trim()) return
    if (newName.trim() === renameTarget) {
      setRenameTarget(null)
      return
    }
    setIsRenaming(true)
    try {
      await renameProject(renameTarget, newName.trim())
      spin(fetchProjects)
    } catch (error) {
      alert(
        t('project.renameFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setIsRenaming(false)
      setRenameTarget(null)
    }
  }

  const handleChooseImport = async (): Promise<void> => {
    const selected = await open({
      title: t('projectArchive.chooseImport'),
      multiple: false,
      directory: false,
      filters: [
        { name: t('projectArchive.fileType'), extensions: ['sest'] },
        // Android dialog filters are MIME-oriented; keep a broad fallback.
        { name: t('common.allFiles'), extensions: ['*/*'] }
      ]
    })
    const selectedPath: string | null = Array.isArray(selected)
      ? typeof selected[0] === 'string'
        ? selected[0]
        : null
      : typeof selected === 'string'
        ? selected
        : null
    if (selectedPath) requestProjectImport(selectedPath)
  }

  const handleExport = async (projectName: string): Promise<void> => {
    const destination = await save({
      title: t('projectArchive.chooseExport'),
      defaultPath: `${projectName}.sest`,
      filters: [{ name: t('projectArchive.fileType'), extensions: ['sest'] }]
    })
    if (!destination) return
    setExportingProject(projectName)
    try {
      await exportProjectArchive(projectName, destination)
      setExportNotice({
        id: Date.now(),
        message: t('projectArchive.exportComplete'),
        variant: 'success'
      })
    } catch (error) {
      setExportNotice({
        id: Date.now(),
        message: t('projectArchive.exportFailed', {
          error: error instanceof Error ? error.message : String(error)
        }),
        variant: 'error'
      })
    } finally {
      setExportingProject(null)
    }
  }

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
            <h2 className="font-semibold text-2xl">{t('projects.title')}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {projects.length > 0
                ? t('projects.count', { count: projects.length })
                : t('projects.description')}
            </p>
          </div>
          <div className={cn('flex items-center gap-2', phoneLayout && 'grid grid-cols-2')}>
            <Button
              variant="outline"
              size="sm"
              className={phoneLayout ? 'h-11' : undefined}
              onClick={(): void => void handleChooseImport()}
            >
              <Upload className="w-4 h-4 mr-1" />
              {t('projectArchive.import')}
            </Button>
            <Button
              size="sm"
              className={phoneLayout ? 'h-11' : undefined}
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('project.new')}
            </Button>
          </div>
        </div>
      </div>

      <div className={cn('flex-shrink-0 px-8 pb-2', phoneLayout && 'px-4 pb-3')}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t('projects.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn('pl-9', phoneLayout && 'h-11 rounded-xl')}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className={phoneLayout ? 'size-11 rounded-xl' : undefined}
            aria-label={sortMode === 'recent' ? t('projects.sortByName') : t('projects.sortByTime')}
            title={sortMode === 'recent' ? t('projects.currentTime') : t('projects.currentName')}
            onClick={toggleSort}
          >
            <ArrowUpDown className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className={phoneLayout ? 'size-11 rounded-xl' : undefined}
            aria-label={t('projects.refresh')}
            onClick={() => spin(fetchProjects)}
          >
            <RefreshCw className={`w-4 h-4 ${spinning ? 'spin-once' : ''}`} />
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'flex-1 overflow-auto overscroll-none px-8 pb-6 scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent',
          mobileRuntime && 'mobile-page-scrollbar',
          phoneLayout && 'px-4 pb-5'
        )}
      >
        {loading ? (
          <ProjectListSkeleton />
        ) : filtered.length > 0 ? (
          <div
            className={cn(
              'divide-y divide-border',
              phoneLayout && 'flex flex-col gap-3 divide-y-0'
            )}
          >
            {filtered.map((metadata) => (
              <ContextMenu key={metadata.title}>
                <ContextMenuTrigger className={phoneLayout ? 'block' : undefined}>
                  <div
                    className={cn(
                      'group -mx-2 flex cursor-default items-center justify-between rounded-md px-2 py-3 transition-colors hover:bg-accent/50',
                      phoneLayout &&
                        'mx-0 min-h-16 rounded-xl border bg-card px-3 py-2 shadow-xs active:bg-accent/70'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{metadata.title}</p>
                      <div className="flex items-center text-xs text-muted-foreground mt-0.5">
                        <Clock className="w-3 h-3 mr-1 flex-shrink-0" />
                        <span>{timeAgo(metadata.lastModified)}</span>
                      </div>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1 transition-opacity',
                        alwaysShowRowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className={phoneLayout ? 'size-10' : 'size-9'}
                        aria-label={t('common.edit')}
                        onClick={() => handleOpenEditor(metadata.title)}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={phoneLayout ? 'size-10' : 'size-9'}
                        aria-label={t('common.play')}
                        onClick={() => handleOpenPlayer(metadata.title)}
                      >
                        <Play className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="font-medium select-none">
                  <ContextMenuItem onClick={() => handleOpenEditor(metadata.title)}>
                    <Edit3 className="w-4 h-4 mr-2" />
                    {t('common.edit')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => {
                      setNewName(metadata.title)
                      setRenameTarget(metadata.title)
                    }}
                  >
                    <FileEdit className="w-4 h-4 mr-2" />
                    {t('common.rename')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={exportingProject === metadata.title}
                    onClick={(): void => void handleExport(metadata.title)}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    {exportingProject === metadata.title
                      ? t('projectArchive.exporting')
                      : t('projectArchive.export')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => setDeleteTarget(metadata.title)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    {t('common.delete')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <FolderOpen className="w-12 h-12 text-muted-foreground/60 mb-4" />
            <p className="text-sm text-muted-foreground mb-4">
              {search.trim() ? t('projects.noMatch') : t('projects.empty')}
            </p>
            {!search.trim() && (
              <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />
                {t('project.new')}
              </Button>
            )}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={handleProjectCreated}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('project.deleteDescription', { name: deleteTarget })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t('common.deleting') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="select-none">
          <DialogHeader>
            <DialogTitle>{t('project.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('project.renamePlaceholder')}
            disabled={isRenaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isRenaming) setTimeout(() => handleRename())
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={isRenaming}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRename} disabled={isRenaming || !newName.trim()}>
              {isRenaming ? t('common.renaming') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {exportNotice && (
        <Toast
          key={exportNotice.id}
          message={exportNotice.message}
          variant={exportNotice.variant}
          closeLabel={t('common.close')}
          onDismiss={(): void => setExportNotice(null)}
        />
      )}
    </div>
  )
}

function ProjectListSkeleton(): JSX.Element {
  return (
    <div className="divide-y divide-border" aria-busy="true">
      {[0, 1, 2, 3, 4].map(
        (index: number): JSX.Element => (
          <div key={index} className="flex h-[61px] items-center px-2 -mx-2">
            <div className="w-full space-y-2">
              <div className="h-3.5 w-36 rounded-sm bg-muted" />
              <div className="h-2.5 w-24 rounded-sm bg-muted/70" />
            </div>
          </div>
        )
      )}
    </div>
  )
}
