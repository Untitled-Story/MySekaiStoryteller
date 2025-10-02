import { Card } from '@renderer/components/ui/Card'
import { Clock, Edit3, Play } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { timeAgo } from '@windows/welcome/utils/time'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

export function ProjectCard({ metadata }: { metadata: ProjectMetadata }) {
  return (
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
  )
}
