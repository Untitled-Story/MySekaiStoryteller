import type { JSX } from 'react'
import { useState } from 'react'
import { Plus, Edit3, Play, Clock, Folder, Settings } from 'lucide-react'
import { CreateProjectDialog } from '@/windows/main/components/CreateProjectDialog'
import { useProjectsMetadata } from '@/windows/main/hooks/useProjectsMetadata'
import type { ProjectMetadata } from '@/project/metadata'
import { timeAgo } from '@/windows/main/utils/time'
import { useNavigate } from 'react-router'
import { openEditorWindow, openPlayerWindow } from '@/windows/api'

export default function HomePage(): JSX.Element {
  const { projects, fetchProjects } = useProjectsMetadata()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const navigate = useNavigate()

  const latest: ProjectMetadata | null = projects.length > 0
    ? [...projects].sort((a, b) => b.lastModified - a.lastModified)[0]
    : null

  const handleOpenEditor = async (title: string) => {
    try {
      await openEditorWindow(title)
    } catch (error) {
      alert('打开编辑器失败: ' + (error instanceof Error ? error.message : '未知错误'))
    }
  }

  const handleOpenPlayer = async (title: string) => {
    try {
      await openPlayerWindow(title)
    } catch (error) {
      alert('打开播放器失败: ' + (error instanceof Error ? error.message : '未知错误'))
    }
  }

  return (
    <div className="flex flex-col h-screen select-none px-8 py-8">
      <div className="mb-8">
        <h2 className="font-semibold text-2xl">欢迎回来</h2>
      </div>

      <div className="flex gap-8">
        {/* 左栏：最近项目 */}
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">上次编辑</h3>
          {latest ? (
            <div className="space-y-4">
              <div>
                <h4 className="font-medium text-lg truncate">{latest.title}</h4>
                <div className="flex items-center text-xs text-muted-foreground mt-1">
                  <Clock className="w-3 h-3 mr-1" />
                  <span>{timeAgo(latest.lastModified)}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleOpenEditor(latest.title)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  继续编辑
                </button>
                <button
                  onClick={() => handleOpenPlayer(latest.title)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-md border border-border text-sm font-medium hover:bg-accent transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  播放
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">还没有编辑过项目。</p>
          )}
        </div>

        {/* 右栏：快捷操作 */}
        <div className="w-48 flex-shrink-0">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">快捷操作</h3>
          <nav className="space-y-1">
            <button
              onClick={() => setCreateDialogOpen(true)}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sm hover:bg-accent transition-colors text-left"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
              新建项目
            </button>
            <button
              onClick={() => navigate('/projects')}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sm hover:bg-accent transition-colors text-left"
            >
              <Folder className="w-4 h-4 text-muted-foreground" />
              所有项目
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sm hover:bg-accent transition-colors text-left"
            >
              <Settings className="w-4 h-4 text-muted-foreground" />
              设置
            </button>
          </nav>
        </div>
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => fetchProjects()}
      />
    </div>
  )
}
