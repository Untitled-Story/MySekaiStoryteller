import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { invoke } from '@tauri-apps/api/core'
import {
  FolderOpen, Plus, RefreshCw, Search, ArrowUpDown,
  Edit3, Play, FileEdit, Trash2, Clock
} from 'lucide-react'
import { CreateProjectDialog } from '@/windows/main/components/CreateProjectDialog'
import { useProjectsMetadata } from '@/windows/main/hooks/useProjectsMetadata'
import { useSpinOnce } from '@/windows/main/hooks/useSpinOnce'
import { ProjectMetadata } from '@/types/ProjectMetadata'
import { timeAgo } from '@/windows/main/utils/time'
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

export default function ProjectsPage(): JSX.Element {
  const { projects, fetchProjects } = useProjectsMetadata()
  const { spinning, spin } = useSpinOnce()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

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

  const toggleSort = () => setSortMode((prev) => (prev === 'recent' ? 'name' : 'recent'))

  const handleOpenEditor = async (title: string) => {
    try {
      await invoke('open_editor', { projectName: title })
    } catch (error) {
      alert('打开编辑器失败: ' + (error instanceof Error ? error.message : '未知错误'))
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await invoke('delete_project', { projectName: deleteTarget })
      spin(fetchProjects)
    } catch (error) {
      alert('删除失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }

  const handleRename = async () => {
    if (!renameTarget || !newName.trim()) return
    if (newName.trim() === renameTarget) {
      setRenameTarget(null)
      return
    }
    setIsRenaming(true)
    try {
      await invoke('rename_project', { oldName: renameTarget, newName: newName.trim() })
      spin(fetchProjects)
    } catch (error) {
      alert('重命名失败: ' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
      setIsRenaming(false)
      setRenameTarget(null)
    }
  }

  return (
    <div className="flex flex-col h-screen select-none">
      <div className="px-8 pt-8 pb-6 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-2xl">所有项目</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {projects.length > 0 ? `共 ${projects.length} 个项目` : '管理你的所有项目。'}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            新建项目
          </Button>
        </div>
      </div>

      <div className="px-8 flex-shrink-0 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜索项目..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label={sortMode === 'recent' ? '按名称排序' : '按时间排序'}
            title={sortMode === 'recent' ? '当前: 按时间' : '当前: 按名称'}
            onClick={toggleSort}
          >
            <ArrowUpDown className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新项目列表"
            onClick={() => spin(fetchProjects)}
          >
            <RefreshCw className={`w-4 h-4 ${spinning ? 'spin-once' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="flex-1 px-8 overflow-auto scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent">
        {filtered.length > 0 ? (
          <div className="divide-y divide-border">
            {filtered.map((metadata) => (
              <ContextMenu key={metadata.title}>
                <ContextMenuTrigger>
                  <div className="flex items-center justify-between py-3 px-2 -mx-2 rounded-md hover:bg-accent/50 transition-colors cursor-default group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{metadata.title}</p>
                      <div className="flex items-center text-xs text-muted-foreground mt-0.5">
                        <Clock className="w-3 h-3 mr-1 flex-shrink-0" />
                        <span>{timeAgo(metadata.lastModified)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="编辑"
                        onClick={() => handleOpenEditor(metadata.title)}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="播放"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="font-medium select-none">
                  <ContextMenuItem onClick={() => handleOpenEditor(metadata.title)}>
                    <Edit3 className="w-4 h-4 mr-2" />
                    编辑
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => {
                      setNewName(metadata.title)
                      setRenameTarget(metadata.title)
                    }}
                  >
                    <FileEdit className="w-4 h-4 mr-2" />
                    重命名
                  </ContextMenuItem>
                  <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget(metadata.title)}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    删除
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <FolderOpen className="w-12 h-12 text-muted-foreground/60 mb-4" />
            <p className="text-sm text-muted-foreground mb-4">
              {search.trim() ? '没有找到匹配的项目' : '还没有项目，新建一个开始吧'}
            </p>
            {!search.trim() && (
              <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />
                新建项目
              </Button>
            )}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => spin(fetchProjects)}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除项目 &ldquo;{deleteTarget}&rdquo; 吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? '删除中...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
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
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={isRenaming}>
              取消
            </Button>
            <Button onClick={handleRename} disabled={isRenaming || !newName.trim()}>
              {isRenaming ? '重命名中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
