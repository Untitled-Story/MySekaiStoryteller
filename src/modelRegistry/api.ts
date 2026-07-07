import { invoke } from '@tauri-apps/api/core'
import { ModelRegistrySchema, type ModelRegistry } from './schema'

export async function getModelRegistry(): Promise<ModelRegistry> {
  const raw = await invoke<unknown>('get_model_registry')
  return ModelRegistrySchema.parse(raw)
}
