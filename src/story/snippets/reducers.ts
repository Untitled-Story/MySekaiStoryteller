import type { SnippetData } from '../schema'
import type { StoryModelParameterAnimation } from '../types'
import type {
  StoryModelLastFrameState,
  StoryModelSceneState,
  StorySceneState,
  StorySnippetReduceContext,
  StorySnippetReducer
} from '../state'
import { createInitialStoryModelSceneState } from '../state'

export const reduceChangeLayoutMode: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState =>
  snippet.type === 'ChangeLayoutMode' ? { ...state, layoutMode: snippet.data.mode } : state

export const reduceChangeBackgroundImage: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState =>
  snippet.type === 'ChangeBackgroundImage'
    ? { ...state, backgroundKey: snippet.data.background }
    : state

export const reduceParallel: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData,
  context: StorySnippetReduceContext
): StorySceneState => {
  if (snippet.type !== 'Parallel') return state

  // Source-order conflict resolution matches the previous fast-forward behavior while
  // keeping the reducer deterministic for branches that write the same scene property.
  return snippet.snippets.reduce(
    (current: StorySceneState, child: SnippetData): StorySceneState =>
      context.reduceSnippet(current, child),
    state
  )
}

export const reduceLayoutAppear: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'LayoutAppear') return state

  const { model, position, motion, facial, hologram } = snippet.data
  return updateModel(
    state,
    model,
    (current: StoryModelSceneState): StoryModelSceneState => ({
      ...current,
      visible: true,
      position: { ...position },
      hologram,
      lastFrame: reduceLastFrame(current.lastFrame, motion, facial),
      parameters: motion || facial ? {} : current.parameters
    })
  )
}

export const reduceLayoutClear: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'LayoutClear') return state

  return updateModel(
    state,
    snippet.data.model,
    (current: StoryModelSceneState): StoryModelSceneState => ({
      ...current,
      visible: false,
      hologram: false
    })
  )
}

export const reduceTalk: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState =>
  snippet.type === 'Talk'
    ? {
        ...state,
        dialogue: {
          speaker: snippet.data.speaker,
          content: snippet.data.content,
          modelKey: snippet.data.model ?? null
        }
      }
    : state

export const reduceHideTalk: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => (snippet.type === 'HideTalk' ? { ...state, dialogue: null } : state)

export const reduceMove: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'Move') return state

  return updateModel(
    state,
    snippet.data.model,
    (current: StoryModelSceneState): StoryModelSceneState => ({
      ...current,
      position: { ...snippet.data.to }
    })
  )
}

export const reduceMotion: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'Motion') return state

  const { model, motion, facial } = snippet.data
  return updateModel(
    state,
    model,
    (current: StoryModelSceneState): StoryModelSceneState => ({
      ...current,
      visible: true,
      lastFrame: reduceLastFrame(current.lastFrame, motion, facial),
      parameters: motion || facial ? {} : current.parameters
    })
  )
}

// Telop is fully hidden when the snippet completes, so it has no durable scene state.
export const reduceTelop: StorySnippetReducer = (state: StorySceneState): StorySceneState => state

export const reduceDoParam: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'DoParam') return state

  return updateModel(
    state,
    snippet.data.model,
    (current: StoryModelSceneState): StoryModelSceneState => ({
      ...current,
      parameters: Object.fromEntries([
        ...Object.entries(current.parameters),
        ...snippet.data.params.map((parameter: StoryModelParameterAnimation): [string, number] => [
          parameter.paramId,
          parameter.end
        ])
      ])
    })
  )
}

export const reduceScreenFadeOut: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState =>
  snippet.type === 'ScreenFadeOut' ? { ...state, fade: { color: snippet.data.color } } : state

export const reduceScreenFadeIn: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => (snippet.type === 'ScreenFadeIn' ? { ...state, fade: null } : state)

export const reduceApplyEffect: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState =>
  snippet.type === 'ApplyEffect'
    ? {
        ...state,
        effects: {
          ...state.effects,
          [snippet.data.effectId]: {
            target: { ...snippet.data.target },
            effect: { ...snippet.data.effect }
          }
        }
      }
    : state

export const reduceRemoveEffect: StorySnippetReducer = (
  state: StorySceneState,
  snippet: SnippetData
): StorySceneState => {
  if (snippet.type !== 'RemoveEffect' || !(snippet.data.effectId in state.effects)) return state

  const effects: StorySceneState['effects'] = { ...state.effects }
  delete effects[snippet.data.effectId]
  return { ...state, effects }
}

function updateModel(
  state: StorySceneState,
  modelKey: string,
  update: (current: StoryModelSceneState) => StoryModelSceneState
): StorySceneState {
  const current: StoryModelSceneState =
    state.models[modelKey] ?? createInitialStoryModelSceneState()
  return {
    ...state,
    models: {
      ...state.models,
      [modelKey]: update(current)
    }
  }
}

function reduceLastFrame(
  current: StoryModelLastFrameState,
  motion: string | undefined,
  facial: string | undefined
): StoryModelLastFrameState {
  if (!motion && !facial) return current
  return {
    motion: motion ?? current.motion,
    facial: facial ?? current.facial
  }
}
