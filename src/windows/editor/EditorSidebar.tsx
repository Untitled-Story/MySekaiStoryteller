import type { ChangeEvent, JSX } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GripVertical,
  ImagePlus,
  LibraryBig,
  Plus,
  Search,
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
import { builtinSnippetDefinitions, type StoryAssetKind } from '@/story'
import type { ProjectAssetKind, ProjectAssets } from '@/project/assets'
import { cn } from '@/lib/style'
import {
  ASSET_KIND_LABELS,
  getAssetItems,
  NODE_PRESENTATIONS,
  TONE_CLASS_NAMES,
  type EditorAssetSelection,
  type FlatTreeNode,
  type NodePresentation
} from './editorCatalog'
import { formatNodeSummary } from './editorCatalog'
import type { AddableSnippetType, EditorNode } from './editorDocument'

export type EditorSidebarTab = 'story' | 'assets'

export function EditorSidebar({
  activePanel,
  searchQuery,
  treeNodes,
  selectedNodeId,
  expandedParallelIds,
  assets,
  selectedAsset,
  addDialogOpen,
  onActivePanelChange,
  onSearchQueryChange,
  onSelectNode,
  onToggleParallel,
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
  expandedParallelIds: ReadonlySet<string>
  assets: ProjectAssets
  selectedAsset: EditorAssetSelection | null
  addDialogOpen: boolean
  onActivePanelChange: (panel: EditorSidebarTab) => void
  onSearchQueryChange: (query: string) => void
  onSelectNode: (nodeId: string) => void
  onToggleParallel: (nodeId: string) => void
  onSelectAsset: (selection: EditorAssetSelection) => void
  onAddDialogOpenChange: (open: boolean) => void
  onAddSnippet: (type: AddableSnippetType) => void
  onImportAsset: (kind: Exclude<ProjectAssetKind, 'models'>) => void
  onRegisterModel: () => void
}): JSX.Element {
  const searchLabel: string = activePanel === 'story' ? '搜索片段' : '搜索资源'

  return (
    <aside className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r bg-muted/20">
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <div className="flex h-8 items-center rounded-md bg-muted p-0.5">
          <TabButton
            active={activePanel === 'story'}
            label="故事"
            onClick={(): void => onActivePanelChange('story')}
          />
          <TabButton
            active={activePanel === 'assets'}
            label="资源"
            onClick={(): void => onActivePanelChange('assets')}
          />
        </div>
        {activePanel === 'story' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-8"
            aria-label="添加片段"
            title="添加片段"
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
          expandedParallelIds={expandedParallelIds}
          onSelect={onSelectNode}
          onToggleParallel={onToggleParallel}
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
        'h-7 rounded-sm px-3 text-xs transition-colors',
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
  expandedParallelIds,
  onSelect,
  onToggleParallel,
  onAdd
}: {
  nodes: readonly FlatTreeNode[]
  selectedNodeId: string | null
  expandedParallelIds: ReadonlySet<string>
  onSelect: (nodeId: string) => void
  onToggleParallel: (nodeId: string) => void
  onAdd: () => void
}): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
      <div className="space-y-0.5">
        {nodes.map(
          (flatNode: FlatTreeNode): JSX.Element => (
            <StoryNodeRow
              key={flatNode.node.id}
              flatNode={flatNode}
              selected={flatNode.node.id === selectedNodeId}
              expanded={expandedParallelIds.has(flatNode.node.id)}
              onSelect={onSelect}
              onToggleParallel={onToggleParallel}
            />
          )
        )}
      </div>
      {nodes.length === 0 && (
        <div className="px-2 pt-8 text-center text-xs text-muted-foreground">当前场景没有片段</div>
      )}
      <button
        type="button"
        className="mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onAdd}
      >
        <Plus className="size-3.5" />
        添加片段
      </button>
    </div>
  )
}

function StoryNodeRow({
  flatNode,
  selected,
  expanded,
  onSelect,
  onToggleParallel
}: {
  flatNode: FlatTreeNode
  selected: boolean
  expanded: boolean
  onSelect: (nodeId: string) => void
  onToggleParallel: (nodeId: string) => void
}): JSX.Element {
  const node: EditorNode = flatNode.node
  const presentation: NodePresentation = NODE_PRESENTATIONS[node.type]
  const Icon: LucideIcon = presentation.icon
  const isParallel: boolean = node.type === 'Parallel'

  return (
    <div className="relative" style={{ paddingLeft: `${flatNode.depth * 18}px` }}>
      {flatNode.depth > 0 && (
        <span className="pointer-events-none absolute top-0 bottom-1/2 left-[9px] border-l border-border" />
      )}
      <button
        type="button"
        className={cn(
          'group flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 pr-8 text-left transition-colors',
          selected ? 'bg-emerald-500/10 text-foreground' : 'hover:bg-accent',
          isParallel && !selected && 'bg-violet-500/[0.035]'
        )}
        onClick={(): void => onSelect(node.id)}
      >
        <GripVertical className="size-3 shrink-0 text-muted-foreground/45" />
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
        {selected && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
      </button>
      {isParallel && (
        <button
          type="button"
          className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={expanded ? '收起 Parallel' : '展开 Parallel'}
          title={expanded ? '收起 Parallel' : '展开 Parallel'}
          onClick={(): void => onToggleParallel(node.id)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      )}
      {isParallel && flatNode.childCount > 0 && (
        <span className="absolute right-9 bottom-1 font-mono text-[9px] text-violet-700/80">
          {flatNode.childCount}
        </span>
      )}
    </div>
  )
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
  const actionLabel: string = kind === 'models' ? '注册' : '导入'
  const ActionIcon: LucideIcon =
    kind === 'models' ? UserPlus : kind === 'backgrounds' ? ImagePlus : Volume2

  return (
    <section className="mb-4">
      <div className="mb-2 flex h-7 items-center px-2 text-xs text-muted-foreground">
        <span>{ASSET_KIND_LABELS[kind]}</span>
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
          {actionLabel}第一个{ASSET_KIND_LABELS[kind]}
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
  const categories: readonly string[] = Array.from(
    new Set(builtinSnippetDefinitions.map((definition): string => definition.category))
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-[640px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden select-none">
        <DialogHeader>
          <DialogTitle>添加片段</DialogTitle>
          <DialogDescription>
            选中 Parallel 时会将新片段作为其子项；其余情况插入到选中项之后。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-1 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
          {categories.map((category: string): JSX.Element => {
            const definitions = builtinSnippetDefinitions.filter(
              (definition): boolean => definition.category === category
            )
            return (
              <section key={category}>
                <p className="mb-2 text-xs font-medium text-muted-foreground">{category}</p>
                <div className="grid grid-cols-2 gap-2">
                  {definitions.map((definition): JSX.Element => {
                    const presentation: NodePresentation = NODE_PRESENTATIONS[definition.type]
                    const Icon: LucideIcon = presentation.icon
                    const missingAssetKinds: StoryAssetKind[] = Array.from(
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
                    const unavailableMessage: string = missingAssetKinds
                      .map((kind: StoryAssetKind): string => ASSET_KIND_LABELS[kind])
                      .join('、')
                    return (
                      <button
                        key={definition.type}
                        type="button"
                        className="flex min-w-0 items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                        disabled={missingAssetKinds.length > 0}
                        title={
                          missingAssetKinds.length > 0
                            ? `请先添加${unavailableMessage}资源`
                            : undefined
                        }
                        onClick={(): void => onAdd(definition.type)}
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
                              ? `需要先添加${unavailableMessage}资源`
                              : definition.description}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
