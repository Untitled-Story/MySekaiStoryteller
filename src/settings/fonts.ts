import { localAssetUrl } from '@/lib/projectAssetUrl'
import type { AppSettings, PlaybackFontSettings } from './types'
import defaultPlaybackFontUrl from '@/story/assets/fonts/SourceHanSansSC.otf?url'

export const DEFAULT_PLAYBACK_FONT_FAMILY: string = 'Source Han Sans SC'

export type DataFontInfo = {
  family: string
  fileName: string
  path: string
}

const loadedDataFonts: Set<string> = new Set<string>()
let defaultFontLoadPromise: Promise<void> | null = null

export function defaultPlaybackFont(): PlaybackFontSettings {
  return { source: 'default' }
}

export function normalizePlaybackFont(
  value: PlaybackFontSettings | undefined
): PlaybackFontSettings {
  if (!value) return defaultPlaybackFont()
  if (value.source === 'default') return defaultPlaybackFont()

  if (value.source === 'data') {
    const family: string = value.family.trim()
    const path: string = value.path.trim()

    if (!family || !path) return defaultPlaybackFont()
    return { source: 'data', family, path }
  }

  return defaultPlaybackFont()
}

export async function loadPlaybackFontFamily(
  settings: AppSettings | null,
  dataPath: string
): Promise<string> {
  const font: PlaybackFontSettings = normalizePlaybackFont(settings?.playback?.font)

  if (font.source === 'data') {
    await loadDataFont(dataPath, font)
    return font.family
  }

  await loadDefaultFont()
  return DEFAULT_PLAYBACK_FONT_FAMILY
}

async function loadDefaultFont(): Promise<void> {
  defaultFontLoadPromise ??= loadFontFace(DEFAULT_PLAYBACK_FONT_FAMILY, defaultPlaybackFontUrl)
  return defaultFontLoadPromise
}

async function loadDataFont(
  dataPath: string,
  font: Extract<PlaybackFontSettings, { source: 'data' }>
): Promise<void> {
  const cacheKey: string = `${font.family}\n${font.path}`
  if (loadedDataFonts.has(cacheKey)) return

  const url: string = localAssetUrl(dataPath, font.path)
  await loadFontFace(font.family, url)
  loadedDataFonts.add(cacheKey)
}

async function loadFontFace(family: string, url: string): Promise<void> {
  const fontFace: FontFace = new FontFace(family, `url("${url}")`)
  await fontFace.load()
  document.fonts.add(fontFace)
}
