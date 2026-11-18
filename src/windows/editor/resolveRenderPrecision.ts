import type { AppSettings, RenderPrecision } from '@/settings/types'

export function resolveRenderPrecision(settings: AppSettings | null): number {
  const precision: RenderPrecision | undefined = settings?.playback?.renderPrecision
  if (typeof precision === 'number' && Number.isFinite(precision) && precision > 0) {
    return precision
  }
  return window.devicePixelRatio
}
