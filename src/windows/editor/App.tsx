import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useWindowProjectName } from '@/windows/useWindowProjectName'
import { getProjectMetadata, getProjectPath } from '@/project/api'
import type { ProjectMetadata } from '@/project/metadata'

export default function App(): JSX.Element {
  const projectName = useWindowProjectName()
  const [metadata, setMetadata] = useState<ProjectMetadata | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    if (!projectName) return

    Promise.all([
      getProjectMetadata(projectName),
      getProjectPath(projectName)
    ])
      .then(([meta, path]) => {
        setMetadata(meta)
        setProjectPath(path)
      })
      .catch(console.error)
  }, [projectName])

  return (
    <div className="p-6 space-y-2 text-sm text-foreground">
      {metadata ? (
        <>
          <div>当前项目：{metadata.title}</div>
          <div>路径：{projectPath}</div>
          <div>最近修改：{new Date(metadata.lastModified).toLocaleString()}</div>
        </>
      ) : (
        <div>等待项目数据...</div>
      )}
    </div>
  )
}
