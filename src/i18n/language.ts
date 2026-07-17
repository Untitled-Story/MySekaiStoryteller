import type { AppLanguage } from '@/settings/types'

export type ResolvedAppLanguage = Exclude<AppLanguage, 'system'>

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'zh-CN' ||
    value === 'zh-HK' ||
    value === 'en' ||
    value === 'ja' ||
    value === 'system'
    ? value
    : 'system'
}

export function resolveAppLanguage(language: AppLanguage): ResolvedAppLanguage {
  if (language !== 'system') return language

  const systemLanguage: string = navigator.language.toLowerCase()
  if (
    systemLanguage.startsWith('zh-hant') ||
    systemLanguage.startsWith('zh-hk') ||
    systemLanguage.startsWith('zh-mo') ||
    systemLanguage.startsWith('zh-tw')
  ) {
    return 'zh-HK'
  }
  if (systemLanguage.startsWith('zh')) return 'zh-CN'
  if (systemLanguage.startsWith('ja')) return 'ja'
  return 'en'
}
