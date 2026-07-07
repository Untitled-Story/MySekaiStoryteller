import type { Application, Container } from 'pixi.js'
import type { BackgroundAsset, ModelAsset, ProjectAssets, VoiceAsset } from '@/project/assets'
import type {
  CurveData,
  HexColorData,
  LayoutModeData,
  LeafSnippetData,
  MoveSpeedData,
  PositionData,
  SnippetData,
  StoryData
} from './schema'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { SekaiLive2DModel } from '@/lib/live2d'
import type { StoryVisualEffectRegistry } from './vfx'

export type { LeafSnippetData, SnippetData, StoryData } from './schema'

export type StoryModelInstance = {
  key: string
  asset: ModelAsset
  model: SekaiLive2DModel
}

export type ResolvedAsset<TAsset> = {
  key: string
  asset: TAsset
  url: string
}

export type StoryLayerName = 'background' | 'models' | 'effects' | 'ui' | 'overlay'

export type StoryLayers = Record<StoryLayerName, Container>

export type StoryCreateLayerOptions = {
  zIndex?: number
}

export type StoryDisposeCallback = () => void

export type StoryPixiAccessApi = {
  readonly app: Application
  readonly layers: StoryLayers
  readonly visualEffects: StoryVisualEffectRegistry
  createLayer(id: string, options?: StoryCreateLayerOptions): Container
  getLayer(id: string): Container | null
  removeLayer(id: string): void
  onDispose(dispose: StoryDisposeCallback): () => void
}

export type StoryModelAppearOptions = {
  modelKey: string
  from: PositionData
  to: PositionData
  moveSpeed: MoveSpeedData
  motion?: string
  facial?: string
  hologram: boolean
}

export type StoryModelClearOptions = {
  modelKey: string
  from: PositionData
  to: PositionData
  moveSpeed: MoveSpeedData
}

export type StoryModelMoveOptions = {
  modelKey: string
  from: PositionData
  to: PositionData
  moveSpeed: MoveSpeedData
}

export type StoryMotionOptions = {
  modelKey: string
  motion?: string
  facial?: string
}

export type StoryModelParameterAnimation = {
  paramId: string
  start: number
  end: number
  curve: CurveData
  duration: number
}

export type StoryModelParameterOptions = {
  modelKey: string
  params: StoryModelParameterAnimation[]
}

export type StoryDialogueOptions = {
  speaker: string
  content: string
  modelKey?: string
  voiceKey?: string
}

export type StoryTelopOptions = {
  content: string
}

export type StoryFadeOutOptions = {
  color: HexColorData
  duration: number
}

export type StoryFadeInOptions = {
  duration: number
}

export type StorySceneApi = {
  readonly layers: StoryLayers
  readonly pixi: StoryPixiAccessApi
  setLayoutMode(mode: LayoutModeData): Promise<void>
  setBackground(backgroundKey: string): Promise<void>
  showModel(options: StoryModelAppearOptions): Promise<void>
  clearModel(options: StoryModelClearOptions): Promise<void>
  moveModel(options: StoryModelMoveOptions): Promise<void>
  playMotion(options: StoryMotionOptions): Promise<void>
  setModelParameters(options: StoryModelParameterOptions): Promise<void>
  showDialogue(options: StoryDialogueOptions): Promise<void>
  hideDialogue(): Promise<void>
  showTelop(options: StoryTelopOptions): Promise<void>
  fadeOut(options: StoryFadeOutOptions): Promise<void>
  fadeIn(options: StoryFadeInOptions): Promise<void>
  destroy(): void
}

export type StoryRuntime = {
  app: Application
  dataPath: string
  projectPath: string
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  models: Map<string, StoryModelInstance>
  scene: StorySceneApi
  pixi: StoryPixiAccessApi
  resolveModelUrl(modelKey: string): ResolvedAsset<ModelAsset>
  resolveBackgroundUrl(backgroundKey: string): ResolvedAsset<BackgroundAsset>
  resolveVoiceUrl(voiceKey: string): ResolvedAsset<VoiceAsset>
}

export type StoryDispatcherStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'

export type StoryDispatcherEvent =
  | { type: 'story:start'; story: StoryData }
  | { type: 'story:complete'; story: StoryData }
  | { type: 'story:cancel'; story: StoryData }
  | { type: 'story:error'; story: StoryData; error: unknown }
  | { type: 'snippet:start'; snippet: SnippetData; path: readonly number[] }
  | { type: 'snippet:complete'; snippet: SnippetData; path: readonly number[] }
  | { type: 'snippet:error'; snippet: SnippetData; path: readonly number[]; error: unknown }

export type StoryDispatcherOptions = {
  signal?: AbortSignal
  onEvent?: (event: StoryDispatcherEvent) => void
}

export type SnippetContext<TSnippet extends LeafSnippetData = LeafSnippetData> = {
  snippet: TSnippet
  runtime: StoryRuntime
  signal: AbortSignal
  path: readonly number[]
}

export interface Snippet {
  run(): Promise<void>
}

export type SnippetConstructor<TSnippet extends LeafSnippetData = LeafSnippetData> = new (
  context: SnippetContext<TSnippet>
) => Snippet

export type SnippetByType<TType extends LeafSnippetData['type']> = Extract<
  LeafSnippetData,
  { type: TType }
>

export type SnippetRegistry = {
  [TType in LeafSnippetData['type']]: SnippetConstructor<SnippetByType<TType>>
}

export class StoryAbortError extends Error {
  constructor(message = 'Story playback cancelled') {
    super(message)
    this.name = 'StoryAbortError'
  }
}

export class StorySnippetError extends Error {
  readonly snippet: SnippetData
  readonly path: readonly number[]
  readonly cause: unknown

  constructor(snippet: SnippetData, path: readonly number[], cause: unknown) {
    super(`Snippet failed at ${formatSnippetPath(path)}: ${snippet.type}`)
    this.name = 'StorySnippetError'
    this.snippet = snippet
    this.path = path
    this.cause = cause
  }
}

export function formatSnippetPath(path: readonly number[]): string {
  return path.length > 0 ? path.join('.') : '<root>'
}
