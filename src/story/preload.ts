import type { Application } from 'pixi.js'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { ProjectAssets } from '@/project/assets'
import { loadSekaiLive2DModel } from '@/lib/live2d'
import type { ResolvedAsset, StoryModelInstance } from './types'
import { resolveModelUrl } from './runtime'

export type PreloadStoryModelsOptions = {
  app: Application
  dataPath: string
  assets: ProjectAssets
  modelRegistry: ModelRegistry
}

export class StoryModelPreloadError extends Error {
  readonly modelKey: string
  readonly modelName: string
  readonly modelUrl: string
  readonly cause: unknown

  constructor(
    modelKey: string,
    resolved: ResolvedAsset<ProjectAssets['models'][string]>,
    cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : 'Live2D 模型加载失败'
    super(`Live2D 模型加载失败: ${resolved.asset.name ?? resolved.asset.modelId}: ${message}`)
    this.name = 'StoryModelPreloadError'
    this.modelKey = modelKey
    this.modelName = resolved.asset.name ?? resolved.asset.modelId
    this.modelUrl = resolved.url
    this.cause = cause
  }
}

export async function preloadStoryModels({
  app,
  dataPath,
  assets,
  modelRegistry
}: PreloadStoryModelsOptions): Promise<StoryModelInstance[]> {
  return Promise.all(
    Object.keys(assets.models).map(async (modelKey) => {
      const resolved = resolveModelUrl(dataPath, assets, modelRegistry, modelKey)

      try {
        const model = await loadSekaiLive2DModel(resolved.url, { ticker: app.ticker })

        return {
          key: modelKey,
          asset: resolved.asset,
          model
        }
      } catch (error: unknown) {
        throw new StoryModelPreloadError(modelKey, resolved, error)
      }
    })
  )
}
