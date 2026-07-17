import { i18n } from '@/i18n'
import type { BuiltinSnippetDefinition } from '@/story'

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
