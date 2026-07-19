import type { StorySnippetRegistration } from '@/story'
import type {
  CurveData,
  MoveSpeedData,
  PositionData,
  SnippetData,
  VisualEffectData
} from '@/story/schema'
import type { ProjectAssets } from '@/project/assets'
import { Curves, LayoutModes, MoveSpeed, Sides } from '@/story/schema'
import ChangeBackgroundImageSnippet from './builtin/ChangeBackgroundImageSnippet'
import ChangeLayoutModeSnippet from './builtin/ChangeLayoutModeSnippet'
import DoParamSnippet from './builtin/DoParamSnippet'
import HideTalkSnippet from './builtin/HideTalkSnippet'
import LayoutAppearSnippet from './builtin/LayoutAppearSnippet'
import LayoutClearSnippet from './builtin/LayoutClearSnippet'
import MotionSnippet from './builtin/MotionSnippet'
import MoveSnippet from './builtin/MoveSnippet'
import ScreenFadeInSnippet from './builtin/ScreenFadeInSnippet'
import ScreenFadeOutSnippet from './builtin/ScreenFadeOutSnippet'
import TalkSnippet from './builtin/TalkSnippet'
import TelopSnippet from './builtin/TelopSnippet'
import ApplyEffectSnippet from './builtin/ApplyEffectSnippet'
import RemoveEffectSnippet from './builtin/RemoveEffectSnippet'
import type { StorySnippetReducer } from '@/story/state'
import {
  reduceApplyEffect,
  reduceChangeBackgroundImage,
  reduceChangeLayoutMode,
  reduceDoParam,
  reduceHideTalk,
  reduceLayoutAppear,
  reduceLayoutClear,
  reduceMotion,
  reduceMove,
  reduceParallel,
  reduceRemoveEffect,
  reduceScreenFadeIn,
  reduceScreenFadeOut,
  reduceTalk,
  reduceTelop
} from './reducers'

export type StoryAssetKind = 'models' | 'backgrounds' | 'voices'

export type StorySnippetFieldOption = {
  value: string
  label: string
}

export type StorySnippetFieldDefinition = (
  | {
      kind: 'text' | 'textarea'
      path: readonly string[]
      label: string
      optional?: boolean
      placeholder?: string
      readOnly?: boolean
    }
  | {
      kind: 'number'
      path: readonly string[]
      label: string
      min?: number
      step?: number
      suffix?: string
    }
  | {
      kind: 'select'
      path: readonly string[]
      label: string
      options: readonly StorySnippetFieldOption[]
    }
  | {
      kind: 'asset'
      path: readonly string[]
      label: string
      assetKind: StoryAssetKind
      optional?: boolean
    }
  | {
      kind: 'position'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'boolean'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'color'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'params'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'effect'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'effect-reference'
      path: readonly string[]
      label: string
    }
  | {
      kind: 'model-motion'
      path: readonly string[]
      label: string
      catalog: 'motions' | 'facials'
      optional?: boolean
      placeholder?: string
    }
) & {
  advanced?: boolean
}

export type BuiltinSnippetDefinition = {
  type: SnippetData['type']
  label: string
  category: '场景' | '模型' | '文本' | '特效' | '控制'
  description: string
  fields: readonly StorySnippetFieldDefinition[]
  create(id: string, assets: ProjectAssets): SnippetData
  summary(snippet: SnippetData): string
  reduce: StorySnippetReducer
  runtime?: StorySnippetRegistration
}

const LAYOUT_MODE_OPTIONS: readonly StorySnippetFieldOption[] = [
  { value: 'Normal', label: '普通布局' },
  { value: 'Three', label: '三人布局' }
]

const MOVE_SPEED_OPTIONS: readonly StorySnippetFieldOption[] = [
  { value: 'Slow', label: '慢' },
  { value: 'Normal', label: '普通' },
  { value: 'Fast', label: '快' },
  { value: 'Immediate', label: '立即' }
]

const SIDE_OPTIONS: readonly StorySnippetFieldOption[] = [
  { value: 'Left', label: '左' },
  { value: 'Center', label: '中' },
  { value: 'Right', label: '右' }
]

const CURVE_OPTIONS: readonly StorySnippetFieldOption[] = [
  { value: 'Linear', label: '线性' },
  { value: 'Sine', label: '正弦' },
  { value: 'Cosine', label: '余弦' }
]

export const builtinSnippetDefinitions = [
  {
    type: 'ChangeLayoutMode',
    label: 'ChangeLayoutMode',
    category: '场景',
    description: '切换角色布局方式',
    fields: [
      {
        kind: 'select',
        path: ['data', 'mode'],
        label: '布局模式',
        options: LAYOUT_MODE_OPTIONS
      }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'ChangeLayoutMode',
      delay: 0,
      data: { mode: LayoutModes.Normal }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'ChangeLayoutMode' ? snippet.data.mode : '',
    reduce: reduceChangeLayoutMode,
    runtime: { type: 'ChangeLayoutMode', constructor: ChangeLayoutModeSnippet }
  },
  {
    type: 'ChangeBackgroundImage',
    label: 'ChangeBackgroundImage',
    category: '场景',
    description: '切换当前背景图像',
    fields: [
      {
        kind: 'asset',
        path: ['data', 'background'],
        label: '背景图像',
        assetKind: 'backgrounds'
      }
    ],
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'ChangeBackgroundImage',
      delay: 0,
      data: { background: requireAssetKey(assets, 'backgrounds') }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'ChangeBackgroundImage' ? snippet.data.background || '未选择背景' : '',
    reduce: reduceChangeBackgroundImage,
    runtime: { type: 'ChangeBackgroundImage', constructor: ChangeBackgroundImageSnippet }
  },
  {
    type: 'Parallel',
    label: 'Parallel',
    category: '控制',
    description: '同时启动一组子片段',
    fields: [],
    create: (id: string): SnippetData => ({
      id,
      type: 'Parallel',
      delay: 0,
      snippets: []
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'Parallel' ? `${snippet.snippets.length} 个并行子片段` : '',
    reduce: reduceParallel
  },
  {
    type: 'LayoutAppear',
    label: 'LayoutAppear',
    category: '模型',
    description: '让模型在当前位置出现并播放初始动作',
    fields: modelAppearanceFields(),
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'LayoutAppear',
      delay: 0,
      data: {
        model: requireAssetKey(assets, 'models'),
        position: defaultPosition(),
        motion: undefined,
        facial: undefined,
        hologram: false
      }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'LayoutAppear' ? snippet.data.model || '未选择模型' : '',
    reduce: reduceLayoutAppear,
    runtime: { type: 'LayoutAppear', constructor: LayoutAppearSnippet }
  },
  {
    type: 'LayoutClear',
    label: 'LayoutClear',
    category: '模型',
    description: '让模型在当前位置消失',
    fields: [{ kind: 'asset', path: ['data', 'model'], label: '模型', assetKind: 'models' }],
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'LayoutClear',
      delay: 0,
      data: { model: requireAssetKey(assets, 'models') }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'LayoutClear' ? snippet.data.model || '未选择模型' : '',
    reduce: reduceLayoutClear,
    runtime: { type: 'LayoutClear', constructor: LayoutClearSnippet }
  },
  {
    type: 'Talk',
    label: 'Talk',
    category: '文本',
    description: '显示角色台词，可附带语音',
    fields: [
      { kind: 'text', path: ['data', 'speaker'], label: '说话人', placeholder: '未命名' },
      { kind: 'textarea', path: ['data', 'content'], label: '文本', placeholder: '输入台词' },
      {
        kind: 'asset',
        path: ['data', 'model'],
        label: '关联模型',
        assetKind: 'models',
        optional: true
      },
      { kind: 'asset', path: ['data', 'voice'], label: '语音', assetKind: 'voices', optional: true }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'Talk',
      delay: 0,
      data: { speaker: '', content: '', model: undefined, voice: undefined }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'Talk'
        ? `${snippet.data.speaker || '未命名'}: ${truncate(snippet.data.content, 26)}`
        : '',
    reduce: reduceTalk,
    runtime: { type: 'Talk', constructor: TalkSnippet }
  },
  {
    type: 'HideTalk',
    label: 'HideTalk',
    category: '文本',
    description: '隐藏当前台词框',
    fields: [],
    create: (id: string): SnippetData => ({ id, type: 'HideTalk', delay: 0 }),
    summary: (): string => '隐藏台词框',
    reduce: reduceHideTalk,
    runtime: { type: 'HideTalk', constructor: HideTalkSnippet }
  },
  {
    type: 'Move',
    label: 'Move',
    category: '模型',
    description: '移动已显示的模型',
    fields: modelMoveFields(),
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'Move',
      delay: 0,
      data: {
        model: requireAssetKey(assets, 'models'),
        from: defaultPosition(),
        to: defaultPosition(),
        moveSpeed: MoveSpeed.Normal
      }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'Move'
        ? `${snippet.data.model || '未选择模型'} -> ${snippet.data.to.side}`
        : '',
    reduce: reduceMove,
    runtime: { type: 'Move', constructor: MoveSnippet }
  },
  {
    type: 'Motion',
    label: 'Motion',
    category: '模型',
    description: '播放模型动作或表情',
    fields: [
      { kind: 'asset', path: ['data', 'model'], label: '模型', assetKind: 'models' },
      {
        kind: 'model-motion',
        path: ['data', 'motion'],
        label: '动作',
        catalog: 'motions',
        optional: true,
        placeholder: 'motion 名称'
      },
      {
        kind: 'model-motion',
        path: ['data', 'facial'],
        label: '表情',
        catalog: 'facials',
        optional: true,
        placeholder: 'facial 名称'
      }
    ],
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'Motion',
      delay: 0,
      data: { model: requireAssetKey(assets, 'models'), motion: undefined, facial: undefined }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'Motion'
        ? `${snippet.data.model || '未选择模型'} · ${snippet.data.motion ?? snippet.data.facial ?? '无动作'}`
        : '',
    reduce: reduceMotion,
    runtime: { type: 'Motion', constructor: MotionSnippet }
  },
  {
    type: 'Telop',
    label: 'Telop',
    category: '文本',
    description: '显示居中标题文本',
    fields: [
      { kind: 'textarea', path: ['data', 'content'], label: '文本', placeholder: '输入标题' }
    ],
    create: (id: string): SnippetData => ({ id, type: 'Telop', delay: 0, data: { content: '' } }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'Telop' ? truncate(snippet.data.content, 26) : '',
    reduce: reduceTelop,
    runtime: { type: 'Telop', constructor: TelopSnippet }
  },
  {
    type: 'DoParam',
    label: 'DoParam',
    category: '模型',
    description: '为 Live2D 参数制作动画',
    fields: [
      { kind: 'asset', path: ['data', 'model'], label: '模型', assetKind: 'models' },
      { kind: 'params', path: ['data', 'params'], label: '参数动画' }
    ],
    create: (id: string, assets: ProjectAssets): SnippetData => ({
      id,
      type: 'DoParam',
      delay: 0,
      data: {
        model: requireAssetKey(assets, 'models'),
        params: [defaultParameterAnimation()]
      }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'DoParam'
        ? `${snippet.data.model || '未选择模型'} · ${snippet.data.params.length} 个参数`
        : '',
    reduce: reduceDoParam,
    runtime: { type: 'DoParam', constructor: DoParamSnippet }
  },
  {
    type: 'ScreenFadeOut',
    label: 'ScreenFadeOut',
    category: '场景',
    description: '将画面淡出到指定颜色',
    fields: [
      { kind: 'color', path: ['data', 'color'], label: '颜色' },
      { kind: 'number', path: ['data', 'duration'], label: '时长', min: 0, step: 0.1, suffix: 's' }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'ScreenFadeOut',
      delay: 0,
      data: { color: '#000000', duration: 0.5 }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'ScreenFadeOut' ? `${snippet.data.color} · ${snippet.data.duration}s` : '',
    reduce: reduceScreenFadeOut,
    runtime: { type: 'ScreenFadeOut', constructor: ScreenFadeOutSnippet }
  },
  {
    type: 'ScreenFadeIn',
    label: 'ScreenFadeIn',
    category: '场景',
    description: '恢复淡出后的画面',
    fields: [
      { kind: 'number', path: ['data', 'duration'], label: '时长', min: 0, step: 0.1, suffix: 's' }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'ScreenFadeIn',
      delay: 0,
      data: { duration: 0.5 }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'ScreenFadeIn' ? `${snippet.data.duration}s` : '',
    reduce: reduceScreenFadeIn,
    runtime: { type: 'ScreenFadeIn', constructor: ScreenFadeInSnippet }
  },
  {
    type: 'ApplyEffect',
    label: 'ApplyEffect',
    category: '特效',
    description: '将视觉效果应用到模型、舞台或整个画面',
    fields: [
      { kind: 'effect', path: ['data'], label: '效果配置' },
      {
        kind: 'number',
        path: ['data', 'duration'],
        label: '过渡时长',
        min: 0,
        step: 0.1,
        suffix: 's'
      },
      {
        kind: 'text',
        path: ['data', 'effectId'],
        label: '内部 Effect ID',
        placeholder: '用于后续更新或移除',
        readOnly: true,
        advanced: true
      }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'ApplyEffect',
      delay: 0,
      data: {
        effectId: `effect-${id.slice(0, 8)}`,
        target: { type: 'Stage' },
        effect: { type: 'Grayscale', intensity: 1 },
        duration: 0.3
      }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'ApplyEffect'
        ? `${effectLabel(snippet.data.effect.type)} · ${effectTargetLabel(snippet.data.target)}`
        : '',
    reduce: reduceApplyEffect,
    runtime: { type: 'ApplyEffect', constructor: ApplyEffectSnippet }
  },
  {
    type: 'RemoveEffect',
    label: 'RemoveEffect',
    category: '特效',
    description: '移除之前已应用的视觉效果',
    fields: [
      { kind: 'effect-reference', path: ['data', 'effectId'], label: '要移除的效果' },
      {
        kind: 'number',
        path: ['data', 'duration'],
        label: '过渡时长',
        min: 0,
        step: 0.1,
        suffix: 's'
      },
      {
        kind: 'text',
        path: ['data', 'effectId'],
        label: '内部 Effect ID',
        placeholder: '用于精确匹配效果',
        readOnly: true,
        advanced: true
      }
    ],
    create: (id: string): SnippetData => ({
      id,
      type: 'RemoveEffect',
      delay: 0,
      data: { effectId: `effect-${id.slice(0, 8)}`, duration: 0.3 }
    }),
    summary: (snippet: SnippetData): string =>
      snippet.type === 'RemoveEffect' ? `${snippet.data.effectId} · ${snippet.data.duration}s` : '',
    reduce: reduceRemoveEffect,
    runtime: { type: 'RemoveEffect', constructor: RemoveEffectSnippet }
  }
] as const satisfies readonly BuiltinSnippetDefinition[]

export function getBuiltinSnippetDefinition(type: SnippetData['type']): BuiltinSnippetDefinition {
  const definition: BuiltinSnippetDefinition | undefined = builtinSnippetDefinitions.find(
    (candidate: BuiltinSnippetDefinition): boolean => candidate.type === type
  )
  if (!definition) {
    throw new Error(`未定义的片段类型: ${type}`)
  }

  return definition
}

export function getBuiltinSnippetRegistrations(): StorySnippetRegistration[] {
  return builtinSnippetDefinitions.flatMap(
    (definition: BuiltinSnippetDefinition): StorySnippetRegistration[] =>
      definition.runtime ? [definition.runtime] : []
  )
}

function modelMoveFields(): readonly StorySnippetFieldDefinition[] {
  return [
    { kind: 'asset', path: ['data', 'model'], label: '模型', assetKind: 'models' },
    { kind: 'position', path: ['data', 'from'], label: '起点' },
    { kind: 'position', path: ['data', 'to'], label: '终点' },
    {
      kind: 'select',
      path: ['data', 'moveSpeed'],
      label: '移动速度',
      options: MOVE_SPEED_OPTIONS
    }
  ]
}

function modelAppearanceFields(): readonly StorySnippetFieldDefinition[] {
  return [
    { kind: 'asset', path: ['data', 'model'], label: '模型', assetKind: 'models' },
    { kind: 'position', path: ['data', 'position'], label: '出现位置' },
    {
      kind: 'model-motion',
      path: ['data', 'motion'],
      label: '动作',
      catalog: 'motions',
      optional: true,
      placeholder: 'motion 名称'
    },
    {
      kind: 'model-motion',
      path: ['data', 'facial'],
      label: '表情',
      catalog: 'facials',
      optional: true,
      placeholder: 'facial 名称'
    },
    { kind: 'boolean', path: ['data', 'hologram'], label: '全息效果' }
  ]
}

export function defaultPosition(): PositionData {
  return { side: Sides.Center, offset: 0 }
}

export function defaultParameterAnimation(): {
  paramId: string
  start: number
  end: number
  curve: CurveData
  duration: number
} {
  return {
    paramId: 'ParamAngleX',
    start: 0,
    end: 0,
    curve: Curves.Linear,
    duration: 0.3
  }
}

export const storyFieldOptions = {
  sides: SIDE_OPTIONS,
  moveSpeeds: MOVE_SPEED_OPTIONS,
  curves: CURVE_OPTIONS
} as const

export function isMoveSpeed(value: string): value is MoveSpeedData {
  return MOVE_SPEED_OPTIONS.some(
    (option: StorySnippetFieldOption): boolean => option.value === value
  )
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function requireAssetKey(assets: ProjectAssets, kind: StoryAssetKind): string {
  const key: string | undefined = Object.keys(assets[kind])[0]
  if (!key) {
    throw new Error(
      `添加该片段前需要先添加${kind === 'models' ? '模型' : kind === 'backgrounds' ? '背景' : '语音'}资源`
    )
  }
  return key
}

function effectLabel(type: VisualEffectData['type']): string {
  return {
    Grayscale: '黑白',
    Blur: '模糊',
    OldFilm: '老电影',
    CRT: 'CRT',
    ColorOverlay: '纯色覆盖',
    Hologram: '全息投影',
    TriangleParticles: '三角粒子'
  }[type]
}

function effectTargetLabel(
  target: Extract<SnippetData, { type: 'ApplyEffect' }>['data']['target']
): string {
  if (target.type === 'Model') return target.model || '未选择模型'
  return target.type === 'Stage' ? '舞台' : '整个画面'
}
