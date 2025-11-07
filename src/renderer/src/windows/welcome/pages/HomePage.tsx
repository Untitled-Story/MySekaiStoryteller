import { useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Plus, RefreshCw } from 'lucide-react'
import { ProjectCard } from '@windows/welcome/components/ProjectCard'
import { CreateProjectDialog } from '@windows/welcome/components/CreateProjectDialog'
import { useProjectsMetadata } from '@windows/welcome/hooks/useProjectsMetadata'
import { useSpinOnce } from '@windows/welcome/hooks/useSpinOnce'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

export default function HomePage() {
  const { projects, fetchProjects } = useProjectsMetadata()
  const { spinning, spin } = useSpinOnce()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const recentProjects: ProjectMetadata[] = [...projects]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 5)

  return (
    <div className="flex flex-col h-screen select-none">
      <div className="p-8 flex-shrink-0">
        <h2 className="font-medium text-2xl">欢迎回来！</h2>
      </div>

      <div className="mx-8">
        <div className="border-b border-slate-200">
          <div className="flex-shrink-0 flex items-center justify-between mb-4 ">
            <h3 className="text-lg font-semibold">最近的项目</h3>
            <div className="flex space-x-2">
              <Button variant="ghost" size="sm" onClick={() => spin(fetchProjects)}>
                <RefreshCw className={`w-4 h-4 ${spinning ? 'spin-once' : ''}`} />
              </Button>
              <Button variant="default" size="sm" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />
                新建
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-8 overflow-auto scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-white">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4 pb-4">
          {recentProjects.map((metadata) => (
            <ProjectCard
              metadata={metadata}
              key={metadata.title}
              onDelete={() => spin(fetchProjects)}
              onRename={() => spin(fetchProjects)}
            />
          ))}
        </div>
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => spin(fetchProjects)}
      />
    </div>
  )
}
