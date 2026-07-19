import type {
  ChangeEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import { useEffect, useRef, useState } from 'react'
import { useLongPressContextMenu } from '@/hooks/useLongPressContextMenu'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  GripVertical,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  LibraryBig,
  Play,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Volume2
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/ContextMenu'
import {
  builtinSnippetDefinitions,
  type BuiltinSnippetDefinition,
  type StoryAssetKind
} from '@/story'
import type { ProjectAssetKind, ProjectAssets } from '@/project/assets'
import { isDesktopRuntime } from '@/lib/platform'
import { cn } from '@/lib/style'
import {
  getAssetItems,
  NODE_PRESENTATIONS,
  TONE_CLASS_NAMES,
  type EditorAssetSelection,
  type FlatTreeNode,
  type NodePresentation
} from './editorCatalog'
import { formatNodeSummary } from './editorCatalog'
import type { AddableSnippetType, EditorNode } from './editorDocument'
import type { SnippetDropPlacement } from './editorTree'
import { useTranslation } from 'react-i18next'
import {
  localizeAssetKind,
  localizeSnippetCategory,
  localizeSnippetDescription
} from './editorLocalization'

export type EditorSidebarTab = 'story' | 'assets'

type StoryDropTarget = {
  nodeId: string
  placement: SnippetDropPlacement
  indicatorNodeId: string
  indicatorPlacement: SnippetDropPlacement
  indicatorDepth: number
}

type StoryMoveTarget = {
  nodeId: string
  placement: SnippetDropPlacement
}

type StoryContextMoves = {
  up: StoryMoveTarget | null
  down: StoryMoveTarget | null
  indent: StoryMoveTarget | null
  outdent: StoryMoveTarget | null
}

export function EditorSidebar({
  activePanel,
  searchQuery,
  treeNodes,
  selectedNodeId,
  activeSnippetIds,
  expandedParallelIds,
  assets,
  selectedAsset,
  addDialogOpen,
  onActivePanelChange,
  onSearchQueryChange,
  onSelectNode,
  onContextSelectSnippet,
  onPreviewSnippet,
  onDuplicateSnippet,
  onDeleteSnippet,
  onToggleParallel,
  onMoveSnippet,
  onSelectAsset,
  onAddDialogOpenChange,
  onAddSnippet,
  onImportAsset,
  onRegisterModel
}: {
  activePanel: EditorSidebarTab
  searchQuery: string
  treeNodes: readonly FlatTreeNode[]
  selectedNodeId: string | null
  activeSnippetIds: ReadonlySet<string>
  expandedParallelIds: ReadonlySet<string>
  assets: ProjectAssets
  selectedAsset: EditorAssetSelection | null
  addDialogOpen: boolean
  onActivePanelChange: (panel: EditorSidebarTab) => void
  onSearchQueryChange: (query: string) => void
  onSelectNode: (nodeId: string) => void
  onContextSelectSnippet: (nodeId: string) => void
  onPreviewSnippet: (nodeId: string) => void
  onDuplicateSnippet: (nodeId: string) => void
  onDeleteSnippet: (nodeId: string) => void
  onToggleParallel: (nodeId: string) => void
  onMoveSnippet: (sourceId: string, targetId: string, placement: SnippetDropPlacement) => void
  onSelectAsset: (selection: EditorAssetSelection) => void
  onAddDialogOpenChange: (open: boolean) => void
  onAddSnippet: (type: AddableSnippetType) => void
  onImportAsset: (kind: Exclude<ProjectAssetKind, 'models'>) => void
  onRegisterModel: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const searchLabel: string =
    activePanel === 'story' ? t('editor.searchSnippets') : t('editor.searchAssets')

  return (
    <aside className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r bg-muted/20">
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <div className="flex h-8 items-center rounded-md bg-muted p-0.5">
          <TabButton
            active={activePanel === 'story'}
            label={t('editor.story')}
            onClick={(): void => onActivePanelChange('story')}
          />
          <TabButton
            active={activePanel === 'assets'}
            label={t('editor.assets')}
            onClick={(): void => onActivePanelChange('assets')}
          />
        </div>
        {activePanel === 'story' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-tour="editor-add-snippet"
            className="ml-auto size-8"
            aria-label={t('editor.addSnippet')}
            title={t('editor.addSnippet')}
            onClick={(): void => onAddDialogOpenChange(true)}
          >
            <Plus className="size-4" />
          </Button>
        ) : (
          <LibraryBig className="ml-auto size-4 text-muted-foreground" />
        )}
      </div>

      <div className="border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={searchQuery}
            className="h-8 border-none bg-background pl-8 text-xs shadow-xs"
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              onSearchQueryChange(event.currentTarget.value)
            }
          />
        </div>
      </div>

      {activePanel === 'story' ? (
        <StoryTree
          nodes={treeNodes}
          selectedNodeId={selectedNodeId}
          activeSnippetIds={activeSnippetIds}
          expandedParallelIds={expandedParallelIds}
          onSelect={onSelectNode}
          onContextSelect={onContextSelectSnippet}
          onPreview={onPreviewSnippet}
          onDuplicate={onDuplicateSnippet}
          onDelete={onDeleteSnippet}
          onToggleParallel={onToggleParallel}
          onMove={onMoveSnippet}
          dragEnabled={!searchQuery.trim()}
          onAdd={(): void => onAddDialogOpenChange(true)}
        />
      ) : (
        <AssetLibrary
          assets={assets}
          query={searchQuery}
          selectedAsset={selectedAsset}
          onSelect={onSelectAsset}
          onImport={onImportAsset}
          onRegisterModel={onRegisterModel}
        />
      )}

      <AddSnippetDialog
        open={addDialogOpen}
        assets={assets}
        onOpenChange={onAddDialogOpenChange}
        onAdd={onAddSnippet}
      />
    </aside>
  )
}

function TabButton({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'h-8 rounded-sm px-3 text-xs transition-colors sm:h-7',
        active
          ? 'bg-background font-medium shadow-xs'
          : 'text-muted-foreground hover:text-foreground'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function StoryTree({
  nodes,
  selectedNodeId,
  activeSnippetIds,
  expandedParallelIds,
  onSelect,
  onContextSelect,
  onPreview,
  onDuplicate,
  onDelete,
  onToggleParallel,
  onMove,
  dragEnabled,
  onAdd
}: {
  nodes: readonly FlatTreeNode[]
  selectedNodeId: string | null
  activeSnippetIds: ReadonlySet<string>
  expandedParallelIds: ReadonlySet<string>
  onSelect: (nodeId: string) => void
  onContextSelect: (nodeId: string) => void
  onPreview: (nodeId: string) => void
  onDuplicate: (nodeId: string) => void
  onDelete: (nodeId: string) => void
  onToggleParallel: (nodeId: string) => void
  onMove: (sourceId: string, targetId: string, placement: SnippetDropPlacement) => void
  dragEnabled: boolean
  onAdd: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const treeRef = useRef<HTMLDivElement | null>(null)
  const pointerRef = useRef<{
    pointerId: number
    sourceId: string
    startX: number
    startY: number
    active: boolean
  } | null>(null)
  const dropTargetRef = useRef<StoryDropTarget | null>(null)
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<StoryDropTarget | null>(null)

  function updateDropTarget(nextTarget: StoryDropTarget | null): void {
    dropTargetRef.current = nextTarget
    setDropTarget(nextTarget)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragEnabled || event.button !== 0) return
    if (!(event.target instanceof Element)) return
    if (!event.target.closest('[data-drag-handle]')) return
    if (event.target.closest('[data-no-drag]')) return

    const row: HTMLElement | null = event.target.closest<HTMLElement>('[data-snippet-id]')
    const sourceId: string | undefined = row?.dataset.snippetId
    if (!sourceId) return

    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = {
      pointerId: event.pointerId,
      sourceId,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointer: typeof pointerRef.current = pointerRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return

    const distance: number = Math.hypot(
      event.clientX - pointer.startX,
      event.clientY - pointer.startY
    )
    if (!pointer.active) {
      if (distance < 6) return
      pointer.active = true
      setDraggedNodeId(pointer.sourceId)
    }

    event.preventDefault()
    const element: Element | null = document.elementFromPoint(event.clientX, event.clientY)
    const row: HTMLElement | null = element?.closest<HTMLElement>('[data-snippet-id]') ?? null
    const targetId: string | undefined = row?.dataset.snippetId
    const source: FlatTreeNode | undefined = nodes.find(
      (candidate: FlatTreeNode): boolean => candidate.node.id === pointer.sourceId
    )
    const target: FlatTreeNode | undefined = nodes.find(
      (candidate: FlatTreeNode): boolean => candidate.node.id === targetId
    )
    if (!source) {
      updateDropTarget(null)
      return
    }

    const treeBounds: DOMRect | undefined = treeRef.current?.getBoundingClientRect()
    const outdentTarget: StoryDropTarget | null = resolveOutdentTarget(
      event.clientX,
      treeBounds,
      source,
      target,
      nodes
    )
    if (outdentTarget) {
      updateDropTarget(outdentTarget)
      return
    }

    if (!target) {
      const rootEndTarget: StoryDropTarget | null = resolveRootEndTarget(
        event.clientY,
        treeRef.current,
        source,
        nodes
      )
      updateDropTarget(rootEndTarget)
      return
    }

    if (target.node.id === pointer.sourceId || isPathDescendant(target.path, source.path)) {
      updateDropTarget(null)
      return
    }

    const placement: SnippetDropPlacement = resolveDropPlacement(
      event.clientY,
      row?.getBoundingClientRect(),
      target
    )
    updateDropTarget({
      nodeId: target.node.id,
      placement,
      indicatorNodeId: target.node.id,
      indicatorPlacement: placement,
      indicatorDepth: placement === 'inside' ? target.depth + 1 : target.depth
    })
  }

  function finishPointerDrag(event?: ReactPointerEvent<HTMLDivElement>): void {
    const pointer: typeof pointerRef.current = pointerRef.current
    if (!pointer || (event && pointer.pointerId !== event.pointerId)) return

    if (pointer.active && dropTargetRef.current) {
      onMove(pointer.sourceId, dropTargetRef.current.nodeId, dropTargetRef.current.placement)
      event?.preventDefault()
    }
    if (event && treeRef.current?.hasPointerCapture(event.pointerId)) {
      treeRef.current.releasePointerCapture(event.pointerId)
    }
    pointerRef.current = null
    setDraggedNodeId(null)
    updateDropTarget(null)
  }

  return (
    <div
      ref={treeRef}
      data-tour="editor-story-tree"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
    >
      <div className="space-y-0.5">
        {nodes.map((flatNode: FlatTreeNode): JSX.Element => {
          const contextMoves: StoryContextMoves = resolveContextMoves(nodes, flatNode)
          return (
            <StoryNodeRow
              key={flatNode.node.id}
              flatNode={flatNode}
              selected={flatNode.node.id === selectedNodeId}
              active={activeSnippetIds.has(flatNode.node.id)}
              hasActiveSnippets={activeSnippetIds.size > 0}
              expanded={expandedParallelIds.has(flatNode.node.id)}
              dragEnabled={dragEnabled}
              dragging={draggedNodeId === flatNode.node.id}
              dropPlacement={
                dropTarget?.indicatorNodeId === flatNode.node.id
                  ? dropTarget.indicatorPlacement
                  : null
              }
              dropIndicatorDepth={
                dropTarget?.indicatorNodeId === flatNode.node.id ? dropTarget.indicatorDepth : null
              }
              onSelect={onSelect}
              onContextSelect={onContextSelect}
              onPreview={onPreview}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onMove={onMove}
              contextMoves={contextMoves}
              onToggleParallel={onToggleParallel}
            />
          )
        })}
      </div>
      {nodes.length === 0 && (
        <div className="px-2 pt-8 text-center text-xs text-muted-foreground">
          {t('editor.emptyStory')}
        </div>
      )}
      <button
        type="button"
        className="mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onAdd}
      >
        <Plus className="size-3.5" />
        {t('editor.addSnippet')}
      </button>
    </div>
  )
}

function StoryNodeRow({
  flatNode,
  selected,
  active,
  hasActiveSnippets,
  expanded,
  dragEnabled,
  dragging,
  dropPlacement,
  dropIndicatorDepth,
  onSelect,
  onContextSelect,
  onPreview,
  onDuplicate,
  onDelete,
  onMove,
  contextMoves,
  onToggleParallel
}: {
  flatNode: FlatTreeNode
  selected: boolean
  active: boolean
  hasActiveSnippets: boolean
  expanded: boolean
  dragEnabled: boolean
  dragging: boolean
  dropPlacement: SnippetDropPlacement | null
  dropIndicatorDepth: number | null
  onSelect: (nodeId: string) => void
  onContextSelect: (nodeId: string) => void
  onPreview: (nodeId: string) => void
  onDuplicate: (nodeId: string) => void
  onDelete: (nodeId: string) => void
  onMove: (sourceId: string, targetId: string, placement: SnippetDropPlacement) => void
  contextMoves: StoryContextMoves
  onToggleParallel: (nodeId: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const node: EditorNode = flatNode.node
  const presentation: NodePresentation = NODE_PRESENTATIONS[node.type]
  const Icon: LucideIcon = presentation.icon
  const isParallel: boolean = node.type === 'Parallel'

  function moveTo(target: StoryMoveTarget | null): void {
    if (target) onMove(node.id, target.nodeId, target.placement)
  }

  const longPressHandlers = useLongPressContextMenu({
    onOpen: (): void => {
      onContextSelect(node.id)
    }
  })

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(): void => onContextSelect(node.id)}>
        <div
          className={cn('relative transition-opacity', dragging && 'opacity-35')}
          style={{ paddingLeft: `${flatNode.depth * 18}px` }}
          data-snippet-id={node.id}
          {...longPressHandlers}
        >
          {dropPlacement === 'before' && (
            <span
              className="pointer-events-none absolute top-0 right-2 z-10 h-0.5 -translate-y-0.5 rounded-full bg-primary"
              style={{ left: `${(dropIndicatorDepth ?? flatNode.depth) * 18 + 8}px` }}
            />
          )}
          {dropPlacement === 'after' && (
            <span
              className="pointer-events-none absolute right-2 bottom-0 z-10 h-0.5 translate-y-0.5 rounded-full bg-primary"
              style={{ left: `${(dropIndicatorDepth ?? flatNode.depth) * 18 + 8}px` }}
            />
          )}
          {flatNode.depth > 0 && (
            <span className="pointer-events-none absolute top-0 bottom-1/2 left-[9px] border-l border-border" />
          )}
          <button
            type="button"
            title={dragEnabled ? t('editor.dragHint') : t('editor.dragDisabledHint')}
            className={cn(
              'group flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 pr-8 text-left transition-colors',
              selected ? 'bg-emerald-500/10 text-foreground' : 'hover:bg-accent',
              isParallel && !selected && 'bg-violet-500/[0.035]',
              dropPlacement === 'inside' && 'bg-violet-500/15 ring-1 ring-violet-500/60'
            )}
            onClick={(): void => onSelect(node.id)}
          >
            <span
              data-drag-handle
              className={cn(
                'flex shrink-0',
                dragEnabled && 'touch-none cursor-grab active:cursor-grabbing'
              )}
              title={dragEnabled ? t('editor.dragHandle') : undefined}
            >
              <GripVertical className="size-3 text-muted-foreground/45" />
            </span>
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-sm',
                TONE_CLASS_NAMES[presentation.tone]
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{node.type}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {formatNodeSummary(node)}
              </span>
            </span>
            {(active || (!hasActiveSnippets && selected)) && (
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            )}
          </button>
          {isParallel && (
            <button
              type="button"
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={expanded ? t('editor.collapseParallel') : t('editor.expandParallel')}
              title={expanded ? t('editor.collapseParallel') : t('editor.expandParallel')}
              data-no-drag
              onClick={(): void => onToggleParallel(node.id)}
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          )}
          {isParallel && flatNode.childCount > 0 && (
            <span className="absolute right-9 bottom-1 font-mono text-[9px] text-violet-700/80">
              {flatNode.childCount}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 font-medium select-none">
        <ContextMenuItem onClick={(): void => onPreview(node.id)}>
          <Play />
          {t('editor.previewFromHere')}
        </ContextMenuItem>
        <ContextMenuItem onClick={(): void => onDuplicate(node.id)}>
          <Copy />
          {t('editor.copySnippet')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!dragEnabled || !contextMoves.up}
          onClick={(): void => moveTo(contextMoves.up)}
        >
          <ArrowUp />
          {t('editor.moveUp')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!dragEnabled || !contextMoves.down}
          onClick={(): void => moveTo(contextMoves.down)}
        >
          <ArrowDown />
          {t('editor.moveDown')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!dragEnabled || !contextMoves.indent}
          onClick={(): void => moveTo(contextMoves.indent)}
        >
          <IndentIncrease />
          {t('editor.moveIntoParallel')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!dragEnabled || !contextMoves.outdent}
          onClick={(): void => moveTo(contextMoves.outdent)}
        >
          <IndentDecrease />
          {t('editor.moveOutParallel')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={(): void => onDelete(node.id)}>
          <Trash2 />
          {t('editor.deleteSnippet')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function resolveDropPlacement(
  clientY: number,
  bounds: DOMRect | undefined,
  target: FlatTreeNode
): SnippetDropPlacement {
  if (!bounds || bounds.height <= 0) return 'after'
  const relativeY: number = (clientY - bounds.top) / bounds.height

  if (target.node.type !== 'Parallel') return relativeY < 0.5 ? 'before' : 'after'
  if (relativeY < 0.28) return 'before'
  if (relativeY > 0.72) return 'after'
  return 'inside'
}

function resolveContextMoves(
  nodes: readonly FlatTreeNode[],
  source: FlatTreeNode
): StoryContextMoves {
  const siblingIndex: number | undefined = source.path.at(-1)
  const parentPath: readonly number[] = source.path.slice(0, -1)
  if (siblingIndex === undefined) {
    return { up: null, down: null, indent: null, outdent: null }
  }

  const previousSibling: FlatTreeNode | undefined = findTreeNodeAtPath(nodes, [
    ...parentPath,
    siblingIndex - 1
  ])
  const nextSibling: FlatTreeNode | undefined = findTreeNodeAtPath(nodes, [
    ...parentPath,
    siblingIndex + 1
  ])
  const parent: FlatTreeNode | undefined =
    parentPath.length > 0 ? findTreeNodeAtPath(nodes, parentPath) : undefined

  return {
    up: previousSibling ? { nodeId: previousSibling.node.id, placement: 'before' } : null,
    down: nextSibling ? { nodeId: nextSibling.node.id, placement: 'after' } : null,
    indent:
      previousSibling?.node.type === 'Parallel'
        ? { nodeId: previousSibling.node.id, placement: 'inside' }
        : null,
    outdent:
      parent?.node.type === 'Parallel' ? { nodeId: parent.node.id, placement: 'after' } : null
  }
}

function resolveOutdentTarget(
  clientX: number,
  treeBounds: DOMRect | undefined,
  source: FlatTreeNode,
  target: FlatTreeNode | undefined,
  nodes: readonly FlatTreeNode[]
): StoryDropTarget | null {
  if (source.depth === 0 || !treeBounds) return null

  const outdentThreshold: number = treeBounds.left + 12 + source.depth * 18
  if (clientX >= outdentThreshold) return null

  const parentPath: readonly number[] = source.path.slice(0, -1)
  const parent: FlatTreeNode | undefined = nodes.find((candidate: FlatTreeNode): boolean =>
    pathsEqual(candidate.path, parentPath)
  )
  if (!parent || parent.node.type !== 'Parallel') return null
  if (
    target &&
    (target.node.id === parent.node.id || !isPathDescendant(target.path, parent.path))
  ) {
    return null
  }

  const lastDescendant: FlatTreeNode =
    findLastTreeNode(nodes, (candidate: FlatTreeNode): boolean =>
      isPathDescendant(candidate.path, parent.path)
    ) ?? parent

  return {
    nodeId: parent.node.id,
    placement: 'after',
    indicatorNodeId: lastDescendant.node.id,
    indicatorPlacement: 'after',
    indicatorDepth: parent.depth
  }
}

function resolveRootEndTarget(
  clientY: number,
  tree: HTMLDivElement | null,
  source: FlatTreeNode,
  nodes: readonly FlatTreeNode[]
): StoryDropTarget | null {
  const rowElements: HTMLElement[] = tree
    ? Array.from(tree.querySelectorAll<HTMLElement>('[data-snippet-id]'))
    : []
  const lastRow: HTMLElement | undefined = rowElements.at(-1)
  if (!lastRow || clientY <= lastRow.getBoundingClientRect().bottom + 4) return null

  const lastRootNode: FlatTreeNode | undefined = findLastTreeNode(
    nodes,
    (candidate: FlatTreeNode): boolean => candidate.depth === 0
  )
  const lastVisibleNode: FlatTreeNode | undefined = nodes.at(-1)
  if (!lastRootNode || !lastVisibleNode || lastRootNode.node.id === source.node.id) return null

  return {
    nodeId: lastRootNode.node.id,
    placement: 'after',
    indicatorNodeId: lastVisibleNode.node.id,
    indicatorPlacement: 'after',
    indicatorDepth: 0
  }
}

function isPathDescendant(path: readonly number[], ancestorPath: readonly number[]): boolean {
  return (
    path.length > ancestorPath.length &&
    ancestorPath.every((index: number, depth: number): boolean => path[depth] === index)
  )
}

function pathsEqual(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((index: number, depth: number): boolean => index === right[depth])
  )
}

function findTreeNodeAtPath(
  nodes: readonly FlatTreeNode[],
  path: readonly number[]
): FlatTreeNode | undefined {
  return nodes.find((candidate: FlatTreeNode): boolean => pathsEqual(candidate.path, path))
}

function findLastTreeNode(
  nodes: readonly FlatTreeNode[],
  predicate: (node: FlatTreeNode) => boolean
): FlatTreeNode | undefined {
  for (let index: number = nodes.length - 1; index >= 0; index -= 1) {
    const node: FlatTreeNode = nodes[index]
    if (predicate(node)) return node
  }
  return undefined
}

function AssetLibrary({
  assets,
  query,
  selectedAsset,
  onSelect,
  onImport,
  onRegisterModel
}: {
  assets: ProjectAssets
  query: string
  selectedAsset: EditorAssetSelection | null
  onSelect: (selection: EditorAssetSelection) => void
  onImport: (kind: Exclude<ProjectAssetKind, 'models'>) => void
  onRegisterModel: () => void
}): JSX.Element {
  const normalizedQuery: string = query.trim().toLocaleLowerCase()
  const kinds: readonly ProjectAssetKind[] = ['backgrounds', 'models', 'voices']

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
      {kinds.map((kind: ProjectAssetKind): JSX.Element => {
        const items = getAssetItems(assets, kind).filter(
          (item): boolean =>
            !normalizedQuery ||
            item.name.toLocaleLowerCase().includes(normalizedQuery) ||
            item.detail.toLocaleLowerCase().includes(normalizedQuery)
        )
        return (
          <AssetGroup
            key={kind}
            kind={kind}
            items={items}
            selectedAsset={selectedAsset}
            onSelect={onSelect}
            onImport={onImport}
            onRegisterModel={onRegisterModel}
          />
        )
      })}
    </div>
  )
}

function AssetGroup({
  kind,
  items,
  selectedAsset,
  onSelect,
  onImport,
  onRegisterModel
}: {
  kind: ProjectAssetKind
  items: readonly ReturnType<typeof getAssetItems>[number][]
  selectedAsset: EditorAssetSelection | null
  onSelect: (selection: EditorAssetSelection) => void
  onImport: (kind: Exclude<ProjectAssetKind, 'models'>) => void
  onRegisterModel: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const actionLabel: string = kind === 'models' ? t('common.register') : t('common.import')
  const ActionIcon: LucideIcon =
    kind === 'models' ? UserPlus : kind === 'backgrounds' ? ImagePlus : Volume2

  return (
    <section className="mb-4">
      <div className="mb-2 flex h-7 items-center px-2 text-xs text-muted-foreground">
        <span>{localizeAssetKind(kind)}</span>
        <span className="ml-1 font-mono text-[10px]">{items.length}</span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] hover:bg-accent hover:text-foreground"
          onClick={(): void => {
            if (kind === 'models') {
              onRegisterModel()
            } else {
              onImport(kind)
            }
          }}
        >
          <ActionIcon className="size-3" />
          {actionLabel}
        </button>
      </div>
      {items.length > 0 ? (
        <div className="space-y-0.5">
          {items.map((item): JSX.Element => {
            const selected: boolean =
              selectedAsset?.kind === item.kind && selectedAsset.key === item.key
            return (
              <button
                key={`${item.kind}:${item.key}`}
                type="button"
                className={cn(
                  'flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors',
                  selected ? 'bg-amber-500/10' : 'hover:bg-accent'
                )}
                onClick={(): void => onSelect({ kind: item.kind, key: item.key })}
              >
                <AssetIcon kind={item.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{item.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {item.detail}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(): void => {
            if (kind === 'models') {
              onRegisterModel()
            } else {
              onImport(kind)
            }
          }}
        >
          <FolderPlus className="size-3.5" />
          {t('editor.addFirstAsset', { action: actionLabel, kind: localizeAssetKind(kind) })}
        </button>
      )}
    </section>
  )
}

function AssetIcon({ kind }: { kind: ProjectAssetKind }): JSX.Element {
  const Icon: LucideIcon =
    kind === 'models' ? UserPlus : kind === 'backgrounds' ? ImagePlus : Volume2
  const tone = kind === 'models' ? 'model' : kind === 'backgrounds' ? 'scene' : 'dialogue'
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-sm',
        TONE_CLASS_NAMES[tone]
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

function AddSnippetDialog({
  open,
  assets,
  onOpenChange,
  onAdd
}: {
  open: boolean
  assets: ProjectAssets
  onOpenChange: (open: boolean) => void
  onAdd: (type: AddableSnippetType) => void
}): JSX.Element {
  const { t } = useTranslation()
  const desktopRuntime: boolean = isDesktopRuntime()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState<string>('')
  const normalizedQuery: string = query.trim().toLocaleLowerCase()
  const filteredDefinitions: readonly BuiltinSnippetDefinition[] = builtinSnippetDefinitions.filter(
    (definition: BuiltinSnippetDefinition): boolean => {
      if (!normalizedQuery) return true
      return [
        definition.type,
        definition.label,
        localizeSnippetCategory(definition.category),
        localizeSnippetDescription(definition)
      ].some((value: string): boolean => value.toLocaleLowerCase().startsWith(normalizedQuery))
    }
  )
  const categories: readonly string[] = Array.from(
    new Set(
      filteredDefinitions.map((definition: BuiltinSnippetDefinition): string => definition.category)
    )
  )

  useEffect((): void => {
    if (!open) {
      setQuery('')
    }
  }, [open])

  function missingAssetKindsFor(definition: BuiltinSnippetDefinition): StoryAssetKind[] {
    return Array.from(
      new Set(
        definition.fields.flatMap((field): StoryAssetKind[] =>
          field.kind === 'asset' &&
          !('optional' in field && field.optional) &&
          Object.keys(assets[field.assetKind]).length === 0
            ? [field.assetKind]
            : []
        )
      )
    )
  }

  function addFirstMatch(): void {
    const firstMatch: BuiltinSnippetDefinition | undefined = filteredDefinitions[0]
    if (firstMatch && missingAssetKindsFor(firstMatch).length === 0) onAdd(firstMatch.type)
  }

  const selectableDefinitions: readonly BuiltinSnippetDefinition[] = filteredDefinitions.filter(
    (definition: BuiltinSnippetDefinition): boolean => missingAssetKindsFor(definition).length === 0
  )

  function focusDefinition(dialogContent: HTMLElement, type: AddableSnippetType): void {
    const button: HTMLButtonElement | undefined = Array.from(
      dialogContent.querySelectorAll<HTMLButtonElement>('[data-snippet-option]')
    ).find((element: HTMLButtonElement): boolean => element.dataset.snippetOption === type)
    button?.focus()
  }

  function focusFirstSelectableDefinition(dialogContent: HTMLElement): void {
    const firstDefinition: BuiltinSnippetDefinition | undefined = selectableDefinitions[0]
    if (firstDefinition) focusDefinition(dialogContent, firstDefinition.type)
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const dialogContent: HTMLElement | null = event.currentTarget.closest<HTMLElement>(
        '[data-slot="dialog-content"]'
      )
      if (dialogContent) focusFirstSelectableDefinition(dialogContent)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      addFirstMatch()
    }
  }

  function handleDefinitionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    type: AddableSnippetType
  ): void {
    const currentIndex: number = selectableDefinitions.findIndex(
      (definition: BuiltinSnippetDefinition): boolean => definition.type === type
    )
    if (currentIndex < 0) return

    let nextIndex: number = currentIndex
    if (event.key === 'ArrowLeft') nextIndex -= 1
    if (event.key === 'ArrowRight') nextIndex += 1
    if (event.key === 'ArrowUp') nextIndex -= 2
    if (event.key === 'ArrowDown') nextIndex += 2

    if (event.key === 'ArrowUp' && nextIndex < 0) {
      event.preventDefault()
      event.currentTarget
        .closest<HTMLElement>('[data-slot="dialog-content"]')
        ?.querySelector<HTMLInputElement>('[data-snippet-search]')
        ?.focus()
      return
    }
    if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= selectableDefinitions.length)
      return

    event.preventDefault()
    const dialogContent: HTMLElement | null = event.currentTarget.closest<HTMLElement>(
      '[data-slot="dialog-content"]'
    )
    if (dialogContent) focusDefinition(dialogContent, selectableDefinitions[nextIndex].type)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[80vh] max-w-[640px] overflow-hidden select-none',
          desktopRuntime ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'
        )}
        onOpenAutoFocus={(event: Event): void => {
          if (!desktopRuntime) return
          event.preventDefault()
          searchInputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('editor.addSnippet')}</DialogTitle>
          <DialogDescription>{t('editor.addDialogDescription')}</DialogDescription>
        </DialogHeader>
        {desktopRuntime ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              data-snippet-search
              aria-label={t('editor.searchAddableSnippets')}
              placeholder={t('editor.searchAddableSnippets')}
              value={query}
              className="h-9 pl-8 text-sm"
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                setQuery(event.currentTarget.value)
              }
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        ) : null}
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-1 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
          {categories.length > 0 ? (
            categories.map((category: string): JSX.Element => {
              const definitions: readonly BuiltinSnippetDefinition[] = filteredDefinitions.filter(
                (definition): boolean => definition.category === category
              )
              return (
                <section key={category}>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {localizeSnippetCategory(definitions[0].category)}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {definitions.map((definition): JSX.Element => {
                      const presentation: NodePresentation = NODE_PRESENTATIONS[definition.type]
                      const Icon: LucideIcon = presentation.icon
                      const missingAssetKinds: StoryAssetKind[] = missingAssetKindsFor(definition)
                      const unavailableMessage: string = missingAssetKinds
                        .map((kind: StoryAssetKind): string => localizeAssetKind(kind))
                        .join('、')
                      return (
                        <button
                          key={definition.type}
                          type="button"
                          data-snippet-option={definition.type}
                          data-tour={definition.type === 'Talk' ? 'editor-add-talk' : undefined}
                          className="flex min-w-0 items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                          disabled={missingAssetKinds.length > 0}
                          title={
                            missingAssetKinds.length > 0
                              ? t('editor.addRequiredAssets', { kinds: unavailableMessage })
                              : undefined
                          }
                          onClick={(): void => onAdd(definition.type)}
                          onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>): void =>
                            handleDefinitionKeyDown(event, definition.type)
                          }
                        >
                          <span
                            className={cn(
                              'flex size-8 shrink-0 items-center justify-center rounded-sm',
                              TONE_CLASS_NAMES[presentation.tone]
                            )}
                          >
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {definition.label}
                            </span>
                            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                              {missingAssetKinds.length > 0
                                ? t('editor.requiresAssets', { kinds: unavailableMessage })
                                : localizeSnippetDescription(definition)}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('editor.noMatchingSnippets')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
