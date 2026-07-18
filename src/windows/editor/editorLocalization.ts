import { i18n } from '@/i18n'
import type { BuiltinSnippetDefinition, SnippetData } from '@/story'
import type { ProjectAssetKind } from '@/project/assets'

const CATEGORY_KEYS: Record<BuiltinSnippetDefinition['category'], string> = {
  场景: 'scene',
  模型: 'model',
  文本: 'text',
  特效: 'effect',
  控制: 'control'
}

const FIELD_KEYS: Readonly<Record<string, string>> = {
  布局模式: 'layoutMode',
  背景图像: 'backgroundImage',
  模型: 'model',
  说话人: 'speaker',
  文本: 'text',
  关联模型: 'linkedModel',
  语音: 'voice',
  动作: 'motion',
  表情: 'facial',
  参数动画: 'parameterAnimation',
  颜色: 'color',
  时长: 'duration',
  效果配置: 'effectConfiguration',
  过渡时长: 'transitionDuration',
  '内部 Effect ID': 'internalEffectId',
  要移除的效果: 'effectToRemove',
  出现位置: 'appearPosition',
  起点: 'start',
  终点: 'end',
  移动速度: 'moveSpeed',
  全息效果: 'hologram'
}

const OPTION_KEYS: Readonly<Record<string, string>> = {
  普通布局: 'normalLayout',
  三人布局: 'threePersonLayout',
  慢: 'slow',
  普通: 'normal',
  快: 'fast',
  立即: 'immediate',
  左: 'left',
  中: 'center',
  右: 'right',
  线性: 'linear',
  正弦: 'sine',
  余弦: 'cosine'
}

const PLACEHOLDER_KEYS: Readonly<Record<string, string>> = {
  未命名: 'unnamed',
  输入台词: 'dialogue',
  输入标题: 'title'
}

const ASSET_KIND_KEYS: Record<ProjectAssetKind, string> = {
  models: 'assetModels',
  backgrounds: 'assetBackgrounds',
  voices: 'assetVoices'
}

export function localizeSnippetCategory(category: BuiltinSnippetDefinition['category']): string {
  return i18n.t(`snippetCategories.${CATEGORY_KEYS[category]}`, { defaultValue: category })
}

export function localizeSnippetDescription(definition: BuiltinSnippetDefinition): string {
  return i18n.t(`snippetDescriptions.${definition.type}`, {
    defaultValue: definition.description
  })
}

export function localizeSnippetFieldLabel(label: string): string {
  const key: string | undefined = FIELD_KEYS[label]
  return key ? i18n.t(`snippetFields.${key}`, { defaultValue: label }) : label
}

export function localizeSnippetOptionLabel(label: string): string {
  const key: string | undefined = OPTION_KEYS[label]
  return key ? i18n.t(`snippetOptions.${key}`, { defaultValue: label }) : label
}

export function localizeSnippetPlaceholder(value: string | undefined): string | undefined {
  if (!value) return value
  const key: string | undefined = PLACEHOLDER_KEYS[value]
  return key ? i18n.t(`snippetPlaceholders.${key}`, { defaultValue: value }) : value
}

export function localizeAssetKind(kind: ProjectAssetKind): string {
  return i18n.t(`editor.${ASSET_KIND_KEYS[kind]}`)
}

export function localizeSnippetSummary(snippet: SnippetData): string {
  switch (snippet.type) {
    case 'ChangeLayoutMode':
      return i18n.t(
        `snippetOptions.${snippet.data.mode === 'Three' ? 'threePersonLayout' : 'normalLayout'}`
      )
    case 'ChangeBackgroundImage':
      return snippet.data.background || i18n.t('editor.noBackgroundSelected')
    case 'Parallel':
      return i18n.t('editor.parallelSnippetCount', { count: snippet.snippets.length })
    case 'LayoutAppear':
    case 'LayoutClear':
      return snippet.data.model || i18n.t('editor.noModelSelected')
    case 'Talk':
      return `${snippet.data.speaker || i18n.t('editor.unnamed')}: ${truncateSummary(snippet.data.content)}`
    case 'HideTalk':
      return i18n.t('editor.hideTalkSummary')
    case 'Move':
      return `${snippet.data.model || i18n.t('editor.noModelSelected')} -> ${localizeSide(snippet.data.to.side)}`
    case 'Motion':
      return `${snippet.data.model || i18n.t('editor.noModelSelected')} · ${snippet.data.motion ?? snippet.data.facial ?? i18n.t('editor.noMotion')}`
    case 'Telop':
      return truncateSummary(snippet.data.content)
    case 'DoParam':
      return `${snippet.data.model || i18n.t('editor.noModelSelected')} · ${i18n.t('editor.parameterCount', { count: snippet.data.params.length })}`
    case 'ScreenFadeOut':
      return `${snippet.data.color} · ${snippet.data.duration}s`
    case 'ScreenFadeIn':
      return `${snippet.data.duration}s`
    case 'ApplyEffect':
      return `${localizeEffectType(snippet.data.effect.type)} · ${localizeEffectTarget(snippet.data.target)}`
    case 'RemoveEffect':
      return `${snippet.data.effectId} · ${snippet.data.duration}s`
  }
}

function localizeSide(side: 'Left' | 'Center' | 'Right'): string {
  const key: 'left' | 'center' | 'right' = side.toLocaleLowerCase() as 'left' | 'center' | 'right'
  return i18n.t(`snippetOptions.${key}`)
}

function localizeEffectType(
  type: Extract<SnippetData, { type: 'ApplyEffect' }>['data']['effect']['type']
): string {
  const keys: Readonly<Record<string, string>> = {
    Grayscale: 'effectGrayscale',
    Blur: 'effectBlur',
    OldFilm: 'effectOldFilm',
    CRT: 'effectCrt',
    ColorOverlay: 'effectColorOverlay',
    Hologram: 'effectHologram',
    TriangleParticles: 'effectTriangleParticles'
  }
  return i18n.t(`editor.${keys[type] ?? type}`)
}

function localizeEffectTarget(
  target: Extract<SnippetData, { type: 'ApplyEffect' }>['data']['target']
): string {
  if (target.type === 'Model') return target.model || i18n.t('editor.noModelSelected')
  return target.type === 'Stage' ? i18n.t('editor.targetStage') : i18n.t('editor.targetScreen')
}

function truncateSummary(value: string, maxLength = 26): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}
