import { ElectronAPI } from '@electron-toolkit/preload'
import { ProjectMetadata } from '../common/types/ProjectMetadata'

declare global {
  interface Window {
    electron: ElectronAPI
    projectAPI: {
      getProjects: () => Promise<string[]>
      getProjectMetadata: (projectName: string) => Promise<ProjectMetadata | null>
      setProjectMetadata: (projectName: string, data: ProjectMetadata) => Promise<void>
    }
  }
}
