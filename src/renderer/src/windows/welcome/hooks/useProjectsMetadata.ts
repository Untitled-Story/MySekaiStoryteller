import { useState, useEffect, useCallback } from 'react'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

export function useProjectsMetadata() {
  const [projects, setProjects] = useState<ProjectMetadata[]>([])

  const fetchProjects = useCallback(async () => {
    const names = await window.projectAPI.getProjects()
    const projectsWithMeta = await Promise.all(
      names.map(async (name) => await window.projectAPI.getProjectMetadata(name))
    )
    setProjects(projectsWithMeta.filter(Boolean) as ProjectMetadata[])
  }, [])

  useEffect(() => {
    fetchProjects().catch(console.error)
  }, [fetchProjects])

  return { projects, fetchProjects }
}
