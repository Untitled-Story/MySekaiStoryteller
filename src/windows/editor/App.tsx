import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ProjectMetadata } from '@/types/ProjectMetadata'

export default function App(): JSX.Element {
  const [projectName, setProjectName] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<ProjectMetadata | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const name = params.get('project')
    if (name) {
      setProjectName(name)
    }

    const unlisten = listen<string>('project-changed', (event) => {
      setProjectName(event.payload)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  useEffect(() => {
    if (!projectName) return

    Promise.all([
      invoke<ProjectMetadata | null>('get_project_metadata', { projectName }),
      invoke<string>('get_project_path', { projectName })
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
