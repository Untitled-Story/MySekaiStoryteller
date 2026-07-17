import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import dayjs from 'dayjs'
import 'dayjs/locale/en'
import 'dayjs/locale/ja'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/zh-hk'
import type { AppLanguage } from '@/settings/types'
import { en } from './locales/en'
import { ja } from './locales/ja'
import { zhCN } from './locales/zh-CN'
import { zhHK } from './locales/zh-HK'
import { normalizeAppLanguage, resolveAppLanguage, type ResolvedAppLanguage } from './language'

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'zh-HK': { translation: zhHK },
    en: { translation: en },
    ja: { translation: ja }
  },
  lng: resolveAppLanguage('system'),
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN', 'zh-HK', 'en', 'ja'],
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false
})

export function applyAppLanguage(language: AppLanguage): void {
  const resolved: ResolvedAppLanguage = resolveAppLanguage(language)
  if (i18n.resolvedLanguage !== resolved) void i18n.changeLanguage(resolved)
  document.documentElement.lang = resolved
  dayjs.locale(resolved === 'zh-CN' ? 'zh-cn' : resolved === 'zh-HK' ? 'zh-hk' : resolved)
}

applyAppLanguage('system')

export { i18n, normalizeAppLanguage, resolveAppLanguage }
