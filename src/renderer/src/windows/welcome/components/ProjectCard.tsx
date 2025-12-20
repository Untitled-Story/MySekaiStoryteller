import { Card } from '@renderer/components/ui/Card'
import { Clock, Edit3, Play, Trash2, FileEdit } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { timeAgo } from '@windows/welcome/utils/time'
import { ProjectMetadata } from '@common/types/ProjectMetadata'
import { useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@renderer/components/ui/ContextMenu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/AlertDialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@renderer/components/ui/Dialog'
import { Input } from '@renderer/components/ui/Input'

interface ProjectCardProps {
  metadata: ProjectMetadata
  onDelete?: () => void
  onRename?: () => void
}

export function ProjectCard({ metadata, onDelete, onRename }: ProjectCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [newName, setNewName] = useState(metadata.title)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [contextMenuKey, setContextMenuKey] = useState(0)

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const result = await window.projectAPI.deleteProject(metadata.title)
      if (result.success) {
        onDelete?.()
      } else {
        alert(result.error || '删除失败')
      }
    } catch (error) {
      alert('删除失败: ' + (error instanceof Error ? error.message : '未知错误'))
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
      const result = await window.projectAPI.renameProject(metadata.title, newName.trim())
      if (result.success) {
        onRename?.()
      } else {
        alert(result.error || '重命名失败')
      }
    } catch (error) {
      alert('重命名失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsRenaming(false)
      setShowRenameDialog(false)
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
                  <Clock className="w-3 h-3 mr-1" />
                  <span>{timeAgo(metadata.lastModified)}</span>
                </div>
              </div>
            </div>
            <div className="flex space-x-2">
              <Button size="sm" variant="outline" className="flex-1 bg-transparent">
                <Edit3 className="w-3 h-3 mr-1" />
                编辑
              </Button>
              <Button size="sm" variant="outline" className="flex-1 bg-transparent">
                <Play className="w-3 h-3 mr-1" />
                播放
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
            重命名
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="w-4 h-4 mr-2" />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除项目 "{metadata.title}" 吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? '删除中...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="select-none">
          <DialogHeader>
            <DialogTitle>重命名项目</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="输入新的项目名称"
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
              取消
            </Button>
            <Button onClick={handleRename} disabled={isRenaming || !newName.trim()}>
              {isRenaming ? '重命名中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
