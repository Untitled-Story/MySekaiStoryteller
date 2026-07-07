import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

export function useWindowProjectName(): string | null {
  const [projectName, setProjectName] = useState<string | null>(null)

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

  return projectName
}
