import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

// noinspection JSUnusedGlobalSymbols
const projectAPI = {
  getProjects: (): Promise<string[]> => ipcRenderer.invoke('project:get-projects'),
  getProjectMetadata: (projectName: string): Promise<ProjectMetadata | null> =>
    ipcRenderer.invoke('project:get-metadata', projectName),
  setProjectMetadata: (projectName: string, data: ProjectMetadata): Promise<void> =>
    ipcRenderer.invoke('project:set-metadata', projectName, data),
  createProject: (projectName: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('project:create', projectName),
  deleteProject: (projectName: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('project:delete', projectName),
  renameProject: (
    oldName: string,
    newName: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('project:rename', oldName, newName)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('projectAPI', projectAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.projectAPI = projectAPI
}
