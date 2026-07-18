import type { LeafSnippetData, SnippetData, StoryData } from './schema'
import { MoveSpeed } from './schema'

const MODEL_SHOW_TIME_S = 0.2
const MODEL_HIDE_TIME_S = 0.05
const DIALOGUE_SHOW_TIME_S = 0.07
const DIALOGUE_HIDE_TIME_S = 0.1
const DIALOGUE_CHAR_TIME_S = 0.07
const TELOP_SHOW_TIME_S = 0.2
const TELOP_HOLD_TIME_S = 2
const TELOP_HIDE_TIME_S = 0.2
const DEFAULT_FADE_TIME_S = 0.5
/** Live2D motions are often longer than 1.5s; under-estimate cuts exports short. */
const DEFAULT_MOTION_TIME_S = 2.4
const DEFAULT_PARAM_TIME_S = 0.3
/**
 * Small planning pad only — runtime storyDone detection trims the real end.
 * Large pads caused multi-second black tails.
 */
const EXPORT_DURATION_PAD_RATIO = 1.05
const EXPORT_DURATION_PAD_SEC = 1

/**
 * Best-effort total story duration for progress UI.
 * Exact motion/voice lengths are unknown without asset metadata.
 */
export function calculateStoryDuration(story: StoryData): number {
  return calculateSequenceDuration(story.snippets)
}

/**
 * Padded duration for export job planning / totalFrames.
 * Prefer runtime storyEndedAtFrame to shrink; pad is only a soft ceiling.
 */
export function planExportDuration(story: StoryData): {
  estimatedSec: number
  planningSec: number
} {
  const estimatedSec = Math.max(0.001, calculateStoryDuration(story))
  const planningSec = Math.max(
    estimatedSec + EXPORT_DURATION_PAD_SEC,
    estimatedSec * EXPORT_DURATION_PAD_RATIO
  )
  return { estimatedSec, planningSec }
}

function calculateSequenceDuration(snippets: readonly SnippetData[]): number {
  let total = 0
  for (const snippet of snippets) {
    total += snippet.delay
    if (snippet.type === 'Parallel') {
      total += maxParallelDuration(snippet.snippets)
    } else {
      total += estimateLeafDuration(snippet)
    }
  }
  return total
}

function maxParallelDuration(snippets: readonly SnippetData[]): number {
  if (snippets.length === 0) return 0
  let max = 0
  for (const snippet of snippets) {
    const duration =
      snippet.type === 'Parallel'
        ? snippet.delay + maxParallelDuration(snippet.snippets)
        : snippet.delay + estimateLeafDuration(snippet)
    if (duration > max) max = duration
  }
  return max
}

function estimateLeafDuration(snippet: LeafSnippetData): number {
  switch (snippet.type) {
    case 'Talk': {
      const chars = snippet.data.content?.length ?? 0
      return DIALOGUE_SHOW_TIME_S + chars * DIALOGUE_CHAR_TIME_S
    }
    case 'HideTalk':
      return DIALOGUE_HIDE_TIME_S
    case 'Telop':
      return TELOP_SHOW_TIME_S + TELOP_HOLD_TIME_S + TELOP_HIDE_TIME_S
    case 'LayoutAppear':
      return Math.max(MODEL_SHOW_TIME_S, moveSpeedToSeconds((snippet.data as { moveSpeed?: MoveSpeed }).moveSpeed))
    case 'LayoutClear':
      return Math.max(MODEL_HIDE_TIME_S, moveSpeedToSeconds((snippet.data as { moveSpeed?: MoveSpeed }).moveSpeed))
    case 'Move':
      return moveSpeedToSeconds(snippet.data.moveSpeed)
    case 'ScreenFadeIn':
    case 'ScreenFadeOut':
      return typeof snippet.data.duration === 'number'
        ? snippet.data.duration
        : DEFAULT_FADE_TIME_S
    case 'Motion':
      return DEFAULT_MOTION_TIME_S
    case 'DoParam': {
      let max = 0
      for (const param of snippet.data.params) {
        if (param.duration > max) max = param.duration
      }
      return max > 0 ? max : DEFAULT_PARAM_TIME_S
    }
    case 'ChangeBackgroundImage':
    case 'ChangeLayoutMode':
      return 0
    default:
      return 0
  }
}

function moveSpeedToSeconds(moveSpeed: MoveSpeed | undefined | null): number {
  switch (moveSpeed) {
    case MoveSpeed.Slow:
      return 0.7
    case MoveSpeed.Normal:
      return 0.5
    case MoveSpeed.Fast:
      return 0.3
    case MoveSpeed.Immediate:
      return 0
    default:
      return 0.5
  }
}
