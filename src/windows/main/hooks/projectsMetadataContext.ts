import { createContext } from 'react'
import type { ProjectMetadata } from '@/project/metadata'

export type ProjectsMetadataState = {
  projects: ProjectMetadata[]
  fetchProjects: () => Promise<void>
  loading: boolean
}

export const ProjectsMetadataContext = createContext<ProjectsMetadataState | null>(null)
