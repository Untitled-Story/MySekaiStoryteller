import { useState, useEffect, useCallback } from 'react'
import { getProjectsMetadata } from '@/project/api'
import type { ProjectMetadata } from '@/project/metadata'

export function useProjectsMetadata() {
  const [projects, setProjects] = useState<ProjectMetadata[]>([])

  const fetchProjects = useCallback(async () => {
    setProjects(await getProjectsMetadata())
  }, [])

  useEffect(() => {
    fetchProjects().catch(console.error)
  }, [fetchProjects])

  return { projects, fetchProjects }
}
