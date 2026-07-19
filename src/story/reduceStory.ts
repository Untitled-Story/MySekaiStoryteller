import type { SnippetData, StoryData } from './schema'
import { getBuiltinSnippetDefinition } from './snippets/definitions'
import { createInitialStorySceneState } from './state'
import type { StorySceneState, StorySnippetReduceContext } from './state'

const reduceContext: StorySnippetReduceContext = {
  reduceSnippet: reduceStorySnippet
}

export function reduceStorySnippet(state: StorySceneState, snippet: SnippetData): StorySceneState {
  return getBuiltinSnippetDefinition(snippet.type).reduce(state, snippet, reduceContext)
}

export function reduceStory(story: StoryData): StorySceneState {
  return story.snippets.reduce(
    (state: StorySceneState, snippet: SnippetData): StorySceneState =>
      reduceStorySnippet(state, snippet),
    createInitialStorySceneState()
  )
}

export function reduceStoryBeforeSnippet(story: StoryData, snippetId: string): StorySceneState {
  const result: ReduceUntilResult = reduceSequenceUntil(
    story.snippets,
    snippetId,
    createInitialStorySceneState()
  )
  if (!result.found) {
    throw new Error(`Story snippet 不存在: ${snippetId}`)
  }
  return result.state
}

type PrefixCacheEntry = {
  signature: string
  inputFingerprint: string
  output: StorySceneState
}

const stateFingerprintCache = new WeakMap<StorySceneState, string>()

export class StoryStatePrefixCache {
  private entries = new Map<string, PrefixCacheEntry>()
  private statesBefore = new Map<string, StorySceneState>()

  update(story: StoryData): void {
    const nextEntries = new Map<string, PrefixCacheEntry>()
    const nextStatesBefore = new Map<string, StorySceneState>()
    reduceCachedSequence(
      story.snippets,
      createInitialStorySceneState(),
      this.entries,
      nextEntries,
      nextStatesBefore
    )
    this.entries = nextEntries
    this.statesBefore = nextStatesBefore
  }

  before(snippetId: string): StorySceneState {
    const state: StorySceneState | undefined = this.statesBefore.get(snippetId)
    if (!state) throw new Error(`Story snippet 不存在: ${snippetId}`)
    return state
  }
}

type ReduceUntilResult = {
  state: StorySceneState
  found: boolean
}

function reduceSequenceUntil(
  snippets: readonly SnippetData[],
  snippetId: string,
  initialState: StorySceneState
): ReduceUntilResult {
  let state: StorySceneState = initialState
  for (const snippet of snippets) {
    if (snippet.id === snippetId) return { state, found: true }

    if (snippet.type === 'Parallel') {
      const nested: ReduceUntilResult = reduceSequenceUntil(snippet.snippets, snippetId, state)
      if (nested.found) return nested
      state = nested.state
      continue
    }

    state = reduceStorySnippet(state, snippet)
  }

  return { state, found: false }
}

function reduceCachedSequence(
  snippets: readonly SnippetData[],
  initialState: StorySceneState,
  previousEntries: ReadonlyMap<string, PrefixCacheEntry>,
  nextEntries: Map<string, PrefixCacheEntry>,
  statesBefore: Map<string, StorySceneState>
): StorySceneState {
  let state: StorySceneState = initialState
  for (const snippet of snippets) {
    if (snippet.id) statesBefore.set(snippet.id, state)
    if (snippet.type === 'Parallel') {
      state = reduceCachedSequence(
        snippet.snippets,
        state,
        previousEntries,
        nextEntries,
        statesBefore
      )
      continue
    }

    const signature: string = JSON.stringify(snippet)
    const inputFingerprint: string = fingerprintState(state)
    const previous: PrefixCacheEntry | undefined = snippet.id
      ? previousEntries.get(snippet.id)
      : undefined
    const output: StorySceneState =
      previous?.signature === signature && previous.inputFingerprint === inputFingerprint
        ? previous.output
        : reduceStorySnippet(state, snippet)
    if (snippet.id) {
      nextEntries.set(snippet.id, { signature, inputFingerprint, output })
    }
    state = output
  }
  return state
}

function fingerprintState(state: StorySceneState): string {
  const cached: string | undefined = stateFingerprintCache.get(state)
  if (cached) return cached
  const fingerprint: string = JSON.stringify(state)
  stateFingerprintCache.set(state, fingerprint)
  return fingerprint
}
