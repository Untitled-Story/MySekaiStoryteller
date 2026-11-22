import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import {
  ImportedModelResultSchema,
  ModelArchiveInspectionSchema,
  ModelRegistrySchema,
  type ImportedModelResult,
  type ModelArchiveInspection,
  type ModelRegistry
} from './schema'
import { runLoggedOperation } from '@/lib/logger'

export async function getModelRegistry(): Promise<ModelRegistry> {
  const raw = await invoke<unknown>('get_model_registry')
  return ModelRegistrySchema.parse(raw)
}

export async function importGlobalModel(
  sourcePath: string,
  name?: string,
  archiveEntry?: string
): Promise<ImportedModelResult> {
  return runLoggedOperation(
    'model.import',
    {
      sourceKind: pickedSourceKind(sourcePath),
      hasCustomName: Boolean(name),
      hasSelectedEntry: Boolean(archiveEntry)
    },
    async (): Promise<ImportedModelResult> => {
      const raw: unknown = await invoke<unknown>('import_global_model', {
        sourcePath,
        name,
        archiveEntry
      })
      return ImportedModelResultSchema.parse(raw)
    }
  )
}

export async function renameGlobalModel(modelId: string, name: string): Promise<ModelRegistry> {
  return runLoggedOperation('model.rename', {}, async (): Promise<ModelRegistry> => {
    const raw: unknown = await invoke<unknown>('rename_global_model', { modelId, name })
    return ModelRegistrySchema.parse(raw)
  })
}

export async function deleteGlobalModel(modelId: string): Promise<ModelRegistry> {
  return runLoggedOperation('model.delete', {}, async (): Promise<ModelRegistry> => {
    const raw: unknown = await invoke<unknown>('delete_global_model', { modelId })
    return ModelRegistrySchema.parse(raw)
  })
}

/** Names of the projects that still register the model. */
export async function getModelReferences(modelId: string): Promise<string[]> {
  const raw: unknown = await invoke<unknown>('get_model_references', { modelId })
  return z.array(z.string()).parse(raw)
}

export async function inspectModelArchive(sourcePath: string): Promise<ModelArchiveInspection> {
  return runLoggedOperation(
    'model.archive_inspect',
    { sourceKind: pickedSourceKind(sourcePath) },
    async (): Promise<ModelArchiveInspection> => {
      const raw: unknown = await invoke<unknown>('inspect_model_archive', { sourcePath })
      return ModelArchiveInspectionSchema.parse(raw)
    }
  )
}

function pickedSourceKind(sourcePath: string): 'content-uri' | 'file-uri' | 'local-path' {
  const normalized: string = sourcePath.toLowerCase()
  if (normalized.startsWith('content://')) return 'content-uri'
  if (normalized.startsWith('file://')) return 'file-uri'
  return 'local-path'
}
