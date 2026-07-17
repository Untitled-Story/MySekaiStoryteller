import { Card } from '@/components/ui/Card'
import { Clock, Edit3, Play, Trash2, FileEdit } from 'lucide-react'
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
        >
          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer">
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <h4 className="font-medium text-base mb-1">{metadata.title}</h4>
                <div className="flex items-center text-sm text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 mr-1" />
                  <span>{timeAgo(metadata.lastModified)}</span>
                </div>
              </div>
            </div>
            <div className="flex space-x-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 bg-transparent"
                onClick={handleOpenEditor}
                disabled={openingEditor}
              >
                <Edit3 className="w-3.5 h-3.5 mr-1" />
                {t('common.edit')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 bg-transparent"
                onClick={handleOpenPlayer}
                disabled={openingPlayer}
              >
                <Play className="w-3.5 h-3.5 mr-1" />
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
