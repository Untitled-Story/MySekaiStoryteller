import { invoke } from '@tauri-apps/api/core'
import {
  ImportedModelResultSchema,
  ModelArchiveInspectionSchema,
  ModelRegistrySchema,
  type ImportedModelResult,
  type ModelArchiveInspection,
  type ModelRegistry
} from './schema'

export async function getModelRegistry(): Promise<ModelRegistry> {
  const raw = await invoke<unknown>('get_model_registry')
  return ModelRegistrySchema.parse(raw)
}

export async function importGlobalModel(
  sourcePath: string,
  name?: string,
  archiveEntry?: string
): Promise<ImportedModelResult> {
  const raw = await invoke<unknown>('import_global_model', { sourcePath, name, archiveEntry })
  return ImportedModelResultSchema.parse(raw)
}

export async function inspectModelArchive(sourcePath: string): Promise<ModelArchiveInspection> {
  const raw = await invoke<unknown>('inspect_model_archive', { sourcePath })
  return ModelArchiveInspectionSchema.parse(raw)
}
