import { AlphaFilter, Assets, Container, Graphics, Sprite, Text } from 'pixi.js'
import type { Application, Filter, Texture } from 'pixi.js'
import type { BackgroundAsset, VoiceAsset } from '@/project/assets'
import type {
  ResolvedAsset,
  StoryDialogueOptions,
  StoryCreateLayerOptions,
  StoryApplyEffectOptions,
  StoryDisposeCallback,
  StoryFadeInOptions,
  StoryFadeOutOptions,
  StoryLayerName,
  StoryLayers,
  StoryModelAppearOptions,
  StoryModelClearOptions,
  StoryModelInstance,
  StoryModelMoveOptions,
  StoryModelParameterAnimation,
  StoryModelParameterOptions,
  StoryMotionOptions,
  StoryPixiAccessApi,
  StoryRemoveEffectOptions,
  StorySceneApi,
  StoryTelopOptions
} from './types'
import {
  Curves,
  type EffectTargetData,
  LayoutModes,
  MoveSpeed,
  Sides,
  type CurveData,
  type LayoutModeData,
  type PositionData
} from './schema'
import type { SekaiLive2DModel } from '@/lib/live2d'
import type { StoryPlaybackClock } from './playbackClock'
import { trackStoryAsync } from './storyAsyncGate'
import {
  createBuiltinVisualEffectRegistry,
  StoryVisualEffectManager,
  type StoryVisualEffectRegistry,
  type StoryVisualEffectTarget
} from './vfx'
import { DEFAULT_PLAYBACK_FONT_FAMILY } from '@/settings/fonts'
import uiTelopUrl from '@/story/assets/ui/ui_telop.svg?url'
import uiTextBackgroundUrl from '@/story/assets/ui/ui_text_background.svg?url'
import uiTextUnderlineUrl from '@/story/assets/ui/ui_text_underline.svg?url'

export type CreateStorySceneOptions = {
  app: Application
  clock: StoryPlaybackClock
  models: Map<string, StoryModelInstance>
  resolveBackgroundUrl(backgroundKey: string): ResolvedAsset<BackgroundAsset>
  resolveVoiceUrl(voiceKey: string): ResolvedAsset<VoiceAsset>
  visualEffects?: StoryVisualEffectRegistry
  fontFamily?: string
}

const LAYER_Z_INDEX: Record<StoryLayerName, number> = {
  background: 0,
  models: 10,
  effects: 20,
  ui: 30,
  overlay: 40
}

const MODEL_SHOW_TIME_MS: number = 200
const MODEL_HIDE_TIME_MS: number = 50
const MOTION_START_DELAY_MS: number = 10
const MOTION_PRIORITY_FORCE: number = 3
const DIALOGUE_SHOW_TIME_MS: number = 200
const DIALOGUE_HIDE_TIME_MS: number = 200
const DIALOGUE_CHAR_TIME_MS: number = 70
const TELOP_SHOW_TIME_MS: number = 200
const TELOP_HOLD_TIME_MS: number = 2000
const TELOP_HIDE_TIME_MS: number = 200
const VOICE_VOLUME: number = 0.5
const LAYOUT_HOLOGRAM_EFFECT_PREFIX: string = '__layout-hologram:'
const MOTION_IGNORE_EYE_PARAMS = [
  'ParamEyeROpen',
  'ParamEyeLOpen',
  'ParamEyeballX',
  'ParamEyeballY'
] as const
const MOTION_IGNORE_FACE_PARAMS = [
  ...MOTION_IGNORE_EYE_PARAMS,
  'ParamBrowRX',
  'ParamBrowRY',
  'ParamBrowRAngle',
  'ParamBrowRForm',
  'ParamBrowLX',
  'ParamBrowLY',
  'ParamBrowLAngle',
  'ParamBrowLForm',
  'ParamEyeRSmile',
  'ParamEyeRForm',
  'ParamEyeLSmile',
  'ParamEyeLForm',
  'ParamEyeSize',
  'ParamEyeTeary',
  'ParamTear',
  'ParamMouthForm',
  'ParamMouthOpenY',
  'ParamMouthForm2',
  'ParamTeeth',
  'ParamMouthScaleX',
  'ParamMouthScaleY',
  'ParamMouthPositionY',
  'ParamCheek',
  'ParamFaceShadow',
  'ParamSweatOn',
  'ParamSweatMove',
  'ParamCheekAngry'
] as const

type PositionRel = {
  x: number
  y: number
}

type DialogueUiState = {
  root: Container
  layoutWidth: number
  layoutHeight: number
  textBackgroundSprite: Sprite
  textUnderlineSprite: Sprite
  textSprite: Text
  textSpeakerSprite: Text
  telopContainer: Container
  telopText: Text
  talkShown: boolean
  content: string
}

type ParallelMotionManagerLike = {
  startMotion(
    group: string,
    index: number,
    priority?: number,
    options?: {
      ignoreParamIds?: readonly string[]
      loop?: boolean
    }
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

type Live2DEyeBlinkLike = {
  setEyeParams?: (value: number) => void
}

type Live2DInternalModelLike = {
  readonly width: number
  readonly height: number
  readonly originalHeight: number
  readonly parallelMotionManager?: ParallelMotionManagerLike[]
  readonly coreModel?: Live2DCoreModelLike
  readonly settings?: Live2DSettingsLike
  readonly eyeBlink?: Live2DEyeBlinkLike
  extendParallelMotionManager?(managerCount: number): void
}

type SpeakableSekaiLive2DModel = SekaiLive2DModel & {
  speak(
    sound: string,
    options?: {
      volume?: number
      onFinish?: () => void
      onError?: (error: Error) => void
    }
  ): Promise<boolean>
}

export function createStoryScene({
  app,
  clock,
  models,
  resolveBackgroundUrl,
  resolveVoiceUrl,
  visualEffects = createBuiltinVisualEffectRegistry(),
  fontFamily = DEFAULT_PLAYBACK_FONT_FAMILY
}: CreateStorySceneOptions): StorySceneApi {
  app.stage.sortableChildren = true

  const layers: StoryLayers = {
    background: createSceneLayer('background'),
    models: createSceneLayer('models'),
    effects: createSceneLayer('effects'),
    ui: createSceneLayer('ui'),
    overlay: createSceneLayer('overlay')
  }
  const presentationRoot = new Container()
  const stageRoot = new Container()
  presentationRoot.sortableChildren = true
  stageRoot.sortableChildren = true
  stageRoot.addChild(layers.background, layers.models, layers.effects)
  presentationRoot.addChild(stageRoot, layers.ui)
  app.stage.addChild(presentationRoot, layers.overlay)
  const customLayers = new Map<string, Container>()
  const disposers = new Set<StoryDisposeCallback>()
  let backgroundSprite: Sprite | null = null
  let dialogueUiPromise: Promise<DialogueUiState> | null = null
  let dialogueUi: DialogueUiState | null = null
  let fadeOverlay: Graphics | null = null
  let fadeColor: string | null = null
  let destroyed = false
  let fastForwarding = false
  let layoutMode: LayoutModeData = LayoutModes.Normal
  const positionedModelKeys = new Set<string>()
  let previousStageSize: [number, number] = getStageSize(app)
  const animateLinear = (animation: (progress: number) => void, timeMs: number): Promise<void> => {
    if (fastForwarding) {
      animation(1)
      return Promise.resolve()
    }
    return clock.animate(animation, timeMs)
  }
  const delayMs = (timeMs: number): Promise<void> =>
    fastForwarding ? Promise.resolve() : clock.delay(timeMs)
  const waitUntil = (whenFinish: (deltaMs?: number) => boolean): Promise<void> =>
    clock.waitUntil(whenFinish)

  const resizeObserver = new ResizeObserver((): void => {
    relayoutScene()
  })
  resizeObserver.observe(app.canvas)

  const pixi: StoryPixiAccessApi = {
    app,
    layers,
    visualEffects,
    createLayer,
    getLayer,
    removeLayer,
    onDispose
  }
  const visualEffectManager = new StoryVisualEffectManager({
    pixi,
    registry: visualEffects,
    resolveTarget: resolveEffectTarget,
    animateLinear
  })

  return {
    layers,
    pixi,
    get fastForwarding(): boolean {
      return fastForwarding
    },
    setFastForwarding(enabled: boolean): void {
      fastForwarding = enabled
    },
    async setLayoutMode(mode: LayoutModeData): Promise<void> {
      layoutMode = mode
    },
    async setBackground(backgroundKey: string): Promise<void> {
      const resolved: ResolvedAsset<BackgroundAsset> = resolveBackgroundUrl(backgroundKey)
      const texture: Texture = await trackStoryAsync(Assets.load<Texture>(resolved.url))

      if (!backgroundSprite) {
        backgroundSprite = new Sprite({ texture })
        backgroundSprite.anchor.set(0.5)
        layers.background.addChild(backgroundSprite)
      }

      backgroundSprite.texture = texture
      layoutBackgroundSprite(backgroundSprite, texture, app)
    },
    async showModel(options: StoryModelAppearOptions): Promise<void> {
      const { model } = attachModel(options.modelKey)
      setModelPositionRel(model, getStageSize(app), sideToPosition(options.position, layoutMode))
      positionedModelKeys.add(options.modelKey)
      await setLayoutHologram(options.modelKey, options.hologram)

      if (fastForwarding) {
        await applyModelLastFrame(model, options.motion, options.facial)
        ensureAlphaFilter(model).alpha = 1
        return
      }

      await playModelLastFrame(model, waitUntil, options.motion, options.facial)

      const showTask = showModelWithFade(model, MODEL_SHOW_TIME_MS, animateLinear)
      if (options.motion) {
        await closeModelEyes(model, 0, animateLinear)
      }

      void delayMs(MOTION_START_DELAY_MS)
        .then((): void => {
          void applyAndWaitModelMotion(
            model,
            waitUntil,
            options.motion,
            options.facial,
            true
          ).catch((): void => undefined)
        })
        .catch((): void => undefined)

      await showTask
    },
    async clearModel(options: StoryModelClearOptions): Promise<void> {
      const { model } = getModel(options.modelKey)
      if (fastForwarding) {
        ensureAlphaFilter(model).alpha = 0
        await setLayoutHologram(options.modelKey, false)
        model.visible = false
        model.removeFromParent()
        return
      }
      await hideModelWithFade(model, MODEL_HIDE_TIME_MS, animateLinear)
      await setLayoutHologram(options.modelKey, false)
      model.visible = false
      model.removeFromParent()
    },
    async moveModel(options: StoryModelMoveOptions): Promise<void> {
      const { model } = getModel(options.modelKey)
      const from: PositionRel = sideToPosition(options.from, layoutMode)
      const to: PositionRel = sideToPosition(options.to, layoutMode)
      positionedModelKeys.add(options.modelKey)
      if (fastForwarding) {
        setModelPositionRel(model, getStageSize(app), to)
        return
      }
      const moveTask: Promise<void> | null =
        (from.x === to.x && from.y === to.y) || options.moveSpeed === MoveSpeed.Immediate
          ? null
          : moveModelBetween(
              model,
              getStageSize(app),
              from,
              to,
              moveSpeedToMs(options.moveSpeed),
              animateLinear
            )

      if (!moveTask) {
        setModelPositionRel(model, getStageSize(app), to)
        return
      }

      await moveTask
    },
    async playMotion(options: StoryMotionOptions): Promise<void> {
      const { model } = attachModel(options.modelKey)
      if (fastForwarding) {
        await applyModelLastFrame(model, options.motion, options.facial)
        return
      }
      await applyAndWaitModelMotion(model, waitUntil, options.motion, options.facial, true)
    },
    async setModelParameters(options: StoryModelParameterOptions): Promise<void> {
      const { model } = getModel(options.modelKey)
      if (fastForwarding) {
        for (const param of options.params) {
          setModelParameter(model, param.paramId, param.end)
        }
        return
      }
      const tasks: Promise<void>[] = options.params.map(
        (param: StoryModelParameterAnimation): Promise<void> =>
          animateModelParameter(model, param, animateLinear)
      )

      await Promise.all(tasks)
    },
    async showDialogue(options: StoryDialogueOptions): Promise<void> {
      const ui: DialogueUiState = await getDialogueUi()

      resetDialogueUi(ui)
      setDialogueUiData(ui, options.speaker, options.content)

      if (fastForwarding) {
        await showDialogueBackground(ui, animateLinear)
        ui.textSprite.text = ui.content
        return
      }

      if (!ui.talkShown) {
        await showDialogueBackground(ui, animateLinear)
      }

      const waits: Promise<unknown>[] = []
      const modelInstance: StoryModelInstance | null = options.modelKey
        ? getModel(options.modelKey)
        : null
      if (modelInstance && options.voiceKey) {
        const resolvedVoice: ResolvedAsset<VoiceAsset> = resolveVoiceUrl(options.voiceKey)
        // Voice is wall-clock audio. Never await/track it on the export manual clock or
        // warm-up freezes (frame index stops while waitForStoryExternalIdle spins).
        void speakModel(modelInstance.model, resolvedVoice.url).catch(() => undefined)
      }

      // Typewriter is clock-driven via animateLinear — do not wrap in trackStoryAsync.
      waits.push(startDisplayDialogueContent(ui, animateLinear))

      await Promise.all(waits)
    },
    async hideDialogue(): Promise<void> {
      const ui: DialogueUiState = await getDialogueUi()
      await hideDialogueBackground(ui, animateLinear)
    },
    async showTelop(options: StoryTelopOptions): Promise<void> {
      if (fastForwarding) return
      const ui: DialogueUiState = await getDialogueUi()
      ui.telopText.text = options.content
      await showTelop(ui, animateLinear)
      await delayMs(TELOP_HOLD_TIME_MS)
      await hideTelop(ui, animateLinear)
    },
    async fadeOut(options: StoryFadeOutOptions): Promise<void> {
      const overlay: Graphics = getFadeOverlay()

      fadeColor = options.color
      drawFadeOverlay(overlay, app, options.color)
      overlay.visible = true
      if (fastForwarding) {
        overlay.alpha = 1
        return
      }
      await animateLinear((progress: number): void => {
        overlay.alpha = progress
      }, secondsToMs(options.duration))
    },
    async fadeIn(options: StoryFadeInOptions): Promise<void> {
      if (!fadeOverlay) return

      const overlay: Graphics = fadeOverlay
      if (fastForwarding) {
        overlay.alpha = 0
        overlay.visible = false
        return
      }
      const startAlpha: number = overlay.alpha
      await animateLinear((progress: number): void => {
        overlay.alpha = startAlpha * (1 - progress)
      }, secondsToMs(options.duration))
      overlay.visible = false
    },
    async applyEffect(options: StoryApplyEffectOptions): Promise<void> {
      await visualEffectManager.apply({
        effectId: options.effectId,
        effectName: options.effect.type,
        target: options.target,
        config: options.effect,
        durationMs: secondsToMs(options.duration)
      })
    },
    async removeEffect(options: StoryRemoveEffectOptions): Promise<void> {
      await visualEffectManager.remove(options.effectId, secondsToMs(options.duration))
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
    stageRoot.addChild(layer)

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

  function getDialogueUi(): Promise<DialogueUiState> {
    dialogueUiPromise ??= trackStoryAsync(
      createDialogueUi(app, layers.ui, fontFamily).then(
        (createdUi: DialogueUiState): DialogueUiState => {
          dialogueUi = createdUi
          layoutDialogueUi(createdUi, app)
          return createdUi
        }
      )
    )
    return dialogueUiPromise
  }

  function getFadeOverlay(): Graphics {
    if (fadeOverlay) return fadeOverlay

    fadeOverlay = new Graphics()
    fadeOverlay.visible = false
    fadeOverlay.alpha = 0
    layers.overlay.addChild(fadeOverlay)

    return fadeOverlay
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
    if (!positionedModelKeys.has(modelKey)) {
      setModelPositionRel(
        model,
        getStageSize(app),
        sideToPosition({ side: Sides.Center, offset: 0 }, layoutMode)
      )
      positionedModelKeys.add(modelKey)
    }

    return instance
  }

  function prepareModel(instance: StoryModelInstance): void {
    const { model } = instance
    const internalModel: Live2DInternalModelLike = getInternalModel(model)
    internalModel.extendParallelMotionManager?.(2)

    layoutModel(instance)
    ensureAlphaFilter(model)
  }

  function layoutModel(instance: StoryModelInstance): void {
    const { asset, model } = instance
    const internalModel: Live2DInternalModelLike = getInternalModel(model)
    model.anchor.set(0.5, asset.anchor)
    model.scale.set(
      (app.screen.height / internalModel.originalHeight) *
        (layoutMode === LayoutModes.Normal ? asset.normalScale : asset.smallScale)
    )
  }

  function relayoutScene(): void {
    if (destroyed) return

    const [previousWidth, previousHeight]: [number, number] = previousStageSize
    const nextStageSize: [number, number] = getStageSize(app)
    const [nextWidth, nextHeight]: [number, number] = nextStageSize
    if (nextWidth <= 0 || nextHeight <= 0) return

    if (backgroundSprite) {
      layoutBackgroundSprite(backgroundSprite, backgroundSprite.texture, app)
    }

    for (const instance of models.values()) {
      const { model } = instance
      if (model.parent !== layers.models && !positionedModelKeys.has(instance.key)) continue

      const relativeX: number = previousWidth > 0 ? model.position.x / previousWidth : 0.5
      const relativeY: number = previousHeight > 0 ? model.position.y / previousHeight - 0.3 : 0.5
      layoutModel(instance)
      model.position.set(nextWidth * relativeX, nextHeight * (relativeY + 0.3))
    }

    if (dialogueUi) layoutDialogueUi(dialogueUi, app)
    if (fadeOverlay && fadeColor) drawFadeOverlay(fadeOverlay, app, fadeColor)

    previousStageSize = nextStageSize
  }

  function resolveEffectTarget(target: EffectTargetData): StoryVisualEffectTarget {
    if (target.type === 'Stage') return { type: 'Stage', container: stageRoot }
    if (target.type === 'Screen') return { type: 'Screen', container: presentationRoot }

    const model: StoryModelInstance = getModel(target.model)
    prepareModel(model)
    return { type: 'Model', container: model.model, model }
  }

  async function setLayoutHologram(modelKey: string, enabled: boolean): Promise<void> {
    const effectId: string = `${LAYOUT_HOLOGRAM_EFFECT_PREFIX}${modelKey}`
    if (!enabled) {
      await visualEffectManager.remove(effectId, 0)
      return
    }
    await visualEffectManager.apply({
      effectId,
      effectName: 'Hologram',
      target: { type: 'Model', model: modelKey },
      durationMs: 0
    })
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
    resizeObserver.disconnect()

    for (const dispose of disposers) {
      dispose()
    }
    disposers.clear()

    for (const id of [...customLayers.keys()]) {
      removeLayer(id)
    }

    visualEffectManager.destroy()

    for (const layer of Object.values(layers)) {
      layer.removeChildren()
      layer.removeFromParent()
      layer.destroy()
    }
    stageRoot.removeFromParent()
    stageRoot.destroy()
    presentationRoot.removeFromParent()
    presentationRoot.destroy()
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

function moveModelBetween(
  model: SekaiLive2DModel,
  stageSize: [number, number],
  from: PositionRel,
  to: PositionRel,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const absFrom: [number, number] = [stageSize[0] * from.x, stageSize[1] * (from.y + 0.3)]
  const absTo: [number, number] = [stageSize[0] * to.x, stageSize[1] * (to.y + 0.3)]

  return animateLinear((progress: number): void => {
    model.position.x = (absTo[0] - absFrom[0]) * progress + absFrom[0]
    model.position.y = (absTo[1] - absFrom[1]) * progress + absFrom[1]
  }, timeMs)
}

function showModelWithFade(
  model: SekaiLive2DModel,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const alphaFilter = ensureAlphaFilter(model)
  model.visible = true
  return animateLinear((progress: number): void => {
    alphaFilter.alpha = progress
  }, timeMs)
}

function hideModelWithFade(
  model: SekaiLive2DModel,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const alphaFilter: AlphaFilter = ensureAlphaFilter(model)
  return animateLinear((progress: number): void => {
    alphaFilter.alpha = 1 - progress
  }, timeMs)
}

function layoutBackgroundSprite(sprite: Sprite, texture: Texture, app: Application): void {
  sprite.x = app.screen.width / 2
  sprite.y = app.screen.height / 2
  sprite.scale.set(calcBackgroundScale(texture, app))
}

function calcBackgroundScale(texture: Texture, app: Application): number {
  if (texture.width / texture.height > app.screen.width / app.screen.height) {
    return app.screen.height / texture.height
  }

  return app.screen.width / texture.width
}

async function createDialogueUi(
  app: Application,
  layer: Container,
  fontFamily: string
): Promise<DialogueUiState> {
  const [textBackgroundTexture, textUnderlineTexture, telopTexture]: [Texture, Texture, Texture] =
    await trackStoryAsync(Promise.all([Assets.load<Texture>(uiTextBackgroundUrl), Assets.load<Texture>(uiTextUnderlineUrl), Assets.load<Texture>(uiTelopUrl)]))
  const screenWidth: number = app.screen.width
  const screenHeight: number = app.screen.height
  const root: Container = new Container()
  const textBackgroundSprite: Sprite = createTextBackgroundSprite(
    textBackgroundTexture,
    screenWidth,
    screenHeight
  )
  const textUnderlineSprite: Sprite = createTextUnderlineSprite(
    textUnderlineTexture,
    screenWidth,
    screenHeight
  )
  const textSprite: Text = createDialogueText(screenWidth, screenHeight, fontFamily)
  const textSpeakerSprite: Text = createSpeakerText(
    screenWidth,
    screenHeight,
    textUnderlineSprite.y - screenWidth / 42,
    fontFamily
  )
  const { container: telopContainer, text: telopText }: { container: Container; text: Text } =
    createTelopContainer(telopTexture, screenWidth, screenHeight, fontFamily)

  root.addChild(
    textBackgroundSprite,
    textUnderlineSprite,
    textSprite,
    textSpeakerSprite,
    telopContainer
  )
  layer.addChild(root)

  return {
    root,
    layoutWidth: screenWidth,
    layoutHeight: screenHeight,
    textBackgroundSprite,
    textUnderlineSprite,
    textSprite,
    textSpeakerSprite,
    telopContainer,
    telopText,
    talkShown: false,
    content: ''
  }
}

function layoutDialogueUi(ui: DialogueUiState, app: Application): void {
  const scaleX: number = app.screen.width / ui.layoutWidth
  const scaleY: number = app.screen.height / ui.layoutHeight
  ui.root.scale.set(scaleX, scaleY)
}

function createTextBackgroundSprite(
  texture: Texture,
  screenWidth: number,
  screenHeight: number
): Sprite {
  const sprite: Sprite = new Sprite({ texture })
  sprite.anchor.set(0.5)
  sprite.width = screenWidth
  sprite.height = screenHeight
  sprite.x = screenWidth / 2
  sprite.y = screenHeight / 2
  sprite.visible = false
  ensureDisplayAlphaFilter(sprite)
  return sprite
}

function createTextUnderlineSprite(
  texture: Texture,
  screenWidth: number,
  screenHeight: number
): Sprite {
  const sprite: Sprite = new Sprite({ texture })
  const scale: number = screenWidth / 2 / texture.width
  sprite.scale.set(scale)
  sprite.x = screenWidth / 10
  sprite.y = screenHeight / 1.3
  sprite.visible = false
  ensureDisplayAlphaFilter(sprite)
  return sprite
}

function createDialogueText(screenWidth: number, screenHeight: number, fontFamily: string): Text {
  const x: number = screenWidth / 8
  const text: Text = new Text({
    text: '',
    style: {
      align: 'left',
      fill: '#FFFFFFDC',
      fontFamily,
      fontSize: screenHeight / 26,
      lineHeight: screenHeight / 19,
      stroke: { color: '#4A49688D', width: screenHeight / 120, join: 'round' },
      wordWrap: true,
      wordWrapWidth: screenWidth - x * 2
    }
  })
  text.x = x
  text.y = screenHeight / 1.27
  text.visible = false
  ensureDisplayAlphaFilter(text)
  return text
}

function createSpeakerText(
  screenWidth: number,
  screenHeight: number,
  y: number,
  fontFamily: string
): Text {
  const text: Text = new Text({
    text: '',
    style: {
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily,
      fontSize: screenHeight / 25,
      stroke: { color: '#4A49688D', width: screenHeight / 120, join: 'round' }
    }
  })
  text.x = screenWidth / 9
  text.y = y
  text.visible = false
  ensureDisplayAlphaFilter(text)
  return text
}

function createTelopContainer(
  texture: Texture,
  screenWidth: number,
  screenHeight: number,
  fontFamily: string
): { container: Container; text: Text } {
  const container: Container = new Container()
  const telopSprite: Sprite = new Sprite({ texture })
  const telopText: Text = new Text({
    text: '',
    style: {
      align: 'center',
      fill: '#FFFFFF',
      fontFamily,
      fontSize: screenHeight / 23
    }
  })

  telopSprite.anchor.set(0.5)
  telopSprite.x = screenWidth / 2
  telopSprite.y = screenHeight / 2
  telopSprite.scale.x = screenWidth / 1920
  telopSprite.height = screenHeight / 8

  telopText.anchor.set(0.5)
  telopText.x = screenWidth / 2 - 10
  telopText.y = screenHeight / 2 + screenHeight / 300

  container.visible = false
  ensureDisplayAlphaFilter(container)
  container.addChild(telopSprite, telopText)

  return { container, text: telopText }
}

function resetDialogueUi(ui: DialogueUiState): void {
  ui.textSpeakerSprite.text = ''
  ui.textSprite.text = ''
  ui.content = ''
}

function setDialogueUiData(ui: DialogueUiState, speaker: string, content: string): void {
  ui.textSpeakerSprite.text = speaker
  ui.content = content
}

function showDialogueBackground(
  ui: DialogueUiState,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  ui.talkShown = true
  return Promise.all([
    showDisplayObject(ui.textBackgroundSprite, DIALOGUE_SHOW_TIME_MS, animateLinear),
    showDisplayObject(ui.textUnderlineSprite, DIALOGUE_SHOW_TIME_MS, animateLinear),
    showDisplayObject(ui.textSprite, DIALOGUE_SHOW_TIME_MS, animateLinear),
    showDisplayObject(ui.textSpeakerSprite, DIALOGUE_SHOW_TIME_MS, animateLinear)
  ]).then((): void => undefined)
}

function hideDialogueBackground(
  ui: DialogueUiState,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  ui.talkShown = false
  return Promise.all([
    hideDisplayObject(ui.textBackgroundSprite, DIALOGUE_HIDE_TIME_MS, animateLinear),
    hideDisplayObject(ui.textUnderlineSprite, DIALOGUE_HIDE_TIME_MS, animateLinear),
    hideDisplayObject(ui.textSprite, DIALOGUE_HIDE_TIME_MS, animateLinear),
    hideDisplayObject(ui.textSpeakerSprite, DIALOGUE_HIDE_TIME_MS, animateLinear)
  ]).then((): void => undefined)
}

function startDisplayDialogueContent(
  ui: DialogueUiState,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const contentLength: number = ui.content.length
  const timeMs: number = contentLength * DIALOGUE_CHAR_TIME_MS

  return animateLinear((progress: number): void => {
    const charsToShow: number = Math.min(Math.floor(progress * contentLength), contentLength)
    ui.textSprite.text = ui.content.substring(0, charsToShow)
  }, timeMs)
}

function showTelop(
  ui: DialogueUiState,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const startX: number = ui.telopContainer.x - 10
  const originalX: number = ui.telopContainer.x
  const alphaFilter: AlphaFilter = ensureDisplayAlphaFilter(ui.telopContainer)

  ui.telopContainer.visible = true
  return animateLinear((progress: number): void => {
    alphaFilter.alpha = progress
    ui.telopContainer.x = startX + (originalX - startX) * progress
  }, TELOP_SHOW_TIME_MS)
}

function hideTelop(
  ui: DialogueUiState,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const startX: number = ui.telopContainer.x
  const originalX: number = ui.telopContainer.x + 10
  const alphaFilter: AlphaFilter = ensureDisplayAlphaFilter(ui.telopContainer)

  return animateLinear((progress: number): void => {
    alphaFilter.alpha = 1 - progress
    ui.telopContainer.x = startX + (originalX - startX) * progress
  }, TELOP_HIDE_TIME_MS).then((): void => {
    ui.telopContainer.visible = false
  })
}

function showDisplayObject(
  target: Sprite | Text,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const alphaFilter: AlphaFilter = ensureDisplayAlphaFilter(target)
  target.visible = true
  return animateLinear((progress: number): void => {
    alphaFilter.alpha = progress
  }, timeMs)
}

function hideDisplayObject(
  target: Sprite | Text,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const alphaFilter: AlphaFilter = ensureDisplayAlphaFilter(target)
  return animateLinear((progress: number): void => {
    alphaFilter.alpha = 1 - progress
  }, timeMs).then((): void => {
    target.visible = false
  })
}

async function playModelLastFrame(
  model: SekaiLive2DModel,
  waitUntil: (whenFinish: (deltaMs?: number) => boolean) => Promise<void>,
  motion?: string,
  facial?: string
): Promise<void> {
  const managers: [ParallelMotionManagerLike, ParallelMotionManagerLike] =
    getParallelMotionManagers(model)
  const waits: Promise<boolean>[] = []

  if (motion) {
    waits.push(managers[0].playMotionLastFrame(motion, 0))
  }
  if (facial) {
    waits.push(managers[1].playMotionLastFrame(facial, 0))
  }

  const results: boolean[] = await trackStoryAsync(Promise.all(waits))
  if (results.includes(false)) {
    await applyAndWaitModelMotion(model, waitUntil, motion, facial, true)
  } else if (waits.length > 0) {
    await waitForModelMotion(managers, waitUntil)
  }
}

async function applyModelLastFrame(
  model: SekaiLive2DModel,
  motion?: string,
  facial?: string
): Promise<void> {
  const managers: [ParallelMotionManagerLike, ParallelMotionManagerLike] =
    getParallelMotionManagers(model)
  const tasks: Promise<boolean>[] = []

  if (motion) tasks.push(managers[0].playMotionLastFrame(motion, 0))
  if (facial) tasks.push(managers[1].playMotionLastFrame(facial, 0))

  await trackStoryAsync(Promise.all(tasks))
}

async function applyAndWaitModelMotion(
  model: SekaiLive2DModel,
  waitUntil: (whenFinish: (deltaMs?: number) => boolean) => Promise<void>,
  motion?: string,
  facial?: string,
  ignoreMotionEyeParams = false
): Promise<void> {
  const managers: [ParallelMotionManagerLike, ParallelMotionManagerLike] =
    getParallelMotionManagers(model)
  const waits: Promise<boolean>[] = []

  if (motion) {
    waits.push(
      managers[0].startMotion(motion, 0, MOTION_PRIORITY_FORCE, {
        ignoreParamIds: resolveMotionIgnoreParamIds(facial, ignoreMotionEyeParams),
        loop: false
      })
    )
  }
  if (facial) {
    waits.push(managers[1].startMotion(facial, 0, MOTION_PRIORITY_FORCE, { loop: false }))
  }

  if (waits.length === 0) return

  // startMotion may do async resource work outside the playback clock — hold export clock.
  // Bound the hold so a stuck load cannot freeze multi-worker warm forever.
  const started: boolean[] = await trackStoryAsync(
    Promise.race([
      Promise.all(waits),
      new Promise<boolean[]>((resolve): void => {
        window.setTimeout((): void => {
          resolve(waits.map((): boolean => false))
        }, 5000)
      })
    ])
  )
  // Only wait when at least one manager actually started; false means skipped/failed start.
  if (started.some((ok: boolean): boolean => ok)) {
    await waitForModelMotion(managers, waitUntil)
  }
}

function resolveMotionIgnoreParamIds(
  facial: string | undefined,
  ignoreMotionEyeParams: boolean
): readonly string[] {
  if (facial) return MOTION_IGNORE_FACE_PARAMS
  if (ignoreMotionEyeParams) return MOTION_IGNORE_EYE_PARAMS
  return []
}

function closeModelEyes(
  model: SekaiLive2DModel,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  return animateLinear((progress: number): void => {
    setModelEyeOpen(model, 1 - progress)
  }, timeMs)
}

function setModelEyeOpen(model: SekaiLive2DModel, value: number): void {
  const internalModel: Live2DInternalModelLike = getInternalModel(model)
  const eyeBlink: Live2DEyeBlinkLike | undefined = internalModel.eyeBlink
  if (typeof eyeBlink?.setEyeParams === 'function') {
    eyeBlink.setEyeParams(value)
    return
  }

  const coreModel: Live2DCoreModelLike | undefined = internalModel.coreModel
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
  const count: number = internalModel.settings?.getEyeBlinkParameterCount?.() ?? 0
  const ids: unknown[] = []

  for (let index = 0; index < count; index++) {
    const id: unknown = internalModel.settings?.getEyeBlinkParameterId?.(index)
    if (id) {
      ids.push(id)
    }
  }

  return ids.length > 0 ? ids : ['ParamEyeLOpen', 'ParamEyeROpen']
}

function getInternalModel(model: SekaiLive2DModel): Live2DInternalModelLike {
  return model.internalModel as Live2DInternalModelLike
}

function getParallelMotionManagers(
  model: SekaiLive2DModel
): [ParallelMotionManagerLike, ParallelMotionManagerLike] {
  const internalModel: Live2DInternalModelLike = getInternalModel(model)
  internalModel.extendParallelMotionManager?.(2)

  const motionManager: ParallelMotionManagerLike | undefined =
    internalModel.parallelMotionManager?.[0]
  const facialManager: ParallelMotionManagerLike | undefined =
    internalModel.parallelMotionManager?.[1]
  if (!motionManager || !facialManager) {
    throw new Error('Live2D parallel motion manager 初始化失败')
  }

  return [motionManager, facialManager]
}

function isMotionManagerFinished(manager: ParallelMotionManagerLike): boolean {
  try {
    // After Live2D model.destroy(), queueManager is released and isFinished throws.
    return manager.isFinished()
  } catch {
    return true
  }
}

function areMotionManagersFinished(
  managers: [ParallelMotionManagerLike, ParallelMotionManagerLike]
): boolean {
  return isMotionManagerFinished(managers[0]) && isMotionManagerFinished(managers[1])
}

/**
 * Wait until motions finish without treating the pre-start "finished" snapshot as done.
 *
 * Export drives Live2D manually. Right after startMotion resolves, isFinished() can still
 * be true until the first model update — resolving immediately skips the whole motion.
 *
 * pollTasks() may invoke the predicate with 0ms delta; only count positive delta toward
 * arming / max-duration budgets so warm-up cannot freeze.
 */
function waitForModelMotion(
  managers: [ParallelMotionManagerLike, ParallelMotionManagerLike],
  waitUntil: (whenFinish: (deltaMs?: number) => boolean) => Promise<void>
): Promise<void> {
  let seenActive: boolean = false
  let armingMs: number = 0
  let activeMs: number = 0
  // If never becomes active after startMotion, give up quickly so warm continues.
  const maxArmingMs: number = 250
  // Safety: never wait more than ~8s for a single motion under export clock.
  const maxActiveMs: number = 8000

  return waitUntil((deltaMs: number = 0): boolean => {
    const finished: boolean = areMotionManagersFinished(managers)
    if (!finished) {
      seenActive = true
      activeMs += Math.max(0, deltaMs)
      // Pathological: motion never finishes.
      return activeMs >= maxActiveMs
    }
    if (seenActive) return true
    armingMs += Math.max(0, deltaMs)
    return armingMs >= maxArmingMs
  })
}

function ensureAlphaFilter(model: SekaiLive2DModel): AlphaFilter {
  const filters: Filter[] = model.filters ? [...model.filters] : []
  const existing: AlphaFilter | undefined = filters.find(
    (filter: Filter): filter is AlphaFilter => filter instanceof AlphaFilter
  )
  if (existing) return existing

  const alphaFilter: AlphaFilter = new AlphaFilter({ alpha: 0 })
  alphaFilter.resolution = 2
  model.filters = [alphaFilter, ...filters]

  return alphaFilter
}

function ensureDisplayAlphaFilter(target: Container | Sprite | Text): AlphaFilter {
  const currentFilters: readonly Filter[] | Filter | null | undefined = target.filters
  const filters: Filter[] = Array.isArray(currentFilters)
    ? [...currentFilters]
    : currentFilters
      ? [currentFilters]
      : []
  const existing: AlphaFilter | undefined = filters.find(
    (filter: Filter): filter is AlphaFilter => filter instanceof AlphaFilter
  )
  if (existing) return existing

  const alphaFilter: AlphaFilter = new AlphaFilter({ alpha: 0 })
  alphaFilter.resolution = 2
  target.filters = [alphaFilter, ...filters]

  return alphaFilter
}

function animateModelParameter(
  model: SekaiLive2DModel,
  param: StoryModelParameterAnimation,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  const runner: (animation: (progress: number) => void, timeMs: number) => Promise<void> =
    getCurveRunner(param.curve, animateLinear)

  return runner((progress: number): void => {
    const value: number = param.start + (param.end - param.start) * progress
    setModelParameter(model, param.paramId, value)
  }, secondsToMs(param.duration))
}

function getCurveRunner(
  curve: CurveData,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): (animation: (progress: number) => void, timeMs: number) => Promise<void> {
  if (curve === Curves.Sine) {
    return (animation: (progress: number) => void, timeMs: number): Promise<void> =>
      animateSine(animation, timeMs, animateLinear)
  }
  if (curve === Curves.Cosine) {
    return (animation: (progress: number) => void, timeMs: number): Promise<void> =>
      animateCosine(animation, timeMs, animateLinear)
  }
  return animateLinear
}

function setModelParameter(model: SekaiLive2DModel, paramId: string, value: number): void {
  const coreModel: Live2DCoreModelLike | undefined = getInternalModel(model).coreModel
  if (!coreModel) return

  if (coreModel.setParameterValueById) {
    coreModel.setParameterValueById(paramId, value)
    return
  }

  coreModel.setParamFloat?.(paramId, value)
}

function speakModel(model: SekaiLive2DModel, voiceUrl: string): Promise<void> {
  const speakableModel: SpeakableSekaiLive2DModel = model as SpeakableSekaiLive2DModel

  return new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
    // Export clock does not advance wall-audio; still must not hang forever if onFinish never fires.
    const timeoutId: number = window.setTimeout((): void => {
      resolve()
    }, 30_000)

    const finish = (): void => {
      window.clearTimeout(timeoutId)
      resolve()
    }
    const fail = (reason?: unknown): void => {
      window.clearTimeout(timeoutId)
      reject(reason)
    }

    void speakableModel
      .speak(voiceUrl, {
        volume: VOICE_VOLUME,
        onFinish: finish,
        onError: fail
      })
      .then((started: boolean): void => {
        if (!started) {
          finish()
        }
      })
      .catch(fail)
  })
}

function drawFadeOverlay(overlay: Graphics, app: Application, color: string): void {
  overlay.clear()
  overlay.rect(0, 0, app.screen.width, app.screen.height).fill({ color: hexColorToNumber(color) })
}

function hexColorToNumber(color: string): number {
  return Number.parseInt(color.slice(1), 16)
}

function secondsToMs(seconds: number): number {
  return seconds * 1000
}

function animateCosine(
  animation: (progress: number) => void,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  return animateLinear((progress: number): void => {
    const eased: number = (1 - Math.cos(progress * Math.PI)) / 2
    animation(eased)
  }, timeMs)
}

function animateSine(
  animation: (progress: number) => void,
  timeMs: number,
  animateLinear: (animation: (progress: number) => void, timeMs: number) => Promise<void>
): Promise<void> {
  return animateLinear((progress: number): void => {
    const eased: number = Math.sin((progress * Math.PI) / 2)
    animation(eased)
  }, timeMs)
}
