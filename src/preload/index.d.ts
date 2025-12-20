import { ElectronAPI } from '@electron-toolkit/preload'
import { ProjectMetadata } from '../common/types/ProjectMetadata'
import { EditorProjectPayload } from '../common/types/EditorProjectPayload'

declare global {
  interface Window {
    electron: ElectronAPI
    projectAPI: {
      getProjects: () => Promise<string[]>
      getProjectMetadata: (projectName: string) => Promise<ProjectMetadata | null>
      setProjectMetadata: (projectName: string, data: ProjectMetadata) => Promise<void>
      createProject: (projectName: string) => Promise<{ success: boolean; error?: string }>
      deleteProject: (projectName: string) => Promise<{ success: boolean; error?: string }>
      renameProject: (
        oldName: string,
        newName: string
      ) => Promise<{ success: boolean; error?: string }>
    }
    editorAPI: {
      openProject: (projectName: string) => Promise<{ success: boolean; error?: string }>
      onProjectData: (callback: (payload: EditorProjectPayload) => void) => () => void
    }
  }
}
