import { useState, useEffect, useCallback } from 'react'
import { getProjectsMetadata } from '@/project/api'
import type { ProjectMetadata } from '@/project/metadata'
import { describeError, logger } from '@/lib/logger'

type ProjectsMetadataHook = {
  projects: ProjectMetadata[]
  fetchProjects: () => Promise<void>
}

export function useProjectsMetadata(): ProjectsMetadataHook {
  const [projects, setProjects] = useState<ProjectMetadata[]>([])

  const fetchProjects = useCallback(async (): Promise<void> => {
    const startedAt: number = performance.now()
    logger.info('projects.load_started')
    try {
      const nextProjects: ProjectMetadata[] = await getProjectsMetadata()
      setProjects(nextProjects)
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
    }
  }, [])

  useEffect((): void => {
    void fetchProjects().catch(console.error)
  }, [fetchProjects])

  return { projects, fetchProjects }
}
