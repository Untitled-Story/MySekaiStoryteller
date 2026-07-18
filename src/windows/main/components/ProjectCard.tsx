import { Card } from '@/components/ui/Card'
import { Clock, Edit3, Play, Trash2, FileEdit, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { timeAgo } from '@/windows/main/utils/time'
import type { ProjectMetadata } from '@/project/metadata'
import { deleteProject, renameProject } from '@/project/api'
import { openEditorWindow, openPlayerWindow } from '@/windows/api'
import { useState, type JSX } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/ContextMenu'
import { useLongPressContextMenu } from '@/hooks/useLongPressContextMenu'
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
import { Input } from '@/components/ui/Input'
import { useTranslation } from 'react-i18next'

interface ProjectCardProps {
  metadata: ProjectMetadata
  onDelete?: () => void
  onRename?: () => void
}

export function ProjectCard({ metadata, onDelete, onRename }: ProjectCardProps): JSX.Element {
  const { t } = useTranslation()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [newName, setNewName] = useState(metadata.title)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [openingEditor, setOpeningEditor] = useState(false)
  const [openingPlayer, setOpeningPlayer] = useState(false)
  const [contextMenuKey, setContextMenuKey] = useState(0)
  const longPressHandlers = useLongPressContextMenu({
    onOpen: (): void => {
      setContextMenuKey((key: number): number => key + 1)
    }
  })

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteProject(metadata.title)
      onDelete?.()
    } catch (error) {
      alert(
        t('project.deleteFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setIsDeleting(false)
      setShowDeleteDialog(false)
    }
  }

  const handleRename = async () => {
    if (newName.trim() === metadata.title) {
      setShowRenameDialog(false)
      return
    }

    setIsRenaming(true)
    try {
      await renameProject(metadata.title, newName.trim())
      onRename?.()
    } catch (error) {
      alert(
        t('project.renameFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setIsRenaming(false)
      setShowRenameDialog(false)
    }
  }

  const handleOpenEditor = async () => {
    if (openingEditor) return
    setOpeningEditor(true)
    try {
      await openEditorWindow(metadata.title)
    } catch (error) {
      alert(
        t('project.openEditorFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setOpeningEditor(false)
    }
  }

  const handleOpenPlayer = async () => {
    if (openingPlayer) return
    setOpeningPlayer(true)
    try {
      await openPlayerWindow(metadata.title)
    } catch (error) {
      alert(
        t('project.openPlayerFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    } finally {
      setOpeningPlayer(false)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          className="select-none"
          onContextMenu={() => setContextMenuKey((key) => key + 1)}
          {...longPressHandlers}
        >
          <Card className="cursor-pointer p-4 transition-shadow hover:shadow-md">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h4 className="mb-1 truncate text-base font-medium">{metadata.title}</h4>
                <div className="flex items-center text-sm text-muted-foreground">
                  <Clock className="mr-1 h-3.5 w-3.5" />
                  <span>{timeAgo(metadata.lastModified)}</span>
                </div>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-9 shrink-0"
                aria-label={t('common.moreActions')}
                title={t('common.moreActions')}
                onClick={(event): void => {
                  event.preventDefault()
                  event.stopPropagation()
                  setContextMenuKey((key: number): number => key + 1)
                  const target: EventTarget | null = event.currentTarget
                  if (!(target instanceof HTMLElement)) return
                  const rect: DOMRect = target.getBoundingClientRect()
                  target.dispatchEvent(
                    new MouseEvent('contextmenu', {
                      bubbles: true,
                      cancelable: true,
                      clientX: rect.left + rect.width / 2,
                      clientY: rect.bottom,
                      button: 2,
                      buttons: 2,
                      view: window
                    })
                  )
                }}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </div>
            <div className="flex space-x-2">
              <Button
                size="sm"
                variant="outline"
                className="h-10 flex-1 bg-transparent"
                onClick={handleOpenEditor}
                disabled={openingEditor}
              >
                <Edit3 className="mr-1 h-3.5 w-3.5" />
                {t('common.edit')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-10 flex-1 bg-transparent"
                onClick={handleOpenPlayer}
                disabled={openingPlayer}
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                {t('common.play')}
              </Button>
            </div>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent key={contextMenuKey} className="font-medium select-none">
          <ContextMenuItem
            onClick={() => {
              setNewName(metadata.title)
              setShowRenameDialog(true)
            }}
          >
            <FileEdit className="w-4 h-4 mr-2" />
            {t('common.rename')}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t('common.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('project.deleteDescription', { name: metadata.title })}
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

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
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
            <Button
              variant="outline"
              onClick={() => setShowRenameDialog(false)}
              disabled={isRenaming}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRename} disabled={isRenaming || !newName.trim()}>
              {isRenaming ? t('common.renaming') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
