import { StorySchema, type SnippetData, type StoryData, type StoryInput } from './schema'

export type IdentifiedParallelSnippetData = Omit<
  Extract<SnippetData, { type: 'Parallel' }>,
  'id' | 'snippets'
> & {
  id: string
  snippets: IdentifiedSnippetData[]
}

export type IdentifiedLeafSnippetData = Exclude<SnippetData, { type: 'Parallel' }> & {
  id: string
}

export type IdentifiedSnippetData = IdentifiedLeafSnippetData | IdentifiedParallelSnippetData

export type IdentifiedStoryData = Omit<StoryData, 'snippets'> & {
  snippets: IdentifiedSnippetData[]
}

export type StoryIdFactory = () => string

export function createStorySnippetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const randomPart: string = Math.random().toString(16).slice(2)
  const timestampPart: string = Date.now().toString(16)
  return `00000000-0000-4000-8000-${`${timestampPart}${randomPart}`.padEnd(12, '0').slice(0, 12)}`
}

/**
 * Preserves valid, unique IDs and assigns new UUIDs to legacy or duplicated nodes.
 * The returned value is safe for editor tree operations; callers decide when to save it.
 */
export function normalizeStoryIds(
  story: StoryInput | StoryData,
  createId: StoryIdFactory = createStorySnippetId
): IdentifiedStoryData {
  const parsed: StoryData = StorySchema.parse(story)
  const seenIds: Set<string> = new Set()

  return {
    ...parsed,
    snippets: normalizeSnippets(parsed.snippets, seenIds, createId)
  }
}

function normalizeSnippets(
  snippets: readonly SnippetData[],
  seenIds: Set<string>,
  createId: StoryIdFactory
): IdentifiedSnippetData[] {
  return snippets.map((snippet: SnippetData): IdentifiedSnippetData => {
    const id: string = resolveSnippetId(snippet.id, seenIds, createId)

    if (snippet.type === 'Parallel') {
      return {
        ...snippet,
        id,
        snippets: normalizeSnippets(snippet.snippets, seenIds, createId)
      }
    }

    return {
      ...snippet,
      id
    }
  })
}

function resolveSnippetId(
  existingId: string | undefined,
  seenIds: Set<string>,
  createId: StoryIdFactory
): string {
  if (existingId && !seenIds.has(existingId)) {
    seenIds.add(existingId)
    return existingId
  }

  let id: string = createId()
  while (seenIds.has(id)) {
    id = createId()
  }

  seenIds.add(id)
  return id
}
