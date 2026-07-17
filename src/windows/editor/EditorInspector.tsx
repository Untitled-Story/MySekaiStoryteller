import type {
  ChangeEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Copy, Layers3, Save, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import {
  createBuiltinVisualEffectRegistry,
  defaultParameterAnimation,
  getBuiltinSnippetDefinition,
  storyFieldOptions,
  type StorySnippetFieldDefinition,
  type StoryVisualEffectTargetType
} from '@/story'
import type {
  BackgroundAsset,
  ModelAsset,
  ProjectAssetKind,
  ProjectAssets,
  VoiceAsset
} from '@/project/assets'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { VisualEffectData } from '@/story/schema'
import { cn } from '@/lib/style'
import { fuzzyMatchOptions } from '@/lib/fuzzyMatch'
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
  findAppliedEffectsBeforeNode,
  findEditorNodePath,
  updateSnippetValue,
  type EditorAppliedEffect,
  type EditorNode,
  type EditorStory
} from './editorDocument'
import { useTranslation } from 'react-i18next'
import {
  localizeSnippetDescription,
  localizeSnippetFieldLabel,
  localizeSnippetOptionLabel,
  localizeSnippetPlaceholder
} from './editorLocalization'

type ValueAtPath = unknown

const EDITOR_VISUAL_EFFECT_REGISTRY = createBuiltinVisualEffectRegistry()

export function EditorInspector({
  story,
  selectedNode,
  selectedNodePath,
  assets,
  modelRegistry,
  onStoryChange,
  onInputBlur,
  onDuplicate,
  onDelete
}: {
  story: EditorStory
  selectedNode: EditorNode | null
  selectedNodePath: string
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  onStoryChange: (story: EditorStory, mergeKey?: string) => void
  onInputBlur: () => void
  onDuplicate: () => void
  onDelete: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <aside
      data-tour="editor-inspector"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-background"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <SlidersHorizontal className="mr-2 size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('editor.inspector')}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('editor.copySnippet')}
            title={t('editor.copySnippet')}
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
            aria-label={t('editor.deleteSnippet')}
            title={t('editor.deleteSnippet')}
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
            modelRegistry={modelRegistry}
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
  modelRegistry,
  onStoryChange,
  onInputBlur
}: {
  story: EditorStory
  node: EditorNode
  path: string
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  onStoryChange: (story: EditorStory, mergeKey?: string) => void
  onInputBlur: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const definition = getBuiltinSnippetDefinition(node.type)
  const presentation = NODE_PRESENTATIONS[node.type]
  const Icon = presentation.icon
  const standardFields: readonly StorySnippetFieldDefinition[] = definition.fields.filter(
    (field: StorySnippetFieldDefinition): boolean => !field.advanced
  )
  const advancedFields: readonly StorySnippetFieldDefinition[] = definition.fields.filter(
    (field: StorySnippetFieldDefinition): boolean => Boolean(field.advanced)
  )

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
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {localizeSnippetDescription(definition)}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-5 px-4 py-5">
        {standardFields.map(
          (field: StorySnippetFieldDefinition, index: number): JSX.Element => (
            <SnippetField
              key={`${field.kind}:${field.path.join('.')}:${index}`}
              field={field}
              story={story}
              node={node}
              assets={assets}
              modelRegistry={modelRegistry}
              onValueChange={update}
              onInputBlur={onInputBlur}
            />
          )
        )}
        {advancedFields.length > 0 && (
          <details className="group overflow-hidden rounded-md border bg-muted/15">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              {t('editor.advanced')}
            </summary>
            <div className="space-y-4 border-t px-3 py-3">
              {advancedFields.map(
                (field: StorySnippetFieldDefinition, index: number): JSX.Element => (
                  <SnippetField
                    key={`${field.kind}:${field.path.join('.')}:advanced:${index}`}
                    field={field}
                    story={story}
                    node={node}
                    assets={assets}
                    modelRegistry={modelRegistry}
                    onValueChange={update}
                    onInputBlur={onInputBlur}
                  />
                )
              )}
            </div>
          </details>
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
  story,
  node,
  assets,
  modelRegistry,
  onValueChange,
  onInputBlur
}: {
  field: StorySnippetFieldDefinition
  story: EditorStory
  node: EditorNode
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  onValueChange: (path: readonly string[], value: unknown, merge?: boolean) => void
  onInputBlur: () => void
}): JSX.Element {
  const localizedLabel: string = localizeSnippetFieldLabel(field.label)
  const value: ValueAtPath = getValueAtPath(node, field.path)

  if (field.kind === 'effect-reference') {
    const selectedEffectId: string = typeof value === 'string' ? value : ''
    const availableEffects: EditorAppliedEffect[] = findAppliedEffectsBeforeNode(story, node.id)
    const hasMissingSelection: boolean =
      Boolean(selectedEffectId) &&
      !availableEffects.some(
        (effectNode: EditorAppliedEffect): boolean => effectNode.data.effectId === selectedEffectId
      )

    return (
      <FieldGroup label={localizedLabel}>
        <select
          aria-label={localizedLabel}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={selectedEffectId}
          disabled={availableEffects.length === 0 && !hasMissingSelection}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
            onValueChange(field.path, event.currentTarget.value)
          }
        >
          {availableEffects.length === 0 && !hasMissingSelection && (
            <option value="">前面没有可移除的效果</option>
          )}
          {hasMissingSelection && (
            <option value={selectedEffectId}>未找到：{selectedEffectId}</option>
          )}
          {availableEffects.map(
            (effectNode: EditorAppliedEffect): JSX.Element => (
              <option key={effectNode.id} value={effectNode.data.effectId}>
                {effectReferenceLabel(story, effectNode)}
              </option>
            )
          )}
        </select>
      </FieldGroup>
    )
  }

  if (field.kind === 'model-motion') {
    const textValue: string = typeof value === 'string' ? value : ''
    const options: readonly string[] = getModelMotionOptions(
      node,
      assets,
      modelRegistry,
      field.catalog
    )
    return (
      <FieldGroup label={localizedLabel}>
        <FuzzyCombobox
          label={localizedLabel}
          value={textValue}
          options={options}
          placeholder={localizeSnippetPlaceholder(field.placeholder)}
          emptyText={options.length === 0 ? '当前模型没有可用索引' : '没有匹配项，将保留自定义值'}
          onChange={(nextValue: string): void =>
            onValueChange(field.path, field.optional && !nextValue ? undefined : nextValue, true)
          }
          onBlur={onInputBlur}
        />
      </FieldGroup>
    )
  }

  if (field.kind === 'text' || field.kind === 'textarea') {
    const textValue: string = typeof value === 'string' ? value : ''
    const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const nextValue: string = event.currentTarget.value
      onValueChange(field.path, field.optional && !nextValue ? undefined : nextValue, true)
    }
    return (
      <FieldGroup label={localizedLabel}>
        {field.kind === 'textarea' ? (
          <textarea
            aria-label={localizedLabel}
            data-tour={
              node.type === 'Talk' && field.path.join('.') === 'data.content'
                ? 'editor-talk-content'
                : undefined
            }
            className="min-h-24 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm leading-6 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={textValue}
            placeholder={localizeSnippetPlaceholder(field.placeholder)}
            onChange={onChange}
            onBlur={onInputBlur}
          />
        ) : (
          <Input
            value={textValue}
            placeholder={localizeSnippetPlaceholder(field.placeholder)}
            readOnly={field.readOnly}
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
      <FieldGroup label={localizedLabel}>
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
      <FieldGroup label={localizedLabel}>
        <select
          aria-label={localizedLabel}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={typeof value === 'string' ? value : ''}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
            onValueChange(field.path, event.currentTarget.value)
          }
        >
          {field.options.map(
            (option): JSX.Element => (
              <option key={option.value} value={option.value}>
                {localizeSnippetOptionLabel(option.label)}
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
      <FieldGroup label={localizedLabel}>
        <select
          aria-label={localizedLabel}
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
      <FieldGroup label={localizedLabel}>
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <select
            aria-label={localizedLabel}
            className="h-9 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={position.side}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              onValueChange(field.path, { ...position, side: event.currentTarget.value })
            }
          >
            {storyFieldOptions.sides.map(
              (option): JSX.Element => (
                <option key={option.value} value={option.value}>
                  {localizeSnippetOptionLabel(option.label)}
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
      <FieldGroup label={localizedLabel}>
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
      <FieldGroup label={localizedLabel}>
        <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-2 shadow-xs">
          <input
            aria-label={localizedLabel}
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

  if (field.kind === 'effect') {
    return (
      <EffectFields
        node={node}
        assets={assets}
        path={field.path}
        onValueChange={onValueChange}
        onInputBlur={onInputBlur}
      />
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

function FuzzyCombobox({
  label,
  value,
  options,
  placeholder,
  emptyText,
  onChange,
  onBlur
}: {
  label: string
  value: string
  options: readonly string[]
  placeholder?: string
  emptyText: string
  onChange: (value: string) => void
  onBlur: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState<boolean>(false)
  const [query, setQuery] = useState<string>('')
  const [activeIndex, setActiveIndex] = useState<number>(0)
  const matches: readonly string[] = useMemo((): readonly string[] => {
    const fuzzyMatches: readonly string[] = fuzzyMatchOptions(options, query, 60)
    if (query || !value || !options.includes(value) || fuzzyMatches.includes(value)) {
      return fuzzyMatches
    }
    return [value, ...fuzzyMatches.slice(0, 59)]
  }, [options, query, value])

  useEffect((): void => {
    setActiveIndex(0)
  }, [matches])

  function choose(nextValue: string): void {
    onChange(nextValue)
    setQuery(nextValue)
    setOpen(false)
    onBlur()
    inputRef.current?.focus()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const wasOpen: boolean = open
      setOpen(true)
      setActiveIndex((current: number): number =>
        !wasOpen || matches.length === 0 ? 0 : Math.min(current + 1, matches.length - 1)
      )
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current: number): number => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter' && open && matches[activeIndex]) {
      event.preventDefault()
      choose(matches[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        value={value}
        placeholder={placeholder}
        className="h-9 font-mono text-xs"
        autoComplete="off"
        onFocus={(event): void => {
          setQuery('')
          setOpen(true)
          event.currentTarget.select()
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          const nextValue: string = event.currentTarget.value
          setQuery(nextValue)
          setOpen(true)
          onChange(nextValue)
        }}
        onKeyDown={handleKeyDown}
        onBlur={(): void => {
          setOpen(false)
          onBlur()
        }}
      />
      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent"
        >
          {matches.length > 0 ? (
            matches.map(
              (option: string, index: number): JSX.Element => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  className={cn(
                    'block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs',
                    index === activeIndex && 'bg-accent text-accent-foreground',
                    option === value && 'font-semibold text-primary'
                  )}
                  title={option}
                  onMouseEnter={(): void => setActiveIndex(index)}
                  onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>): void => {
                    event.preventDefault()
                    choose(option)
                  }}
                >
                  {option}
                </button>
              )
            )
          ) : (
            <p className="px-2 py-2 text-xs text-muted-foreground">{emptyText}</p>
          )}
        </div>
      )}
    </div>
  )
}

function getModelMotionOptions(
  node: EditorNode,
  assets: ProjectAssets,
  modelRegistry: ModelRegistry,
  catalog: 'motions' | 'facials'
): readonly string[] {
  if (node.type !== 'LayoutAppear' && node.type !== 'Motion') return []
  const modelAsset: ModelAsset | undefined = assets.models[node.data.model]
  if (!modelAsset) return []
  return modelRegistry.models[modelAsset.modelId]?.[catalog] ?? []
}

function EffectFields({
  node,
  assets,
  path,
  onValueChange,
  onInputBlur
}: {
  node: EditorNode
  assets: ProjectAssets
  path: readonly string[]
  onValueChange: (path: readonly string[], value: unknown, merge?: boolean) => void
  onInputBlur: () => void
}): JSX.Element {
  if (node.type !== 'ApplyEffect') return <></>

  const { target, effect } = node.data
  const modelKeys: string[] = Object.keys(assets.models)
  const supportedTargets: StoryVisualEffectTargetType[] =
    EDITOR_VISUAL_EFFECT_REGISTRY.getSupportedTargets(effect.type)
  const updateEffect = (patch: Partial<VisualEffectData>): void => {
    onValueChange([...path, 'effect'], { ...effect, ...patch })
  }

  return (
    <div className="space-y-5">
      <FieldGroup label="作用范围">
        <div className="space-y-2">
          <select
            aria-label="Effect 作用范围"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={target.type}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
              const type: string = event.currentTarget.value
              if (type === 'Model') {
                const model: string | undefined = modelKeys[0]
                if (model) onValueChange([...path, 'target'], { type: 'Model', model })
                return
              }
              onValueChange([...path, 'target'], { type })
            }}
          >
            {supportedTargets.includes('Stage') && (
              <option value="Stage">舞台（背景、模型与粒子）</option>
            )}
            {supportedTargets.includes('Screen') && (
              <option value="Screen">整画面（包含文字 UI）</option>
            )}
            {supportedTargets.includes('Model') && (
              <option value="Model" disabled={modelKeys.length === 0}>
                指定模型
              </option>
            )}
          </select>
          {target.type === 'Model' && (
            <select
              aria-label="Effect 目标模型"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              value={target.model}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                onValueChange([...path, 'target'], {
                  type: 'Model',
                  model: event.currentTarget.value
                })
              }
            >
              {!assets.models[target.model] && (
                <option value={target.model}>缺失：{target.model}</option>
              )}
              {modelKeys.map(
                (key: string): JSX.Element => (
                  <option key={key} value={key}>
                    {getAssetOptionLabel(assets, 'models', key)} · {key}
                  </option>
                )
              )}
            </select>
          )}
        </div>
      </FieldGroup>

      <FieldGroup label="效果类型">
        <select
          aria-label="Effect 类型"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={effect.type}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const nextEffect: VisualEffectData = defaultVisualEffect(event.currentTarget.value)
            const nextSupportedTargets: StoryVisualEffectTargetType[] =
              EDITOR_VISUAL_EFFECT_REGISTRY.getSupportedTargets(nextEffect.type)
            const nextTarget = nextSupportedTargets.includes(target.type)
              ? target
              : defaultEffectTarget(nextSupportedTargets, modelKeys)
            onValueChange(path, { ...node.data, effect: nextEffect, target: nextTarget })
          }}
        >
          <option value="Grayscale">黑白</option>
          <option value="Blur">模糊</option>
          <option value="OldFilm">老电影</option>
          <option value="CRT">CRT 显示器</option>
          <option value="ColorOverlay">纯色覆盖</option>
          <option value="Hologram" disabled={modelKeys.length === 0}>
            全息投影
          </option>
          <option value="TriangleParticles" disabled={modelKeys.length === 0}>
            三角粒子
          </option>
        </select>
      </FieldGroup>

      {effect.type === 'Grayscale' && (
        <EffectNumberField
          label="黑白强度"
          value={effect.intensity}
          min={0}
          max={1}
          step={0.05}
          onChange={(intensity: number): void => updateEffect({ intensity })}
          onBlur={onInputBlur}
        />
      )}

      {effect.type === 'Blur' && (
        <>
          <EffectNumberField
            label="模糊强度"
            value={effect.strength}
            min={0}
            max={32}
            step={0.5}
            onChange={(strength: number): void => updateEffect({ strength })}
            onBlur={onInputBlur}
          />
          <div className="grid grid-cols-2 gap-2">
            <EffectNumberField
              label="质量"
              value={effect.quality}
              min={1}
              max={4}
              step={1}
              onChange={(quality: number): void => updateEffect({ quality: Math.round(quality) })}
              onBlur={onInputBlur}
            />
            <FieldGroup label="采样核">
              <select
                aria-label="模糊采样核"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs outline-none"
                value={effect.kernelSize}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                  updateEffect({
                    kernelSize: Number(event.currentTarget.value) as Extract<
                      VisualEffectData,
                      { type: 'Blur' }
                    >['kernelSize']
                  })
                }
              >
                {[5, 7, 9, 11, 13, 15].map(
                  (size: number): JSX.Element => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  )
                )}
              </select>
            </FieldGroup>
          </div>
        </>
      )}

      {effect.type === 'OldFilm' && (
        <EffectNumberGrid
          fields={[
            ['棕褐色', effect.sepia, 'sepia', 0, 1, 0.05],
            ['噪点', effect.noise, 'noise', 0, 1, 0.05],
            ['噪点尺寸', effect.noiseSize, 'noiseSize', 0, 20, 0.5],
            ['划痕', effect.scratch, 'scratch', 0, 1, 0.05],
            ['划痕密度', effect.scratchDensity, 'scratchDensity', 0, 1, 0.05],
            ['划痕宽度', effect.scratchWidth, 'scratchWidth', 0, 20, 0.5],
            ['暗角范围', effect.vignetting, 'vignetting', 0, 1, 0.05],
            ['暗角强度', effect.vignettingAlpha, 'vignettingAlpha', 0, 1, 0.05],
            ['暗角模糊', effect.vignettingBlur, 'vignettingBlur', 0, 1, 0.05]
          ]}
          onChange={updateEffect}
          onBlur={onInputBlur}
        />
      )}

      {effect.type === 'CRT' && (
        <>
          <EffectNumberGrid
            fields={[
              ['曲率', effect.curvature, 'curvature', 0, 10, 0.1],
              ['扫描线宽度', effect.lineWidth, 'lineWidth', 0, 20, 0.5],
              ['扫描线对比', effect.lineContrast, 'lineContrast', 0, 1, 0.05],
              ['噪点', effect.noise, 'noise', 0, 1, 0.05],
              ['噪点尺寸', effect.noiseSize, 'noiseSize', 0, 20, 0.5],
              ['暗角范围', effect.vignetting, 'vignetting', 0, 1, 0.05],
              ['暗角强度', effect.vignettingAlpha, 'vignettingAlpha', 0, 1, 0.05],
              ['暗角模糊', effect.vignettingBlur, 'vignettingBlur', 0, 1, 0.05]
            ]}
            onChange={updateEffect}
            onBlur={onInputBlur}
          />
          <FieldGroup label="扫描线方向">
            <div className="flex h-9 items-center justify-between rounded-md border px-3">
              <span className="text-xs text-muted-foreground">
                {effect.verticalLine ? '垂直' : '水平'}
              </span>
              <Switch
                checked={effect.verticalLine}
                onCheckedChange={(verticalLine: boolean): void => updateEffect({ verticalLine })}
              />
            </div>
          </FieldGroup>
        </>
      )}

      {effect.type === 'ColorOverlay' && (
        <>
          <FieldGroup label="覆盖颜色">
            <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-2 shadow-xs">
              <input
                aria-label="覆盖颜色"
                type="color"
                value={effect.color}
                className="size-5 cursor-pointer border-0 bg-transparent p-0"
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  updateEffect({ color: event.currentTarget.value })
                }
              />
              <span className="font-mono text-xs text-muted-foreground">
                {effect.color.toUpperCase()}
              </span>
            </div>
          </FieldGroup>
          <EffectNumberField
            label="覆盖强度"
            value={effect.alpha}
            min={0}
            max={1}
            step={0.05}
            onChange={(alpha: number): void => updateEffect({ alpha })}
            onBlur={onInputBlur}
          />
        </>
      )}
    </div>
  )
}

type EffectNumberGridField = readonly [string, number, string, number, number, number]

function EffectNumberGrid({
  fields,
  onChange,
  onBlur
}: {
  fields: readonly EffectNumberGridField[]
  onChange: (patch: Partial<VisualEffectData>) => void
  onBlur: () => void
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-4">
      {fields.map(
        ([label, value, key, min, max, step]: EffectNumberGridField): JSX.Element => (
          <EffectNumberField
            key={key}
            label={label}
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(nextValue: number): void => onChange({ [key]: nextValue })}
            onBlur={onBlur}
          />
        )
      )}
    </div>
  )
}

function EffectNumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onBlur
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  onBlur: () => void
}): JSX.Element {
  return (
    <FieldGroup label={label}>
      <NumberInput
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={onChange}
        onBlur={onBlur}
      />
    </FieldGroup>
  )
}

function defaultVisualEffect(type: string): VisualEffectData {
  switch (type) {
    case 'Blur':
      return { type: 'Blur', strength: 8, quality: 2, kernelSize: 5 }
    case 'OldFilm':
      return {
        type: 'OldFilm',
        sepia: 0.3,
        noise: 0.3,
        noiseSize: 1,
        scratch: 0.5,
        scratchDensity: 0.3,
        scratchWidth: 1,
        vignetting: 0.3,
        vignettingAlpha: 1,
        vignettingBlur: 0.3
      }
    case 'CRT':
      return {
        type: 'CRT',
        curvature: 1,
        lineWidth: 1,
        lineContrast: 0.25,
        verticalLine: false,
        noise: 0.3,
        noiseSize: 1,
        vignetting: 0.3,
        vignettingAlpha: 1,
        vignettingBlur: 0.3
      }
    case 'ColorOverlay':
      return { type: 'ColorOverlay', color: '#000000', alpha: 0.5 }
    case 'Hologram':
      return { type: 'Hologram' }
    case 'TriangleParticles':
      return { type: 'TriangleParticles' }
    default:
      return { type: 'Grayscale', intensity: 1 }
  }
}

function defaultEffectTarget(
  supportedTargets: readonly StoryVisualEffectTargetType[],
  modelKeys: readonly string[]
): Extract<EditorNode, { type: 'ApplyEffect' }>['data']['target'] {
  if (supportedTargets.includes('Model') && modelKeys[0]) {
    return { type: 'Model', model: modelKeys[0] }
  }
  if (supportedTargets.includes('Stage')) return { type: 'Stage' }
  if (supportedTargets.includes('Screen')) return { type: 'Screen' }
  return { type: 'Model', model: '' }
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
  max,
  step,
  suffix,
  onValueChange,
  onBlur
}: {
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onValueChange: (value: number) => void
  onBlur: () => void
}): JSX.Element {
  const editingRef = useRef<boolean>(false)
  const [draft, setDraft] = useState<string>((): string => numberToInputText(value))

  useEffect((): void => {
    if (!editingRef.current) setDraft(numberToInputText(value))
  }, [value])

  function clampValue(nextValue: number): number {
    if (typeof min === 'number' && typeof max === 'number') {
      return Math.min(max, Math.max(min, nextValue))
    }
    if (typeof min === 'number') return Math.max(min, nextValue)
    if (typeof max === 'number') return Math.min(max, nextValue)
    return nextValue
  }

  function commitDraft(): void {
    editingRef.current = false
    const nextValue: number = Number(draft)
    if (!draft.trim() || !Number.isFinite(nextValue)) {
      setDraft(numberToInputText(value))
      onBlur()
      return
    }

    const clampedValue: number = clampValue(nextValue)
    setDraft(numberToInputText(clampedValue))
    onValueChange(clampedValue)
    onBlur()
  }

  return (
    <div className="relative min-w-0 w-full">
      <Input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        className={cn('h-9 text-sm', suffix && 'pr-9')}
        onFocus={(): void => {
          editingRef.current = true
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          const nextDraft: string = event.currentTarget.value
          setDraft(nextDraft)
          if (!nextDraft.trim()) return

          const nextValue: number = Number(nextDraft)
          if (Number.isFinite(nextValue)) onValueChange(clampValue(nextValue))
        }}
        onBlur={commitDraft}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  )
}

function numberToInputText(value: number): string {
  return Number.isFinite(value) ? value.toString() : '0'
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
  onModelChange,
  onFileAssetChange,
  onRename,
  onDelete
}: {
  assets: ProjectAssets
  selectedAsset: EditorAssetSelection | null
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
          <AssetKeyField selection={selectedAsset} onRename={onRename} />
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
  onRename
}: {
  selection: EditorAssetSelection
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
          disabled={keyDraft === selection.key}
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

function effectReferenceLabel(story: EditorStory, node: EditorAppliedEffect): string {
  const effectLabel: string = {
    Grayscale: '黑白',
    Blur: '模糊',
    OldFilm: '老电影',
    CRT: 'CRT',
    ColorOverlay: '纯色覆盖',
    Hologram: '全息投影',
    TriangleParticles: '三角粒子'
  }[node.data.effect.type]
  const targetLabel: string =
    node.data.target.type === 'Model'
      ? `模型：${node.data.target.model}`
      : node.data.target.type === 'Stage'
        ? '舞台'
        : '整画面'
  const path: readonly number[] | null = findEditorNodePath(story, node.id)
  const snippetLabel: string = path
    ? `片段 ${path.map((index: number): number => index + 1).join('.')}`
    : '未知片段'
  return `${effectLabel} · ${targetLabel} · ${snippetLabel}`
}

function noop(): void {}
