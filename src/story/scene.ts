import { AlphaFilter, Container, Ticker } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { BackgroundAsset, VoiceAsset } from '@/project/assets'
import type {
  ResolvedAsset,
  StoryCreateLayerOptions,
  StoryDisposeCallback,
  StoryLayerName,
  StoryLayers,
  StoryModelInstance,
  StoryPixiAccessApi,
  StorySceneApi
} from './types'
import { LayoutModes, MoveSpeed, type LayoutModeData, type PositionData } from './schema'
import type { SekaiLive2DModel } from '@/lib/live2d'
import {
  createBuiltinVisualEffectRegistry,
  StoryVisualEffectManager,
  type StoryVisualEffectRegistry
} from './vfx'

export type CreateStorySceneOptions = {
  app: Application
  models: Map<string, StoryModelInstance>
  resolveBackgroundUrl(backgroundKey: string): ResolvedAsset<BackgroundAsset>
  resolveVoiceUrl(voiceKey: string): ResolvedAsset<VoiceAsset>
  visualEffects?: StoryVisualEffectRegistry
}

const LAYER_Z_INDEX: Record<StoryLayerName, number> = {
  background: 0,
  models: 10,
  effects: 20,
  ui: 30,
  overlay: 40
}

const MODEL_SHOW_TIME_MS = 200
const MOTION_START_DELAY_MS = 10
const MOTION_PRIORITY_FORCE = 3
const MOTION_IGNORE_EYE_PARAMS = [
  'ParamEyeROpen',
  'ParamEyeLOpen',
  'ParamEyeballX',
  'ParamEyeballY'
] as const

type PositionRel = {
  x: number
  y: number
}

type ParallelMotionManagerLike = {
  startMotion(
    group: string,
    index: number,
    priority?: number,
    ignoreParamIds?: readonly string[]
  ): Promise<boolean>
  playMotionLastFrame(group: string, index: number): Promise<boolean>
  isFinished(): boolean
}

type Live2DCoreModelLike = {
  setParamFloat?: (id: string, value: number, weight?: number) => unknown
  setParameterValueById?: (id: unknown, value: number, weight?: number) => unknown
}

type Live2DSettingsLike = {
  getEyeBlinkParameterCount?: () => number
  getEyeBlinkParameterId?: (index: number) => unknown
}

type Live2DInternalModelLike = {
  readonly width: number
  readonly height: number
  readonly originalHeight: number
  readonly parallelMotionManager?: ParallelMotionManagerLike[]
  readonly coreModel?: Live2DCoreModelLike
  readonly settings?: Live2DSettingsLike
  readonly eyeBlink?: {
    setEyeParams(value: number): void
  }
  extendParallelMotionManager?(managerCount: number): void
}

export function createStoryScene({
  app,
  models,
  resolveBackgroundUrl,
  resolveVoiceUrl,
  visualEffects = createBuiltinVisualEffectRegistry()
}: CreateStorySceneOptions): StorySceneApi {
  app.stage.sortableChildren = true

  const layers: StoryLayers = {
    background: createSceneLayer('background'),
    models: createSceneLayer('models'),
    effects: createSceneLayer('effects'),
    ui: createSceneLayer('ui'),
    overlay: createSceneLayer('overlay')
  }
  const customLayers = new Map<string, Container>()
  const visualEffectManagers = new Map<string, StoryVisualEffectManager>()
  const disposers = new Set<StoryDisposeCallback>()
  let destroyed = false
  let layoutMode: LayoutModeData = LayoutModes.Normal

  for (const layer of Object.values(layers)) {
    app.stage.addChild(layer)
  }

  const pixi: StoryPixiAccessApi = {
    app,
    layers,
    visualEffects,
    createLayer,
    getLayer,
    removeLayer,
    onDispose
  }

  return {
    layers,
    pixi,
    async setLayoutMode(mode) {
      layoutMode = mode
    },
    async setBackground(backgroundKey) {
      resolveBackgroundUrl(backgroundKey)
    },
    async showModel(options) {
      const { model } = attachModel(options.modelKey)

      await playModelLastFrame(model, options.motion, options.facial)

      if (options.hologram) {
        applyModelEffects(options.modelKey, ['hologram'])
      }
      const showTask = showModelWithFade(model, MODEL_SHOW_TIME_MS)
      if (options.motion) {
        await closeModelEyes(model, 0)
      }

      const from = sideToPosition(options.from, layoutMode)
      const to = sideToPosition(options.to, layoutMode)
      const moveTask =
        from.x === to.x && from.y === to.y
          ? null
          : moveModel(model, getStageSize(app), from, to, moveSpeedToMs(options.moveSpeed))

      if (!moveTask) {
        setModelPositionRel(model, getStageSize(app), to)
      }

      void delayMs(MOTION_START_DELAY_MS).then(() => {
        void applyAndWaitModelMotion(model, options.motion, options.facial, true)
      })

      await showTask
      if (moveTask) await moveTask
    },
    async clearModel(options) {
      const { model } = getModel(options.modelKey)
      disableAllModelEffects(options.modelKey)
      model.visible = false
      model.removeFromParent()
      void options.from
      void options.to
      void options.moveSpeed
    },
    async moveModel(options) {
      getModel(options.modelKey)
      void options.from
      void options.to
      void options.moveSpeed
    },
    async playMotion(options) {
      getModel(options.modelKey)
      void options.motion
      void options.facial
    },
    async setModelParameters(options) {
      getModel(options.modelKey)
      void options.params
    },
    async showDialogue(options) {
      if (options.modelKey) {
        getModel(options.modelKey)
      }
      if (options.voiceKey) {
        resolveVoiceUrl(options.voiceKey)
      }
      void options.speaker
      void options.content
    },
    async hideDialogue() {
      return Promise.resolve()
    },
    async showTelop(options) {
      void options.content
    },
    async fadeOut(options) {
      void options.color
      void options.duration
    },
    async fadeIn(options) {
      void options.duration
    },
    destroy
  }

  function createSceneLayer(name: StoryLayerName): Container {
    const layer = new Container()
    layer.sortableChildren = true
    layer.zIndex = LAYER_Z_INDEX[name]
    return layer
  }

  function createLayer(id: string, options: StoryCreateLayerOptions = {}): Container {
    const existing = customLayers.get(id)
    if (existing) return existing

    const layer = new Container()
    layer.sortableChildren = true
    layer.zIndex = resolveCustomLayerZIndex(options)
    customLayers.set(id, layer)
    app.stage.addChild(layer)

    return layer
  }

  function getLayer(id: string): Container | null {
    return customLayers.get(id) ?? null
  }

  function removeLayer(id: string): void {
    const layer = customLayers.get(id)
    if (!layer) return

    customLayers.delete(id)
    layer.removeFromParent()
    layer.destroy({ children: true })
  }

  function onDispose(dispose: StoryDisposeCallback): () => void {
    disposers.add(dispose)
    return () => {
      disposers.delete(dispose)
    }
  }

  function attachModel(modelKey: string): StoryModelInstance {
    const instance = getModel(modelKey)
    const { model } = instance

    prepareModel(instance)

    if (model.parent !== layers.models) {
      model.removeFromParent()
      layers.models.addChild(model)
    }
    model.visible = true

    return instance
  }

  function prepareModel(instance: StoryModelInstance): void {
    const { asset, model } = instance
    const internalModel = getInternalModel(model)
    internalModel.extendParallelMotionManager?.(2)

    model.anchor.set(0.5, asset.anchor)
    ensureAlphaFilter(model)
    getVisualEffectManager(instance)
    model.scale.set(
      (app.screen.height / internalModel.originalHeight) *
        (layoutMode === LayoutModes.Normal ? asset.normalScale : asset.smallScale)
    )
  }

  function getVisualEffectManager(instance: StoryModelInstance): StoryVisualEffectManager {
    const existing = visualEffectManagers.get(instance.key)
    if (existing) return existing

    const manager = new StoryVisualEffectManager({
      pixi,
      model: instance,
      registry: visualEffects,
      animateLinear
    })
    visualEffectManagers.set(instance.key, manager)
    return manager
  }

  function applyModelEffects(modelKey: string, effectNames: readonly string[]): void {
    const manager = getVisualEffectManager(getModel(modelKey))
    for (const effectName of effectNames) {
      manager.apply(effectName)
    }
  }

  function disableAllModelEffects(modelKey: string): void {
    visualEffectManagers.get(modelKey)?.disableAll()
  }

  function getModel(modelKey: string): StoryModelInstance {
    const model = models.get(modelKey)
    if (!model) {
      throw new Error(`模型未预加载: ${modelKey}`)
    }
    return model
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true

    for (const dispose of disposers) {
      dispose()
    }
    disposers.clear()

    for (const id of [...customLayers.keys()]) {
      removeLayer(id)
    }

    for (const manager of visualEffectManagers.values()) {
      manager.destroy()
    }
    visualEffectManagers.clear()

    for (const layer of Object.values(layers)) {
      layer.removeChildren()
      layer.removeFromParent()
      layer.destroy()
    }
  }
}

function resolveCustomLayerZIndex(options: StoryCreateLayerOptions): number {
  return typeof options.zIndex === 'number' ? options.zIndex : LAYER_Z_INDEX.effects
}

function sideToPosition(position: PositionData, layoutMode: LayoutModeData): PositionRel {
  const positionMap: Record<LayoutModeData, Record<PositionData['side'], [number, number]>> = {
    [LayoutModes.Normal]: {
      Center: [0.5, 0.5],
      Left: [0.3, 0.5],
      Right: [0.7, 0.5]
    },
    [LayoutModes.Three]: {
      Center: [0.5, 0.5],
      Left: [0.25, 0.5],
      Right: [0.75, 0.5]
    }
  }

  const [x, y] = positionMap[layoutMode][position.side]
  return {
    x: x + position.offset / 1920,
    y
  }
}

function moveSpeedToMs(moveSpeed: MoveSpeed): number {
  return {
    [MoveSpeed.Slow]: 700,
    [MoveSpeed.Normal]: 500,
    [MoveSpeed.Fast]: 300,
    [MoveSpeed.Immediate]: 0
  }[moveSpeed]
}

function getStageSize(app: Application): [number, number] {
  return [app.screen.width, app.screen.height]
}

function setModelPositionRel(
  model: SekaiLive2DModel,
  [stageWidth, stageHeight]: [number, number],
  position: PositionRel
): void {
  model.position.set(stageWidth * position.x, stageHeight * (position.y + 0.3))
}

function moveModel(
  model: SekaiLive2DModel,
  stageSize: [number, number],
  from: PositionRel,
  to: PositionRel,
  timeMs: number
): Promise<void> {
  const absFrom: [number, number] = [
    stageSize[0] * from.x,
    stageSize[1] * (from.y + 0.3)
  ]
  const absTo: [number, number] = [stageSize[0] * to.x, stageSize[1] * (to.y + 0.3)]

  return animateLinear((progress) => {
    model.position.x = (absTo[0] - absFrom[0]) * progress + absFrom[0]
    model.position.y = (absTo[1] - absFrom[1]) * progress + absFrom[1]
  }, timeMs)
}

function showModelWithFade(model: SekaiLive2DModel, timeMs: number): Promise<void> {
  const alphaFilter = ensureAlphaFilter(model)
  return animateLinear((progress) => {
    alphaFilter.alpha = progress
  }, timeMs)
}

async function playModelLastFrame(
  model: SekaiLive2DModel,
  motion?: string,
  facial?: string
): Promise<void> {
  const managers = getParallelMotionManagers(model)
  const waits: Promise<boolean>[] = []

  if (motion) {
    waits.push(managers[0].playMotionLastFrame(motion, 0))
  }
  if (facial) {
    waits.push(managers[1].playMotionLastFrame(facial, 0))
  }

  const results = await Promise.all(waits)
  if (results.includes(false)) {
    await applyAndWaitModelMotion(model, motion, facial, false)
  } else if (waits.length > 0) {
    await waitUntil(() => managers[0].isFinished() && managers[1].isFinished())
  }
}

async function applyAndWaitModelMotion(
  model: SekaiLive2DModel,
  motion?: string,
  facial?: string,
  ignoreMotionEyeParams = false
): Promise<void> {
  const managers = getParallelMotionManagers(model)
  const waits: Promise<boolean>[] = []

  if (motion) {
    waits.push(
      managers[0].startMotion(
        motion,
        0,
        MOTION_PRIORITY_FORCE,
        ignoreMotionEyeParams ? MOTION_IGNORE_EYE_PARAMS : []
      )
    )
  }
  if (facial) {
    waits.push(managers[1].startMotion(facial, 0, MOTION_PRIORITY_FORCE))
  }

  await Promise.all(waits)
  if (waits.length > 0) {
    await waitUntil(() => managers[0].isFinished() && managers[1].isFinished())
  }
}

function closeModelEyes(model: SekaiLive2DModel, timeMs: number): Promise<void> {
  return animateLinear((progress) => {
    setModelEyeOpen(model, 1 - progress)
  }, timeMs)
}

function setModelEyeOpen(model: SekaiLive2DModel, value: number): void {
  const internalModel = getInternalModel(model)
  if (internalModel.eyeBlink) {
    internalModel.eyeBlink.setEyeParams(value)
    return
  }

  const coreModel = internalModel.coreModel
  if (!coreModel) return

  if (coreModel.setParamFloat) {
    coreModel.setParamFloat('PARAM_EYE_L_OPEN', value)
    coreModel.setParamFloat('PARAM_EYE_R_OPEN', value)
    return
  }

  if (coreModel.setParameterValueById) {
    const ids = getEyeBlinkIds(internalModel)
    for (const id of ids) {
      coreModel.setParameterValueById(id, value)
    }
  }
}

function getEyeBlinkIds(internalModel: Live2DInternalModelLike): unknown[] {
  const count = internalModel.settings?.getEyeBlinkParameterCount?.() ?? 0
  const ids: unknown[] = []

  for (let index = 0; index < count; index++) {
    const id = internalModel.settings?.getEyeBlinkParameterId?.(index)
    if (id) {
      ids.push(id)
    }
  }

  return ids.length > 0 ? ids : ['ParamEyeLOpen', 'ParamEyeROpen']
}

function getInternalModel(model: SekaiLive2DModel): Live2DInternalModelLike {
  return model.internalModel as Live2DInternalModelLike
}

function getParallelMotionManagers(model: SekaiLive2DModel): [
  ParallelMotionManagerLike,
  ParallelMotionManagerLike
] {
  const internalModel = getInternalModel(model)
  internalModel.extendParallelMotionManager?.(2)

  const motionManager = internalModel.parallelMotionManager?.[0]
  const facialManager = internalModel.parallelMotionManager?.[1]
  if (!motionManager || !facialManager) {
    throw new Error('Live2D parallel motion manager 初始化失败')
  }

  return [motionManager, facialManager]
}

function ensureAlphaFilter(model: SekaiLive2DModel): AlphaFilter {
  const filters = model.filters ? [...model.filters] : []
  const existing = filters.find((filter): filter is AlphaFilter => filter instanceof AlphaFilter)
  if (existing) return existing

  const alphaFilter = new AlphaFilter({ alpha: 0 })
  alphaFilter.resolution = 2
  model.filters = [alphaFilter, ...filters]

  return alphaFilter
}

function animateLinear(animation: (progress: number) => void, timeMs: number): Promise<void> {
  let progress = 0
  animation(0)

  if (timeMs < 30) {
    animation(1)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const ticker = new Ticker()
    ticker.maxFPS = 60

    ticker.add(() => {
      const rawDeltaTime = ticker.elapsedMS
      let usedTime = rawDeltaTime

      if (usedTime > 100) {
        usedTime = 20
      }

      progress += usedTime / timeMs
      progress = Math.min(progress, 1)
      animation(progress)

      if (progress >= 1) {
        animation(1)
        ticker.destroy()
        resolve()
      }
    })
    ticker.start()
  })
}

function waitUntil(whenFinish: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const ticker = new Ticker()
    ticker.maxFPS = 60

    ticker.add(() => {
      if (whenFinish()) {
        ticker.destroy()
        resolve()
      }
    })
    ticker.start()
  })
}

function delayMs(timeMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, timeMs)
  })
}
