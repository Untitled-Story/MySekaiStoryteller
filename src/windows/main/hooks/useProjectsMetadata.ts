import { useContext } from 'react'
import {
  ProjectsMetadataContext,
  type ProjectsMetadataState
} from '@/windows/main/hooks/projectsMetadataContext'

export function useProjectsMetadata(): ProjectsMetadataState {
  const context = useContext(ProjectsMetadataContext)
  if (!context) {
    throw new Error('useProjectsMetadata must be used within ProjectsMetadataProvider')
  }
  return context
}
