import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { ProjectCard } from '@/windows/main/components/ProjectCard'
import { CreateProjectDialog } from '@/windows/main/components/CreateProjectDialog'
import { useProjectsMetadata } from '@/windows/main/hooks/useProjectsMetadata'
import { useSpinOnce } from '@/windows/main/hooks/useSpinOnce'
import { ProjectMetadata } from '@/types/ProjectMetadata'

export default function HomePage(): JSX.Element {
  const { projects, fetchProjects } = useProjectsMetadata()
  const { spinning, spin } = useSpinOnce()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const recentProjects: ProjectMetadata[] = [...projects]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 5)

  return (
    <div className="flex flex-col h-screen select-none">
      <div className="px-8 pt-8 pb-6 flex-shrink-0">
        <h2 className="font-semibold text-2xl">欢迎回来</h2>
        <p className="text-sm text-muted-foreground mt-1">选择一个项目开始创作，或新建一个。</p>
      </div>

      <div className="px-8 flex-shrink-0">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <h3 className="text-sm font-medium text-muted-foreground">最近的项目</h3>
          <div className="flex space-x-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => spin(fetchProjects)}>
              <RefreshCw className={`w-3.5 h-3.5 ${spinning ? 'spin-once' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              新建
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 px-8 overflow-auto scrollbar-thin scrollbar-thumb-gray-400 dark:scrollbar-thumb-[#2C2C2C] scrollbar-track-transparent">
        {recentProjects.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 py-4">
            {recentProjects.map((metadata) => (
              <ProjectCard
                metadata={metadata}
                key={metadata.title}
                onDelete={() => spin(fetchProjects)}
                onRename={() => spin(fetchProjects)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <FolderOpen className="w-12 h-12 text-muted-foreground/40 mb-4" />
            <p className="text-sm text-muted-foreground mb-4">还没有项目，创建一个开始吧</p>
            <Button variant="outline" size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1" />
              新建项目
            </Button>
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => spin(fetchProjects)}
      />
    </div>
  )
}
