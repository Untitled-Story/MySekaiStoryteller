import type { ChangeEvent, JSX } from 'react'
import { useEffect, useState } from 'react'
import { Copy, Layers3, Save, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import {
  defaultParameterAnimation,
  getBuiltinSnippetDefinition,
  storyFieldOptions,
  type StorySnippetFieldDefinition
} from '@/story'
import type {
  BackgroundAsset,
  ModelAsset,
  ProjectAssetKind,
  ProjectAssets,
  VoiceAsset
} from '@/project/assets'
import { cn } from '@/lib/style'
import {
  ASSET_KIND_LABELS,
  getAssetItems,
  getAssetOptionLabel,
  NODE_PRESENTATIONS,
  TONE_CLASS_NAMES,
  type EditorAssetSelection
} from './editorCatalog'
import {
  countSnippetSubtree,
  updateSnippetValue,
  type EditorNode,
  type EditorStory
} from './editorDocument'

type ValueAtPath = unknown

export function EditorInspector({
  story,
  selectedNode,
  selectedNodePath,
  assets,
  onStoryChange,
  onInputBlur,
  onDuplicate,
  onDelete
}: {
  story: EditorStory
  selectedNode: EditorNode | null
  selectedNodePath: string
  assets: ProjectAssets
  onStoryChange: (story: EditorStory, mergeKey?: string) => void
  onInputBlur: () => void
  onDuplicate: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-background">
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <SlidersHorizontal className="mr-2 size-4 text-muted-foreground" />
        <span className="text-sm font-medium">属性</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="复制片段"
            title="复制片段"
            disabled={!selectedNode}
            onClick={onDuplicate}
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            aria-label="删除片段"
            title="删除片段"
            disabled={!selectedNode}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
        {selectedNode ? (
          <SnippetInspectorContent
            story={story}
            node={selectedNode}
            path={selectedNodePath}
            assets={assets}
            onStoryChange={onStoryChange}
            onInputBlur={onInputBlur}
          />
        ) : (
          <EmptyInspector />
        )}
      </div>
    </aside>
  )
}

function SnippetInspectorContent({
  story,
  node,
  path,
  assets,
  onStoryChange,
  onInputBlur
}: {
  story: EditorStory
  node: EditorNode
  path: string
  assets: ProjectAssets
  onStoryChange: (story: EditorStory, mergeKey?: string) => void
  onInputBlur: () => void
}): JSX.Element {
  const definition = getBuiltinSnippetDefinition(node.type)
  const presentation = NODE_PRESENTATIONS[node.type]
  const Icon = presentation.icon

  function update(pathSegments: readonly string[], value: unknown, merge = false): void {
    const mergeKey: string | undefined = merge ? `${node.id}:${pathSegments.join('.')}` : undefined
    onStoryChange(updateSnippetValue(story, node.id, pathSegments, value), mergeKey)
  }

  return (
    <>
      <div className="border-b px-4 py-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-md',
              TONE_CLASS_NAMES[presentation.tone]
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{definition.label}</p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{path}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{definition.description}</p>
          </div>
        </div>
      </div>
      <div className="space-y-5 px-4 py-5">
        {definition.fields.map(
          (field: StorySnippetFieldDefinition): JSX.Element => (
            <SnippetField
              key={field.path.join('.')}
              field={field}
              node={node}
              assets={assets}
              onValueChange={update}
              onInputBlur={onInputBlur}
            />
          )
        )}
        {node.type === 'Parallel' && (
          <div className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
            该块包含 {countSnippetSubtree(node) - 1}{' '}
            个子片段；所有子片段会从该块的延迟结束后同时开始。
          </div>
        )}
        <div className="border-t pt-5">
          <FieldLabel label="延迟" />
          <NumberInput
            value={node.delay}
            min={0}
            step={0.1}
            suffix="s"
            onValueChange={(value: number): void => update(['delay'], value)}
            onBlur={onInputBlur}
          />
        </div>
      </div>
    </>
  )
}

function SnippetField({
  field,
  node,
  assets,
  onValueChange,
  onInputBlur
}: {
  field: StorySnippetFieldDefinition
  node: EditorNode
  assets: ProjectAssets
  onValueChange: (path: readonly string[], value: unknown, merge?: boolean) => void
  onInputBlur: () => void
}): JSX.Element {
  const value: ValueAtPath = getValueAtPath(node, field.path)

  if (field.kind === 'text' || field.kind === 'textarea') {
    const textValue: string = typeof value === 'string' ? value : ''
    const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const nextValue: string = event.currentTarget.value
      onValueChange(field.path, field.optional && !nextValue ? undefined : nextValue, true)
    }
    return (
      <FieldGroup label={field.label}>
        {field.kind === 'textarea' ? (
          <textarea
            aria-label={field.label}
            className="min-h-24 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm leading-6 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={textValue}
            placeholder={field.placeholder}
            onChange={onChange}
            onBlur={onInputBlur}
          />
        ) : (
          <Input
            value={textValue}
            placeholder={field.placeholder}
            className="h-8 text-sm"
            onChange={onChange}
            onBlur={onInputBlur}
          />
        )}
      </FieldGroup>
    )
  }

  if (field.kind === 'number') {
    return (
      <FieldGroup label={field.label}>
        <NumberInput
          value={typeof value === 'number' ? value : 0}
          min={field.min}
          step={field.step}
          suffix={field.suffix}
          onValueChange={(nextValue: number): void => onValueChange(field.path, nextValue)}
          onBlur={onInputBlur}
        />
      </FieldGroup>
    )
  }

  if (field.kind === 'select') {
    return (
      <FieldGroup label={field.label}>
        <select
          aria-label={field.label}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={typeof value === 'string' ? value : ''}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
            onValueChange(field.path, event.currentTarget.value)
          }
        >
          {field.options.map(
            (option): JSX.Element => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            )
          )}
        </select>
      </FieldGroup>
    )
  }

  if (field.kind === 'asset') {
    const selectedKey: string = typeof value === 'string' ? value : ''
    const assetOptions = getAssetItems(assets, field.assetKind)
    const hasMissingSelection: boolean =
      Boolean(selectedKey) && !assetOptions.some((asset): boolean => asset.key === selectedKey)
    return (
      <FieldGroup label={field.label}>
        <select
          aria-label={field.label}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={selectedKey}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const nextKey: string = event.currentTarget.value
            onValueChange(field.path, field.optional && !nextKey ? undefined : nextKey)
          }}
        >
          {field.optional && <option value="">未关联{ASSET_KIND_LABELS[field.assetKind]}</option>}
          {hasMissingSelection && <option value={selectedKey}>缺失：{selectedKey}</option>}
          {assetOptions.map(
            (asset): JSX.Element => (
              <option key={asset.key} value={asset.key}>
                {getAssetOptionLabel(assets, field.assetKind, asset.key)} · {asset.key}
              </option>
            )
          )}
        </select>
      </FieldGroup>
    )
  }

  if (field.kind === 'position') {
    const position = isPosition(value) ? value : { side: 'Center', offset: 0 }
    return (
      <FieldGroup label={field.label}>
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <select
            aria-label={`${field.label}位置`}
            className="h-9 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={position.side}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              onValueChange(field.path, { ...position, side: event.currentTarget.value })
            }
          >
            {storyFieldOptions.sides.map(
              (option): JSX.Element => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              )
            )}
          </select>
          <NumberInput
            value={position.offset}
            step={1}
            suffix="px"
            onValueChange={(offset: number): void =>
              onValueChange(field.path, { ...position, offset })
            }
            onBlur={onInputBlur}
          />
        </div>
      </FieldGroup>
    )
  }

  if (field.kind === 'boolean') {
    return (
      <FieldGroup label={field.label}>
        <div className="flex h-9 items-center justify-between rounded-md border px-3">
          <span className="text-xs text-muted-foreground">{value ? '启用' : '关闭'}</span>
          <Switch
            checked={Boolean(value)}
            onCheckedChange={(checked: boolean): void => onValueChange(field.path, checked)}
          />
        </div>
      </FieldGroup>
    )
  }

  if (field.kind === 'color') {
    const color: string = typeof value === 'string' ? value : '#000000'
    return (
      <FieldGroup label={field.label}>
        <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-2 shadow-xs">
          <input
            aria-label={field.label}
            type="color"
            value={color}
            className="size-5 cursor-pointer border-0 bg-transparent p-0"
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              onValueChange(field.path, event.currentTarget.value)
            }
          />
          <span className="font-mono text-xs text-muted-foreground">{color.toUpperCase()}</span>
        </div>
      </FieldGroup>
    )
  }

  return (
    <ParameterFields
      path={field.path}
      value={value}
      onValueChange={onValueChange}
      onInputBlur={onInputBlur}
    />
  )
}

function ParameterFields({
  path,
  value,
  onValueChange,
  onInputBlur
}: {
  path: readonly string[]
  value: unknown
  onValueChange: (path: readonly string[], value: unknown, merge?: boolean) => void
  onInputBlur: () => void
}): JSX.Element {
  const params: ParameterAnimation[] = Array.isArray(value)
    ? value.filter(isParameterAnimation)
    : [defaultParameterAnimation()]

  function updateAt(index: number, patch: Partial<ParameterAnimation>, merge = false): void {
    const next = params.map(
      (param: ParameterAnimation, currentIndex: number): ParameterAnimation =>
        currentIndex === index ? { ...param, ...patch } : param
    )
    onValueChange(path, next, merge)
  }

  return (
    <FieldGroup label="参数动画">
      <div className="space-y-3">
        {params.map(
          (param: ParameterAnimation, index: number): JSX.Element => (
            <div key={`${param.paramId}-${index}`} className="space-y-2 rounded-md border p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="参数 ID"
                  className="h-8 font-mono text-xs"
                  value={param.paramId}
                  placeholder="ParamAngleX"
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    updateAt(index, { paramId: event.currentTarget.value }, true)
                  }
                  onBlur={onInputBlur}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive"
                  aria-label="删除参数"
                  title="删除参数"
                  disabled={params.length === 1}
                  onClick={(): void =>
                    onValueChange(
                      path,
                      params.filter(
                        (_param: ParameterAnimation, currentIndex: number): boolean =>
                          currentIndex !== index
                      )
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={param.start}
                  suffix="起始"
                  onValueChange={(start: number): void => updateAt(index, { start })}
                  onBlur={onInputBlur}
                />
                <NumberInput
                  value={param.end}
                  suffix="结束"
                  onValueChange={(end: number): void => updateAt(index, { end })}
                  onBlur={onInputBlur}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  aria-label="曲线"
                  className="h-9 rounded-md border bg-background px-2 text-xs shadow-xs outline-none"
                  value={param.curve}
                  onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                    updateAt(index, {
                      curve: event.currentTarget.value as ParameterAnimation['curve']
                    })
                  }
                >
                  {storyFieldOptions.curves.map(
                    (option): JSX.Element => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    )
                  )}
                </select>
                <NumberInput
                  value={param.duration}
                  min={0}
                  step={0.1}
                  suffix="s"
                  onValueChange={(duration: number): void => updateAt(index, { duration })}
                  onBlur={onInputBlur}
                />
              </div>
            </div>
          )
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={(): void => onValueChange(path, [...params, defaultParameterAnimation()])}
        >
          <Layers3 className="size-3.5" />
          添加参数
        </Button>
      </div>
    </FieldGroup>
  )
}

type ParameterAnimation = ReturnType<typeof defaultParameterAnimation>

function NumberInput({
  value,
  min,
  step,
  suffix,
  onValueChange,
  onBlur
}: {
  value: number
  min?: number
  step?: number
  suffix?: string
  onValueChange: (value: number) => void
  onBlur: () => void
}): JSX.Element {
  return (
    <div className="relative min-w-0 w-full">
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        step={step ?? 1}
        className={cn('h-9 text-sm', suffix && 'pr-9')}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          const nextValue: number = Number(event.currentTarget.value)
          if (!Number.isFinite(nextValue)) return
          const clampedValue: number =
            typeof min === 'number' ? Math.max(min, nextValue) : nextValue
          onValueChange(clampedValue)
        }}
        onBlur={onBlur}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  )
}

function FieldGroup({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="min-w-0">
      <FieldLabel label={label} />
      {children}
    </div>
  )
}

function FieldLabel({ label }: { label: string }): JSX.Element {
  return <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
}

function EmptyInspector(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-6 text-muted-foreground">
      从故事树中选择一个片段，编辑它的属性。
    </div>
  )
}

export function EditorAssetInspector({
  assets,
  selectedAsset,
  storyDirty,
  onModelChange,
  onFileAssetChange,
  onRename,
  onDelete
}: {
  assets: ProjectAssets
  selectedAsset: EditorAssetSelection | null
  storyDirty: boolean
  onModelChange: (key: string, asset: ModelAsset) => void
  onFileAssetChange: (
    kind: Exclude<ProjectAssetKind, 'models'>,
    key: string,
    asset: BackgroundAsset | VoiceAsset
  ) => void
  onRename: (selection: EditorAssetSelection, newKey: string) => void
  onDelete: (selection: EditorAssetSelection) => void
}): JSX.Element {
  if (!selectedAsset) {
    return (
      <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-background">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Save className="mr-2 size-4 text-muted-foreground" />
          <span className="text-sm font-medium">资源属性</span>
        </div>
        <EmptyInspector />
      </aside>
    )
  }

  const asset = assets[selectedAsset.kind][selectedAsset.key]
  if (!asset) {
    return (
      <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-background">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Save className="mr-2 size-4 text-muted-foreground" />
          <span className="text-sm font-medium">资源属性</span>
        </div>
        <EmptyInspector />
      </aside>
    )
  }

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-background">
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <Save className="mr-2 size-4 text-muted-foreground" />
        <span className="text-sm font-medium">资源属性</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-8 text-destructive hover:text-destructive"
          aria-label="删除资源"
          title="删除资源"
          onClick={(): void => onDelete(selectedAsset)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
        <div className="border-b px-4 py-4">
          <p className="text-xs text-muted-foreground">{ASSET_KIND_LABELS[selectedAsset.kind]}</p>
          <p className="mt-1 break-all font-mono text-sm font-medium">{selectedAsset.key}</p>
        </div>
        <div className="space-y-5 px-4 py-5">
          <AssetKeyField selection={selectedAsset} storyDirty={storyDirty} onRename={onRename} />
          {selectedAsset.kind === 'models' ? (
            <ModelAssetFields
              asset={asset as ModelAsset}
              onChange={(nextAsset: ModelAsset): void =>
                onModelChange(selectedAsset.key, nextAsset)
              }
            />
          ) : (
            <FileAssetFields
              asset={asset as BackgroundAsset | VoiceAsset}
              onChange={(nextAsset: BackgroundAsset | VoiceAsset): void =>
                onFileAssetChange(
                  selectedAsset.kind as Exclude<ProjectAssetKind, 'models'>,
                  selectedAsset.key,
                  nextAsset
                )
              }
            />
          )}
        </div>
      </div>
    </aside>
  )
}

function AssetKeyField({
  selection,
  storyDirty,
  onRename
}: {
  selection: EditorAssetSelection
  storyDirty: boolean
  onRename: (selection: EditorAssetSelection, newKey: string) => void
}): JSX.Element {
  const [keyDraft, setKeyDraft] = useState<string>(selection.key)

  useEffect((): void => {
    setKeyDraft(selection.key)
  }, [selection.key])

  return (
    <FieldGroup label="资源键">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input
          value={keyDraft}
          className="h-9 min-w-0 font-mono text-xs"
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            setKeyDraft(event.currentTarget.value)
          }
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={storyDirty || keyDraft === selection.key}
          onClick={(): void => onRename(selection, keyDraft)}
        >
          改名
        </Button>
      </div>
    </FieldGroup>
  )
}

function ModelAssetFields({
  asset,
  onChange
}: {
  asset: ModelAsset
  onChange: (asset: ModelAsset) => void
}): JSX.Element {
  return (
    <>
      <FieldGroup label="显示名称">
        <Input
          value={asset.name ?? ''}
          className="h-9 text-sm"
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange({ ...asset, name: event.currentTarget.value || undefined })
          }
        />
      </FieldGroup>
      <FieldGroup label="全局模型 ID">
        <Input
          value={asset.modelId}
          readOnly
          className="h-9 font-mono text-xs text-muted-foreground"
        />
      </FieldGroup>
      <FieldGroup label="普通布局缩放">
        <NumberInput
          value={asset.normalScale}
          step={0.1}
          onValueChange={(normalScale: number): void => onChange({ ...asset, normalScale })}
          onBlur={noop}
        />
      </FieldGroup>
      <FieldGroup label="三人布局缩放">
        <NumberInput
          value={asset.smallScale}
          step={0.1}
          onValueChange={(smallScale: number): void => onChange({ ...asset, smallScale })}
          onBlur={noop}
        />
      </FieldGroup>
      <FieldGroup label="锚点">
        <NumberInput
          value={asset.anchor}
          step={0.05}
          onValueChange={(anchor: number): void => onChange({ ...asset, anchor })}
          onBlur={noop}
        />
      </FieldGroup>
    </>
  )
}

function FileAssetFields({
  asset,
  onChange
}: {
  asset: BackgroundAsset | VoiceAsset
  onChange: (asset: BackgroundAsset | VoiceAsset) => void
}): JSX.Element {
  return (
    <>
      <FieldGroup label="显示名称">
        <Input
          value={asset.name}
          className="h-9 text-sm"
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange({ ...asset, name: event.currentTarget.value })
          }
        />
      </FieldGroup>
      <FieldGroup label="项目内路径">
        <Input
          value={asset.path}
          readOnly
          className="h-9 font-mono text-xs text-muted-foreground"
        />
      </FieldGroup>
    </>
  )
}

function getValueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function isPosition(value: unknown): value is { side: string; offset: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.side === 'string' && typeof record.offset === 'number'
}

function isParameterAnimation(value: unknown): value is ParameterAnimation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.paramId === 'string' &&
    typeof record.start === 'number' &&
    typeof record.end === 'number' &&
    typeof record.curve === 'string' &&
    typeof record.duration === 'number'
  )
}

function noop(): void {}
