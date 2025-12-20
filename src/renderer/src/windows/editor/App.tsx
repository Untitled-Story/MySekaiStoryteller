import React, { useEffect, useState } from 'react'
import { EditorProjectPayload } from '@common/types/EditorProjectPayload'

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<EditorProjectPayload | null>(null)

  useEffect(() => {
    return window.editorAPI.onProjectData((payload) => {
      setProject(payload)
    })
  }, [])

  return (
    <div className="p-6 space-y-2 text-sm text-foreground">
      {project ? (
        <>
          <div>当前项目：{project.metadata.title}</div>
          <div>路径：{project.path}</div>
          <div>最近修改：{new Date(project.metadata.lastModified).toLocaleString()}</div>
        </>
      ) : (
        <div>等待项目数据...</div>
      )}
    </div>
  )
}
