import type { Application } from 'pixi.js'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { BackgroundAsset, ModelAsset, ProjectAssets, VoiceAsset } from '@/project/assets'
import { localAssetUrl, projectAssetUrl } from '@/lib/projectAssetUrl'
import { createStoryScene } from './scene'
import { StoryPlaybackClock } from './playbackClock'
import type { ResolvedAsset, StoryModelInstance, StoryRuntime } from './types'
import type { StoryVisualEffectRegistry } from './vfx'

export type CreateStoryRuntimeOptions = {
  app: Application
  dataPath: string
  projectPath: string
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  models?: Iterable<StoryModelInstance>
  visualEffects?: StoryVisualEffectRegistry
  fontFamily?: string
}

export function createStoryRuntime({
  app,
  dataPath,
  projectPath,
  assets,
  modelRegistry,
  models = [],
  visualEffects,
  fontFamily
}: CreateStoryRuntimeOptions): StoryRuntime {
  const modelMap = new Map<string, StoryModelInstance>()
  for (const model of models) {
    modelMap.set(model.key, model)
  }

  const resolveModel = (modelKey: string): ResolvedAsset<ModelAsset> =>
    resolveModelUrl(dataPath, assets, modelRegistry, modelKey)
  const resolveBackground = (backgroundKey: string): ResolvedAsset<BackgroundAsset> =>
    resolveBackgroundUrl(projectPath, assets, backgroundKey)
  const resolveVoice = (voiceKey: string): ResolvedAsset<VoiceAsset> =>
    resolveVoiceUrl(projectPath, assets, voiceKey)
  const clock = new StoryPlaybackClock(app)
  const scene = createStoryScene({
    app,
    clock,
    models: modelMap,
    resolveBackgroundUrl: resolveBackground,
    resolveVoiceUrl: resolveVoice,
    visualEffects,
    fontFamily
  })

  return {
    app,
    clock,
    dataPath,
    projectPath,
    assets,
    modelRegistry,
    models: modelMap,
    scene,
    pixi: scene.pixi,
    resolveModelUrl: resolveModel,
    resolveBackgroundUrl: resolveBackground,
    resolveVoiceUrl: resolveVoice
  }
}

export function resolveModelUrl(
  dataPath: string,
  assets: ProjectAssets,
  modelRegistry: ModelRegistry,
  modelKey: string
): ResolvedAsset<ModelAsset> {
  const asset = assets.models[modelKey]
  if (!asset) {
    throw new Error(`模型资源不存在: ${modelKey}`)
  }

  const registryEntry = modelRegistry.models[asset.modelId]
  if (!registryEntry) {
    throw new Error(`模型未注册: ${asset.modelId}`)
  }

  return {
    key: modelKey,
    asset,
    url: localAssetUrl(dataPath, `models/${asset.modelId}/${registryEntry.entry}`)
  }
}

export function resolveBackgroundUrl(
  projectPath: string,
  assets: ProjectAssets,
  backgroundKey: string
): ResolvedAsset<BackgroundAsset> {
  const asset = assets.backgrounds[backgroundKey]
  if (!asset) {
    throw new Error(`背景资源不存在: ${backgroundKey}`)
  }

  return {
    key: backgroundKey,
    asset,
    url: projectAssetUrl(projectPath, asset.path)
  }
}

export function resolveVoiceUrl(
  projectPath: string,
  assets: ProjectAssets,
  voiceKey: string
): ResolvedAsset<VoiceAsset> {
  const asset = assets.voices[voiceKey]
  if (!asset) {
    throw new Error(`语音资源不存在: ${voiceKey}`)
  }

  return {
    key: voiceKey,
    asset,
    url: projectAssetUrl(projectPath, asset.path)
  }
}

export function destroyStoryRuntime(runtime: StoryRuntime): void {
  runtime.clock.cancel()
  runtime.scene.destroy()
  for (const { model } of runtime.models.values()) {
    model.destroy({ children: true })
  }
  runtime.models.clear()
}
