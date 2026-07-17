import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { getProjectsMetadata } from '@/project/api'
import type { ProjectMetadata } from '@/project/metadata'
import { describeError, logger } from '@/lib/logger'
import { PROJECTS_CHANGED_BROWSER_EVENT } from '@/project/archive'
import {
  ProjectsMetadataContext,
  type ProjectsMetadataState
} from '@/windows/main/hooks/projectsMetadataContext'

export function ProjectsMetadataProvider({ children }: { children: ReactNode }): JSX.Element {
  const [projects, setProjects] = useState<ProjectMetadata[]>([])
  const [loaded, setLoaded] = useState<boolean>(false)
  const initialLoadStartedRef = useRef<boolean>(false)
  const requestSequenceRef = useRef<number>(0)

  const fetchProjects = useCallback(async (): Promise<void> => {
    const requestSequence: number = ++requestSequenceRef.current
    const startedAt: number = performance.now()
    logger.info('projects.load_started')
    try {
      const nextProjects: ProjectMetadata[] = await getProjectsMetadata()
      if (requestSequence === requestSequenceRef.current) {
        setProjects(nextProjects)
      }
      logger.info('projects.load_completed', {
        durationMs: Math.round(performance.now() - startedAt),
        projectCount: nextProjects.length
      })
    } catch (error: unknown) {
      logger.error('projects.load_failed', {
        durationMs: Math.round(performance.now() - startedAt),
        error: describeError(error)
      })
      throw error
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoaded(true)
    }
  }, [])

  useEffect((): void => {
    if (initialLoadStartedRef.current) return
    initialLoadStartedRef.current = true
    void fetchProjects().catch(console.error)
  }, [fetchProjects])

  useEffect((): (() => void) => {
    const refresh = (): void => {
      void fetchProjects().catch(console.error)
    }
    window.addEventListener(PROJECTS_CHANGED_BROWSER_EVENT, refresh)
    return (): void => window.removeEventListener(PROJECTS_CHANGED_BROWSER_EVENT, refresh)
  }, [fetchProjects])

  const value: ProjectsMetadataState = useMemo(
    (): ProjectsMetadataState => ({ projects, fetchProjects, loading: !loaded }),
    [fetchProjects, loaded, projects]
  )

  return (
    <ProjectsMetadataContext.Provider value={value}>{children}</ProjectsMetadataContext.Provider>
  )
}
