import { invoke } from '@tauri-apps/api/core'
import { ProjectAssetsSchema, type ProjectAssets } from './assets'
import { ProjectMetadataSchema, type ProjectMetadata } from './metadata'

export function getProjects(): Promise<string[]> {
  return invoke<string[]>('get_projects')
}

export async function getProjectsMetadata(): Promise<ProjectMetadata[]> {
  const names = await getProjects()
  const projectsWithMeta = await Promise.all(names.map((name) => getProjectMetadata(name)))
  return projectsWithMeta.filter((metadata): metadata is ProjectMetadata => Boolean(metadata))
}

export async function getProjectMetadata(projectName: string): Promise<ProjectMetadata | null> {
  const raw = await invoke<unknown | null>('get_project_metadata', { projectName })
  return raw ? ProjectMetadataSchema.parse(raw) : null
}

export function setProjectMetadata(projectName: string, metadata: ProjectMetadata): Promise<void> {
  return invoke('set_project_metadata', { projectName, metadata })
}

export function createProject(projectName: string): Promise<void> {
  return invoke('create_project', { projectName })
}

export function deleteProject(projectName: string): Promise<void> {
  return invoke('delete_project', { projectName })
}

export function renameProject(oldName: string, newName: string): Promise<void> {
  return invoke('rename_project', { oldName, newName })
}

export function getProjectPath(projectName: string): Promise<string> {
  return invoke<string>('get_project_path', { projectName })
}

export async function getProjectAssets(projectName: string): Promise<ProjectAssets> {
  const raw = await invoke<unknown>('get_project_assets', { projectName })
  return ProjectAssetsSchema.parse(raw)
}

export function setProjectAssets(projectName: string, assets: ProjectAssets): Promise<void> {
  return invoke('set_project_assets', { projectName, assets })
}
