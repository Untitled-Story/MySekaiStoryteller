import { invoke } from '@tauri-apps/api/core'
import {
  ProjectAssetMutationResultSchema,
  ProjectAssetReferenceSchema,
  ProjectAssetsSchema,
  type ProjectAssetKind,
  type ProjectAssetMutationResult,
  type ProjectAssetReference,
  type ProjectAssets
} from './assets'
import { ProjectMetadataSchema, type ProjectMetadata } from './metadata'
import { runLoggedOperation } from '@/lib/logger'

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
  return runLoggedOperation(
    'project.create',
    { projectName },
    (): Promise<void> => invoke('create_project', { projectName })
  )
}

export function deleteProject(projectName: string): Promise<void> {
  return runLoggedOperation(
    'project.delete',
    { projectName },
    (): Promise<void> => invoke('delete_project', { projectName })
  )
}

export function renameProject(oldName: string, newName: string): Promise<void> {
  return runLoggedOperation(
    'project.rename',
    { oldName, newName },
    (): Promise<void> => invoke('rename_project', { oldName, newName })
  )
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

export async function importProjectAsset(
  projectName: string,
  assetKind: Exclude<ProjectAssetKind, 'models'>,
  sourcePath: string
): Promise<ProjectAssetMutationResult> {
  return runLoggedOperation(
    'asset.import',
    { projectName, assetKind, sourceKind: pickedSourceKind(sourcePath) },
    async (): Promise<ProjectAssetMutationResult> => {
      const raw: unknown = await invoke<unknown>('import_project_asset', {
        projectName,
        assetKind,
        sourcePath
      })
      return ProjectAssetMutationResultSchema.parse(raw)
    }
  )
}

export async function registerProjectModel(
  projectName: string,
  modelId: string,
  key?: string,
  name?: string
): Promise<ProjectAssetMutationResult> {
  return runLoggedOperation(
    'asset.model_register',
    { projectName, modelId, hasCustomKey: Boolean(key), hasCustomName: Boolean(name) },
    async (): Promise<ProjectAssetMutationResult> => {
      const raw: unknown = await invoke<unknown>('register_project_model', {
        projectName,
        modelId,
        key,
        name
      })
      return ProjectAssetMutationResultSchema.parse(raw)
    }
  )
}

export async function getProjectAssetReferences(
  projectName: string,
  assetKind: ProjectAssetKind,
  key: string
): Promise<ProjectAssetReference[]> {
  const raw = await invoke<unknown>('get_project_asset_references', {
    projectName,
    assetKind,
    key
  })
  return ProjectAssetReferenceSchema.array().parse(raw)
}

export async function renameProjectAsset(
  projectName: string,
  assetKind: ProjectAssetKind,
  oldKey: string,
  newKey: string
): Promise<ProjectAssets> {
  return runLoggedOperation(
    'asset.rename',
    { projectName, assetKind, oldKey, newKey },
    async (): Promise<ProjectAssets> => {
      const raw: unknown = await invoke<unknown>('rename_project_asset', {
        projectName,
        assetKind,
        oldKey,
        newKey
      })
      return ProjectAssetsSchema.parse(raw)
    }
  )
}

export async function deleteProjectAsset(
  projectName: string,
  assetKind: ProjectAssetKind,
  key: string
): Promise<ProjectAssets> {
  return runLoggedOperation(
    'asset.delete',
    { projectName, assetKind, key },
    async (): Promise<ProjectAssets> => {
      const raw: unknown = await invoke<unknown>('delete_project_asset', {
        projectName,
        assetKind,
        key
      })
      return ProjectAssetsSchema.parse(raw)
    }
  )
}

function pickedSourceKind(sourcePath: string): 'content-uri' | 'file-uri' | 'local-path' {
  const normalized: string = sourcePath.toLowerCase()
  if (normalized.startsWith('content://')) return 'content-uri'
  if (normalized.startsWith('file://')) return 'file-uri'
  return 'local-path'
}
