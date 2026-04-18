import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ProjectMetadata } from '@/types/ProjectMetadata'

export function useProjectsMetadata() {
  const [projects, setProjects] = useState<ProjectMetadata[]>([])

  const fetchProjects = useCallback(async () => {
    const names = await invoke<string[]>('get_projects')
    const projectsWithMeta = await Promise.all(
      names.map((name) => invoke<ProjectMetadata | null>('get_project_metadata', { projectName: name }))
    )
    setProjects(projectsWithMeta.filter(Boolean) as ProjectMetadata[])
  }, [])

  useEffect(() => {
    fetchProjects().catch(console.error)
  }, [fetchProjects])

  return { projects, fetchProjects }
}
