import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

function projectNameFromSearch(): string | null {
  const params: URLSearchParams = new URLSearchParams(window.location.search)
  return params.get('project')
}

function projectNameFromHash(): string | null {
  const rawHash: string = window.location.hash.replace(/^#/, '')
  if (!rawHash) return null

  const path: string = rawHash.split('?')[0] ?? ''
  const segments: string[] = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  if (segments[0] !== 'editor' && segments[0] !== 'player') return null

  try {
    return decodeURIComponent(segments[1] ?? '')
  } catch {
    return segments[1] ?? null
  }
}

function readProjectName(preferred?: string | null): string | null {
  if (preferred) return preferred
  return projectNameFromSearch() ?? projectNameFromHash()
}

export function useWindowProjectName(preferredProjectName?: string | null): string | null {
  const [projectName, setProjectName] = useState<string | null>((): string | null =>
    readProjectName(preferredProjectName)
  )

  useEffect((): void => {
    setProjectName(readProjectName(preferredProjectName))
  }, [preferredProjectName])

  useEffect((): (() => void) => {
    if (preferredProjectName) {
      return (): void => undefined
    }

    function syncFromLocation(): void {
      setProjectName(readProjectName(null))
    }

    const unlistenPromise = listen<string>('project-changed', (event): void => {
      setProjectName(event.payload)
    })

    window.addEventListener('hashchange', syncFromLocation)
    window.addEventListener('popstate', syncFromLocation)

    return (): void => {
      void unlistenPromise.then((unlisten: () => void): void => unlisten())
      window.removeEventListener('hashchange', syncFromLocation)
      window.removeEventListener('popstate', syncFromLocation)
    }
  }, [preferredProjectName])

  return projectName
}
