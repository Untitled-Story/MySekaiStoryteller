import { Button } from '@renderer/components/ui/Button'
import { Clock, Edit3, MoreHorizontal, Play, Plus } from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'

export default function HomePage() {
  const projects = [
    { title: 'Beauty Eggs', lastModified: '2 小时前' },
    { title: 'Ugly Eggs', lastModified: '1 年前' },
    { title: 'Easter Eggs', lastModified: '3 世纪前' }
  ]

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
              <Button variant="default" size="sm">
                <Plus className="w-4 h-4 mr-1" />
                新建
              </Button>
              <Button variant="ghost" size="sm">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-8 overflow-auto scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-white">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4 pb-4">
          {projects.map((project, index) => (
            <Card key={index} className="p-4 hover:shadow-md transition-shadow cursor-pointer">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <h4 className="font-medium text-base mb-1">{project.title}</h4>
                  <div className="flex items-center text-sm text-muted-foreground">
                    <Clock className="w-3 h-3 mr-1" />
                    <span>{project.lastModified}</span>
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
          ))}
        </div>
      </div>
    </div>
  )
}
