import {
  createStorySnippetId,
  getBuiltinSnippetDefinition,
  normalizeStoryIds,
  type IdentifiedSnippetData,
  type IdentifiedStoryData,
  type StoryAssetKind,
  type StoryData,
  type StoryInput
} from '@/story'
import type { ProjectAssets } from '@/project/assets'

export type EditorNode = IdentifiedSnippetData
export type EditorStory = IdentifiedStoryData
export type AddableSnippetType = EditorNode['type']

export type DocumentHistory = {
  past: readonly EditorStory[]
  present: EditorStory
  future: readonly EditorStory[]
  saved: EditorStory
  activeMergeKey: string | null
}

export type HistoryAction =
  | { type: 'load'; story: EditorStory }
  | { type: 'commit'; story: EditorStory; mergeKey?: string }
  | { type: 'flush-merge' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save'; story: EditorStory }

export type InsertSnippetResult = {
  story: EditorStory
  insertedId: string
}

export type DuplicateSnippetResult = {
  story: EditorStory
  duplicatedId: string
}

export type StoryAssetReference = {
  snippetId: string
  snippetType: EditorNode['type']
}

const MAX_HISTORY_ENTRIES: number = 80

export function createDocumentHistory(story: StoryInput | StoryData): DocumentHistory {
  const document: EditorStory = normalizeStoryIds(story)
  return {
    past: [],
    present: document,
    future: [],
    saved: document,
    activeMergeKey: null
  }
}

export function editorHistoryReducer(
  state: DocumentHistory,
  action: HistoryAction
): DocumentHistory {
  switch (action.type) {
    case 'load':
      return {
        past: [],
        present: action.story,
        future: [],
        saved: action.story,
        activeMergeKey: null
      }
    case 'commit': {
      if (storiesEqual(state.present, action.story)) return state

      const canMerge: boolean = Boolean(action.mergeKey) && state.activeMergeKey === action.mergeKey
      const past: readonly EditorStory[] = canMerge
        ? state.past
        : [...state.past, state.present].slice(-MAX_HISTORY_ENTRIES)

      return {
        ...state,
        past,
        present: action.story,
        future: [],
        activeMergeKey: action.mergeKey ?? null
      }
    }
    case 'flush-merge':
      return state.activeMergeKey ? { ...state, activeMergeKey: null } : state
    case 'undo': {
      const previous: EditorStory | undefined = state.past.at(-1)
      if (!previous) return state

      return {
        ...state,
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        activeMergeKey: null
      }
    }
    case 'redo': {
      const next: EditorStory | undefined = state.future.at(0)
      if (!next) return state

      return {
        ...state,
        past: [...state.past, state.present].slice(-MAX_HISTORY_ENTRIES),
        present: next,
        future: state.future.slice(1),
        activeMergeKey: null
      }
    }
    case 'save':
      return {
        ...state,
        saved: action.story
      }
  }
}

export function storiesEqual(left: EditorStory, right: EditorStory): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function findEditorNode(story: EditorStory, id: string | null): EditorNode | null {
  if (!id) return null

  return findNodeInList(story.snippets, id)
}

export function findEditorNodePath(
  story: EditorStory,
  id: string | null
): readonly number[] | null {
  if (!id) return null
  return findNodePathInList(story.snippets, id, [])
}

export function insertNewSnippet(
  story: EditorStory,
  type: AddableSnippetType,
  selectedId: string | null,
  assets: ProjectAssets
): InsertSnippetResult {
  const selected: EditorNode | null = findEditorNode(story, selectedId)
  const insertedId: string = createStorySnippetId()
  const inserted: EditorNode = getBuiltinSnippetDefinition(type).create(
    insertedId,
    assets
  ) as EditorNode
  const parentId: string | null =
    selected?.type === 'Parallel' ? selected.id : findParentId(story.snippets, selectedId)
  const afterId: string | null = selected?.type === 'Parallel' ? null : (selected?.id ?? null)

  return {
    story: {
      ...story,
      snippets: insertIntoList(story.snippets, parentId, afterId, inserted)
    },
    insertedId
  }
}

export function duplicateSnippetSubtree(
  story: EditorStory,
  selectedId: string
): DuplicateSnippetResult | null {
  const selected: EditorNode | null = findEditorNode(story, selectedId)
  if (!selected) return null

  const duplicated: EditorNode = cloneNodeWithNewIds(selected)
  const parentId: string | null = findParentId(story.snippets, selectedId)

  return {
    story: {
      ...story,
      snippets: insertIntoList(story.snippets, parentId, selectedId, duplicated)
    },
    duplicatedId: duplicated.id
  }
}

export function removeSnippetSubtree(story: EditorStory, selectedId: string): EditorStory {
  return {
    ...story,
    snippets: removeFromList(story.snippets, selectedId)
  }
}

export function updateSnippet(
  story: EditorStory,
  id: string,
  update: (node: EditorNode) => EditorNode
): EditorStory {
  return {
    ...story,
    snippets: updateList(story.snippets, id, update)
  }
}

export function updateSnippetValue(
  story: EditorStory,
  id: string,
  path: readonly string[],
  value: unknown
): EditorStory {
  return updateSnippet(story, id, (node: EditorNode): EditorNode => {
    // Field paths are supplied by the builtin definition layer and only target snippet data.
    return setValueAtPath(node, path, value) as EditorNode
  })
}

export function countSnippetSubtree(node: EditorNode): number {
  if (node.type !== 'Parallel') return 1
  return (
    1 +
    node.snippets.reduce(
      (count: number, child: EditorNode): number => count + countSnippetSubtree(child),
      0
    )
  )
}

export function findParentId(nodes: readonly EditorNode[], childId: string | null): string | null {
  if (!childId) return null

  for (const node of nodes) {
    if (node.type !== 'Parallel') continue
    if (node.snippets.some((child: EditorNode): boolean => child.id === childId)) return node.id

    const nestedParentId: string | null = findParentId(node.snippets, childId)
    if (nestedParentId) return nestedParentId
  }

  return null
}

export function findAssetReferences(
  story: EditorStory,
  assetKind: StoryAssetKind,
  key: string
): StoryAssetReference[] {
  const references: StoryAssetReference[] = []

  visitNodes(story.snippets, (node: EditorNode): void => {
    if (nodeReferencesAsset(node, assetKind, key)) {
      references.push({ snippetId: node.id, snippetType: node.type })
    }
  })

  return references
}

export function renameAssetReferences(
  story: EditorStory,
  assetKind: StoryAssetKind,
  oldKey: string,
  newKey: string
): EditorStory {
  return {
    ...story,
    snippets: renameAssetReferencesInList(story.snippets, assetKind, oldKey, newKey)
  }
}

export function repairLegacyAssetDefaults(story: EditorStory, assets: ProjectAssets): EditorStory {
  return {
    ...story,
    snippets: repairLegacyAssetDefaultsInList(story.snippets, assets)
  }
}

function repairLegacyAssetDefaultsInList(
  nodes: readonly EditorNode[],
  assets: ProjectAssets
): EditorNode[] {
  return nodes.map((node: EditorNode): EditorNode => {
    let repaired: EditorNode = node
    const definition = getBuiltinSnippetDefinition(node.type)
    for (const field of definition.fields) {
      if (field.kind !== 'asset' || field.optional) continue
      const placeholder: string =
        field.assetKind === 'models'
          ? 'model'
          : field.assetKind === 'backgrounds'
            ? 'background'
            : 'voice'
      const currentValue: unknown = getValueAtPath(repaired, field.path)
      const firstKey: string | undefined = Object.keys(assets[field.assetKind])[0]
      if (currentValue === placeholder && !assets[field.assetKind][placeholder] && firstKey) {
        repaired = setValueAtPath(repaired, field.path, firstKey) as EditorNode
      }
    }

    if (repaired.type === 'Parallel') {
      return {
        ...repaired,
        snippets: repairLegacyAssetDefaultsInList(repaired.snippets, assets)
      }
    }
    return repaired
  })
}

function findNodeInList(nodes: readonly EditorNode[], id: string): EditorNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.type === 'Parallel') {
      const nested: EditorNode | null = findNodeInList(node.snippets, id)
      if (nested) return nested
    }
  }

  return null
}

function getValueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function findNodePathInList(
  nodes: readonly EditorNode[],
  id: string,
  parentPath: readonly number[]
): readonly number[] | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node: EditorNode = nodes[index]
    const path: readonly number[] = [...parentPath, index]
    if (node.id === id) return path
    if (node.type === 'Parallel') {
      const nested: readonly number[] | null = findNodePathInList(node.snippets, id, path)
      if (nested) return nested
    }
  }

  return null
}

function insertIntoList(
  nodes: readonly EditorNode[],
  parentId: string | null,
  afterId: string | null,
  inserted: EditorNode
): EditorNode[] {
  if (!parentId) return insertAfter(nodes, afterId, inserted)

  return nodes.map((node: EditorNode): EditorNode => {
    if (node.type !== 'Parallel') return node
    if (node.id === parentId) {
      return {
        ...node,
        snippets: insertAfter(node.snippets, afterId, inserted)
      }
    }

    return {
      ...node,
      snippets: insertIntoList(node.snippets, parentId, afterId, inserted)
    }
  })
}

function insertAfter(
  nodes: readonly EditorNode[],
  afterId: string | null,
  inserted: EditorNode
): EditorNode[] {
  if (!afterId) return [...nodes, inserted]

  const index: number = nodes.findIndex((node: EditorNode): boolean => node.id === afterId)
  if (index < 0) return [...nodes, inserted]
  return [...nodes.slice(0, index + 1), inserted, ...nodes.slice(index + 1)]
}

function removeFromList(nodes: readonly EditorNode[], selectedId: string): EditorNode[] {
  return nodes.reduce((next: EditorNode[], node: EditorNode): EditorNode[] => {
    if (node.id === selectedId) return next
    if (node.type === 'Parallel') {
      next.push({
        ...node,
        snippets: removeFromList(node.snippets, selectedId)
      })
      return next
    }

    next.push(node)
    return next
  }, [])
}

function updateList(
  nodes: readonly EditorNode[],
  id: string,
  update: (node: EditorNode) => EditorNode
): EditorNode[] {
  return nodes.map((node: EditorNode): EditorNode => {
    if (node.id === id) return update(node)
    if (node.type !== 'Parallel') return node
    return {
      ...node,
      snippets: updateList(node.snippets, id, update)
    }
  })
}

function cloneNodeWithNewIds(node: EditorNode): EditorNode {
  const id: string = createStorySnippetId()
  if (node.type !== 'Parallel') {
    return structuredClone({ ...node, id }) as EditorNode
  }

  return {
    ...node,
    id,
    snippets: node.snippets.map(cloneNodeWithNewIds)
  }
}

function setValueAtPath(value: unknown, path: readonly string[], nextValue: unknown): unknown {
  if (path.length === 0) return nextValue

  const [key, ...remainingPath] = path
  const record: Record<string, unknown> = isRecord(value) ? value : {}

  return {
    ...record,
    [key]: setValueAtPath(record[key], remainingPath, nextValue)
  }
}

function visitNodes(nodes: readonly EditorNode[], visit: (node: EditorNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.type === 'Parallel') visitNodes(node.snippets, visit)
  }
}

function nodeReferencesAsset(node: EditorNode, assetKind: StoryAssetKind, key: string): boolean {
  if (assetKind === 'backgrounds') {
    return node.type === 'ChangeBackgroundImage' && node.data.background === key
  }

  if (assetKind === 'voices') {
    return node.type === 'Talk' && node.data.voice === key
  }

  if (assetKind !== 'models') return false

  switch (node.type) {
    case 'LayoutAppear':
    case 'LayoutClear':
    case 'Move':
    case 'Motion':
    case 'DoParam':
      return node.data.model === key
    case 'Talk':
      return node.data.model === key
    default:
      return false
  }
}

function renameAssetReferencesInList(
  nodes: readonly EditorNode[],
  assetKind: StoryAssetKind,
  oldKey: string,
  newKey: string
): EditorNode[] {
  return nodes.map((node: EditorNode): EditorNode => {
    const renamedNode: EditorNode = renameNodeAssetReference(node, assetKind, oldKey, newKey)
    if (renamedNode.type !== 'Parallel') return renamedNode
    return {
      ...renamedNode,
      snippets: renameAssetReferencesInList(renamedNode.snippets, assetKind, oldKey, newKey)
    }
  })
}

function renameNodeAssetReference(
  node: EditorNode,
  assetKind: StoryAssetKind,
  oldKey: string,
  newKey: string
): EditorNode {
  if (assetKind === 'backgrounds' && node.type === 'ChangeBackgroundImage') {
    return node.data.background === oldKey
      ? { ...node, data: { ...node.data, background: newKey } }
      : node
  }
  if (assetKind === 'voices' && node.type === 'Talk') {
    return node.data.voice === oldKey ? { ...node, data: { ...node.data, voice: newKey } } : node
  }
  if (assetKind !== 'models') return node

  switch (node.type) {
    case 'LayoutAppear':
    case 'LayoutClear':
    case 'Move':
    case 'Motion':
    case 'DoParam':
      return node.data.model === oldKey
        ? ({ ...node, data: { ...node.data, model: newKey } } as EditorNode)
        : node
    case 'Talk':
      return node.data.model === oldKey ? { ...node, data: { ...node.data, model: newKey } } : node
    default:
      return node
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
