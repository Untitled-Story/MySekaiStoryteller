import type { LucideIcon } from 'lucide-react'
import {
  AlignJustify,
  AudioLines,
  CircleDot,
  EyeOff,
  ImageIcon,
  Layers3,
  MoveRight,
  PlaySquare,
  SlidersHorizontal,
  Sparkles,
  UserRound
} from 'lucide-react'
import { getBuiltinSnippetDefinition } from '@/story'
import type { ProjectAssetKind, ProjectAssets } from '@/project/assets'
import type { EditorNode, EditorStory } from './editorDocument'

export type NodeTone = 'scene' | 'model' | 'dialogue' | 'parallel' | 'overlay'

export type NodePresentation = {
  icon: LucideIcon
  tone: NodeTone
}

export type FlatTreeNode = {
  node: EditorNode
  depth: number
  path: readonly number[]
  childCount: number
}

export type EditorAssetSelection = {
  kind: ProjectAssetKind
  key: string
}

export type EditorAssetItem = EditorAssetSelection & {
  name: string
  detail: string
}

export const NODE_PRESENTATIONS: Record<EditorNode['type'], NodePresentation> = {
  ChangeLayoutMode: { icon: Layers3, tone: 'scene' },
  ChangeBackgroundImage: { icon: ImageIcon, tone: 'scene' },
  Parallel: { icon: AlignJustify, tone: 'parallel' },
  LayoutAppear: { icon: UserRound, tone: 'model' },
  LayoutClear: { icon: EyeOff, tone: 'model' },
  Talk: { icon: AudioLines, tone: 'dialogue' },
  HideTalk: { icon: EyeOff, tone: 'dialogue' },
  Move: { icon: MoveRight, tone: 'model' },
  Motion: { icon: PlaySquare, tone: 'model' },
  Telop: { icon: Sparkles, tone: 'overlay' },
  DoParam: { icon: SlidersHorizontal, tone: 'model' },
  ScreenFadeOut: { icon: CircleDot, tone: 'scene' },
  ScreenFadeIn: { icon: CircleDot, tone: 'scene' }
}

export const TONE_CLASS_NAMES: Record<NodeTone, string> = {
  scene: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  model: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  dialogue: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  parallel: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  overlay: 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
}

export const ASSET_KIND_LABELS: Record<ProjectAssetKind, string> = {
  backgrounds: '背景',
  models: '模型',
  voices: '语音'
}

export function flattenTreeNodes(
  story: EditorStory,
  expandedParallelIds: ReadonlySet<string>
): FlatTreeNode[] {
  const result: FlatTreeNode[] = []

  function visit(nodes: readonly EditorNode[], depth: number, parentPath: readonly number[]): void {
    nodes.forEach((node: EditorNode, index: number): void => {
      const path: readonly number[] = [...parentPath, index]
      const childCount: number = node.type === 'Parallel' ? node.snippets.length : 0
      result.push({ node, depth, path, childCount })
      if (node.type === 'Parallel' && expandedParallelIds.has(node.id)) {
        visit(node.snippets, depth + 1, path)
      }
    })
  }

  visit(story.snippets, 0, [])
  return result
}

export function filterTreeNodes(
  flatNodes: readonly FlatTreeNode[],
  query: string
): readonly FlatTreeNode[] {
  if (!query.trim()) return flatNodes
  const normalizedQuery: string = query.trim().toLocaleLowerCase()

  return flatNodes.filter((flatNode: FlatTreeNode): boolean => {
    const definition = getBuiltinSnippetDefinition(flatNode.node.type)
    return `${definition.label} ${definition.summary(flatNode.node)}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
}

export function formatNodeSummary(node: EditorNode): string {
  return getBuiltinSnippetDefinition(node.type).summary(node)
}

export function formatNodePath(path: readonly number[]): string {
  if (path.length === 0) return '未选择片段'
  return `片段 ${path.map((index: number): string => String(index + 1).padStart(2, '0')).join('.')}`
}

export function getAssetItems(assets: ProjectAssets, kind: ProjectAssetKind): EditorAssetItem[] {
  const entries = Object.entries(assets[kind])
  return entries
    .map(([key, asset]): EditorAssetItem => {
      if (kind === 'models') {
        return {
          kind,
          key,
          name: asset.name ?? key,
          detail: asset.modelId
        }
      }
      return {
        kind,
        key,
        name: asset.name || key,
        detail: asset.path
      }
    })
    .sort((left: EditorAssetItem, right: EditorAssetItem): number =>
      left.name.localeCompare(right.name)
    )
}

export function getAssetOptionLabel(
  assets: ProjectAssets,
  kind: ProjectAssetKind,
  key: string
): string {
  const asset = assets[kind][key]
  if (!asset) return key
  return kind === 'models' ? (asset.name ?? key) : asset.name || key
}
