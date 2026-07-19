import { LayoutModes, Sides } from './schema'
import type {
  EffectTargetData,
  LayoutModeData,
  PositionData,
  SnippetData,
  VisualEffectData
} from './schema'

export type StoryModelLastFrameState = {
  motion: string | null
  facial: string | null
}

export type StoryModelSceneState = {
  visible: boolean
  position: PositionData
  hologram: boolean
  lastFrame: StoryModelLastFrameState
  parameters: Record<string, number>
}

export type StoryDialogueSceneState = {
  speaker: string
  content: string
  modelKey: string | null
}

export type StoryFadeSceneState = {
  color: string
}

export type StoryEffectSceneState = {
  target: EffectTargetData
  effect: VisualEffectData
}

export type StorySceneState = {
  layoutMode: LayoutModeData
  backgroundKey: string | null
  models: Record<string, StoryModelSceneState>
  dialogue: StoryDialogueSceneState | null
  fade: StoryFadeSceneState | null
  effects: Record<string, StoryEffectSceneState>
}

export type StorySnippetReduceContext = {
  reduceSnippet(state: StorySceneState, snippet: SnippetData): StorySceneState
}

export type StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData,
  context: StorySnippetReduceContext
) => StorySceneState

export function createInitialStorySceneState(): StorySceneState {
  return {
    layoutMode: LayoutModes.Normal,
    backgroundKey: null,
    models: {},
    dialogue: null,
    fade: null,
    effects: {}
  }
}

export function createInitialStoryModelSceneState(): StoryModelSceneState {
  return {
    visible: false,
    position: { side: Sides.Center, offset: 0 },
    hologram: false,
    lastFrame: { motion: null, facial: null },
    parameters: {}
  }
}
