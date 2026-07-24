import type { EditorNode, EditorStory } from './editorDocument'

export type SnippetDropPlacement = 'before' | 'inside' | 'after'

export function moveSnippetSubtree(
  story: EditorStory,
  sourceId: string,
  targetId: string,
  placement: SnippetDropPlacement
): EditorStory | null {
  return moveSnippetSubtrees(story, [sourceId], targetId, placement)
}

export function moveSnippetSubtrees(
  story: EditorStory,
  sourceIds: readonly string[],
  targetId: string,
  placement: SnippetDropPlacement
): EditorStory | null {
  const sources: readonly EditorNode[] = normalizeSnippetRoots(story, sourceIds)
  if (sources.length === 0) return null

  const target: EditorNode | null = findNode(story.snippets, targetId)
  if (!target) return null
  if (placement === 'inside' && target.type !== 'Parallel') return null

  const sourceIdSet: Set<string> = new Set(sources.map((source: EditorNode): string => source.id))
  if (sourceIdSet.has(targetId)) return null

  const targetParentId: string | null =
    placement === 'inside' ? target.id : findParentId(story.snippets, target.id)

  for (const source of sources) {
    if (targetParentId === source.id || containsNode(source, targetParentId)) return null
    if (containsNode(source, targetId)) return null
  }

  let beforeId: string | null = null
  if (placement === 'before') {
    beforeId = target.id
  } else if (placement === 'after') {
    beforeId = findNextSiblingOutsideSet(story.snippets, target.id, sourceIdSet)
  }

  const withoutSources: EditorNode[] = removeNodes(story.snippets, sourceIdSet)
  return {
    ...story,
    snippets: insertBeforeManyInList(withoutSources, targetParentId, beforeId, sources)
  }
}

export function normalizeSnippetRoots(
  story: EditorStory,
  sourceIds: readonly string[]
): EditorNode[] {
  const selectedIds: Set<string> = new Set(sourceIds)
  const roots: EditorNode[] = []

  function visit(nodes: readonly EditorNode[], ancestorSelected: boolean): void {
    for (const node of nodes) {
      const selected: boolean = selectedIds.has(node.id)
      if (selected && !ancestorSelected) roots.push(node)
      if (node.type === 'Parallel') visit(node.snippets, ancestorSelected || selected)
    }
  }

  visit(story.snippets, false)
  return roots
}

export function collectSnippetIdsInDocumentOrder(story: EditorStory): string[] {
  const ids: string[] = []
  function visit(nodes: readonly EditorNode[]): void {
    for (const node of nodes) {
      ids.push(node.id)
      if (node.type === 'Parallel') visit(node.snippets)
    }
  }
  visit(story.snippets)
  return ids
}

function findNode(nodes: readonly EditorNode[], id: string): EditorNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.type === 'Parallel') {
      const nested: EditorNode | null = findNode(node.snippets, id)
      if (nested) return nested
    }
  }
  return null
}

function findParentId(nodes: readonly EditorNode[], childId: string): string | null {
  for (const node of nodes) {
    if (node.type !== 'Parallel') continue
    if (node.snippets.some((child: EditorNode): boolean => child.id === childId)) return node.id

    const nestedParentId: string | null = findParentId(node.snippets, childId)
    if (nestedParentId) return nestedParentId
  }
  return null
}

function removeNodes(nodes: readonly EditorNode[], selectedIds: ReadonlySet<string>): EditorNode[] {
  return nodes.reduce((next: EditorNode[], node: EditorNode): EditorNode[] => {
    if (selectedIds.has(node.id)) return next
    if (node.type === 'Parallel') {
      next.push({ ...node, snippets: removeNodes(node.snippets, selectedIds) })
      return next
    }
    next.push(node)
    return next
  }, [])
}

function insertBeforeManyInList(
  nodes: readonly EditorNode[],
  parentId: string | null,
  beforeId: string | null,
  inserted: readonly EditorNode[]
): EditorNode[] {
  if (!parentId) return insertBeforeMany(nodes, beforeId, inserted)

  return nodes.map((node: EditorNode): EditorNode => {
    if (node.type !== 'Parallel') return node
    if (node.id === parentId) {
      return { ...node, snippets: insertBeforeMany(node.snippets, beforeId, inserted) }
    }
    return {
      ...node,
      snippets: insertBeforeManyInList(node.snippets, parentId, beforeId, inserted)
    }
  })
}

function insertBeforeMany(
  nodes: readonly EditorNode[],
  beforeId: string | null,
  inserted: readonly EditorNode[]
): EditorNode[] {
  if (inserted.length === 0) return [...nodes]
  if (!beforeId) return [...nodes, ...inserted]

  const index: number = nodes.findIndex((node: EditorNode): boolean => node.id === beforeId)
  if (index < 0) return [...nodes, ...inserted]
  return [...nodes.slice(0, index), ...inserted, ...nodes.slice(index)]
}

function findNextSiblingOutsideSet(
  nodes: readonly EditorNode[],
  id: string,
  excludedIds: ReadonlySet<string>
): string | null {
  const result: string | null | undefined = findNextSiblingOutsideSetOrMissing(
    nodes,
    id,
    excludedIds
  )
  return result ?? null
}

function findNextSiblingOutsideSetOrMissing(
  nodes: readonly EditorNode[],
  id: string,
  excludedIds: ReadonlySet<string>
): string | null | undefined {
  const index: number = nodes.findIndex((node: EditorNode): boolean => node.id === id)
  if (index >= 0) {
    for (let cursor: number = index + 1; cursor < nodes.length; cursor += 1) {
      const candidateId: string = nodes[cursor].id
      if (!excludedIds.has(candidateId)) return candidateId
    }
    return null
  }

  for (const node of nodes) {
    if (node.type !== 'Parallel') continue
    const nested: string | null | undefined = findNextSiblingOutsideSetOrMissing(
      node.snippets,
      id,
      excludedIds
    )
    if (nested !== undefined) return nested
  }
  return undefined
}

function containsNode(node: EditorNode, id: string | null): boolean {
  if (!id || node.type !== 'Parallel') return false
  return node.snippets.some(
    (child: EditorNode): boolean => child.id === id || containsNode(child, id)
  )
}
