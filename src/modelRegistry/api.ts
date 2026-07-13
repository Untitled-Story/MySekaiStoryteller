import { invoke } from '@tauri-apps/api/core'
import {
  ImportedModelResultSchema,
  ModelRegistrySchema,
  type ImportedModelResult,
  type ModelRegistry
} from './schema'

export async function getModelRegistry(): Promise<ModelRegistry> {
  const raw = await invoke<unknown>('get_model_registry')
  return ModelRegistrySchema.parse(raw)
}

export async function importGlobalModel(
  sourcePath: string,
  name?: string
): Promise<ImportedModelResult> {
  const raw = await invoke<unknown>('import_global_model', { sourcePath, name })
  return ImportedModelResultSchema.parse(raw)
}
