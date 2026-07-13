import type { EditorNode, EditorStory } from './editorDocument'

export type SnippetDropPlacement = 'before' | 'inside' | 'after'

export function moveSnippetSubtree(
  story: EditorStory,
  sourceId: string,
  targetId: string,
  placement: SnippetDropPlacement
): EditorStory | null {
  if (sourceId === targetId) return null

  const source: EditorNode | null = findNode(story.snippets, sourceId)
  const target: EditorNode | null = findNode(story.snippets, targetId)
  if (!source || !target) return null
  if (placement === 'inside' && target.type !== 'Parallel') return null

  const targetParentId: string | null =
    placement === 'inside' ? target.id : findParentId(story.snippets, target.id)
  if (targetParentId === source.id || containsNode(source, targetParentId)) return null

  let beforeId: string | null = null
  if (placement === 'before') {
    beforeId = target.id
  } else if (placement === 'after') {
    beforeId = findNextSiblingId(story.snippets, target.id)
    if (beforeId === source.id) beforeId = findNextSiblingId(story.snippets, source.id)
  }

  const withoutSource: EditorNode[] = removeNode(story.snippets, source.id)
  return {
    ...story,
    snippets: insertBeforeInList(withoutSource, targetParentId, beforeId, source)
  }
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

function insertBeforeInList(
  nodes: readonly EditorNode[],
  parentId: string | null,
  beforeId: string | null,
  inserted: EditorNode
): EditorNode[] {
  if (!parentId) return insertBefore(nodes, beforeId, inserted)

  return nodes.map((node: EditorNode): EditorNode => {
    if (node.type !== 'Parallel') return node
    if (node.id === parentId) {
      return { ...node, snippets: insertBefore(node.snippets, beforeId, inserted) }
    }
    return {
      ...node,
      snippets: insertBeforeInList(node.snippets, parentId, beforeId, inserted)
    }
  })
}

function insertBefore(
  nodes: readonly EditorNode[],
  beforeId: string | null,
  inserted: EditorNode
): EditorNode[] {
  if (!beforeId) return [...nodes, inserted]

  const index: number = nodes.findIndex((node: EditorNode): boolean => node.id === beforeId)
  if (index < 0) return [...nodes, inserted]
  return [...nodes.slice(0, index), inserted, ...nodes.slice(index)]
}

function removeNode(nodes: readonly EditorNode[], selectedId: string): EditorNode[] {
  return nodes.reduce((next: EditorNode[], node: EditorNode): EditorNode[] => {
    if (node.id === selectedId) return next
    if (node.type === 'Parallel') {
      next.push({ ...node, snippets: removeNode(node.snippets, selectedId) })
      return next
    }
    next.push(node)
    return next
  }, [])
}

function findNextSiblingId(nodes: readonly EditorNode[], id: string): string | null {
  const result: string | null | undefined = findNextSiblingIdOrMissing(nodes, id)
  return result ?? null
}

function findNextSiblingIdOrMissing(
  nodes: readonly EditorNode[],
  id: string
): string | null | undefined {
  const index: number = nodes.findIndex((node: EditorNode): boolean => node.id === id)
  if (index >= 0) return nodes[index + 1]?.id ?? null

  for (const node of nodes) {
    if (node.type !== 'Parallel') continue
    const nested: string | null | undefined = findNextSiblingIdOrMissing(node.snippets, id)
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
