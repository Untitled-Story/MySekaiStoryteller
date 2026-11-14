import { MoveSpeed, type SnippetData, type StoryData } from '@/story/schema'

const MODEL_SHOW_TIME_MS: number = 200
const MODEL_HIDE_TIME_MS: number = 50
const DIALOGUE_SHOW_TIME_MS: number = 200
const DIALOGUE_HIDE_TIME_MS: number = 200
const DIALOGUE_CHAR_TIME_MS: number = 70
const TELOP_SHOW_TIME_MS: number = 200
const TELOP_HOLD_TIME_MS: number = 2000
const TELOP_HIDE_TIME_MS: number = 200
const DEFAULT_MOTION_ESTIMATE_MS: number = 600

export type EstimateContext = {
  voiceDurationsMs: ReadonlyMap<string, number>
}

export type EstimateState = {
  talkShown: boolean
}

function estimateMoveDurationMs(moveSpeed: MoveSpeed): number {
  const durations: Record<MoveSpeed, number> = {
    [MoveSpeed.Slow]: 700,
    [MoveSpeed.Normal]: 500,
    [MoveSpeed.Fast]: 300,
    [MoveSpeed.Immediate]: 0
  }
  return durations[moveSpeed]
}

function estimateSnippetDurationMs(
  snippet: SnippetData,
  context: EstimateContext,
  state: EstimateState
): number {
  const delayMs: number = Math.max(0, snippet.delay * 1000)

  if (snippet.type === 'Parallel') {
    let maxBranchMs: number = 0
    for (const child of snippet.snippets) {
      const childDurationMs: number = estimateSnippetDurationMs(child, context, state)
      if (childDurationMs > maxBranchMs) {
        maxBranchMs = childDurationMs
      }
    }
    return delayMs + maxBranchMs
  }

  switch (snippet.type) {
    case 'ChangeLayoutMode':
    case 'ChangeBackgroundImage':
      return delayMs
    case 'LayoutAppear':
      return delayMs + MODEL_SHOW_TIME_MS
    case 'LayoutClear':
      return delayMs + MODEL_HIDE_TIME_MS
    case 'Talk': {
      let openMs: number = 0
      if (!state.talkShown) {
        openMs = DIALOGUE_SHOW_TIME_MS
        state.talkShown = true
      }
      const textMs: number = snippet.data.content.length * DIALOGUE_CHAR_TIME_MS
      const voiceMs: number = snippet.data.voice
        ? (context.voiceDurationsMs.get(snippet.data.voice) ?? 0)
        : 0
      return delayMs + openMs + Math.max(textMs, voiceMs)
    }
    case 'HideTalk': {
      state.talkShown = false
      return delayMs + DIALOGUE_HIDE_TIME_MS
    }
    case 'Move':
      return delayMs + estimateMoveDurationMs(snippet.data.moveSpeed)
    case 'Motion':
      return delayMs + DEFAULT_MOTION_ESTIMATE_MS
    case 'Telop':
      return delayMs + TELOP_SHOW_TIME_MS + TELOP_HOLD_TIME_MS + TELOP_HIDE_TIME_MS
    case 'DoParam': {
      let maxParamMs: number = 0
      for (const param of snippet.data.params) {
        const paramMs: number = Math.max(0, param.duration * 1000)
        if (paramMs > maxParamMs) maxParamMs = paramMs
      }
      return delayMs + maxParamMs
    }
    case 'ScreenFadeOut':
    case 'ScreenFadeIn':
    case 'ApplyEffect':
    case 'RemoveEffect':
      return delayMs + Math.max(0, snippet.data.duration * 1000)
  }
}

export function estimateStoryDurationMs(
  story: StoryData,
  voiceDurationsMs: ReadonlyMap<string, number> = new Map<string, number>()
): number {
  const state: EstimateState = { talkShown: false }
  const context: EstimateContext = { voiceDurationsMs }
  let totalMs: number = 0
  for (const snippet of story.snippets) {
    totalMs += estimateSnippetDurationMs(snippet, context, state)
  }
  return Math.max(totalMs, 100)
}
