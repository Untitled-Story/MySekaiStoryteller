import type { RenderPrecision } from '@/settings/types'

export function resolveRenderPrecision(precision: RenderPrecision | undefined): number {
  if (typeof precision === 'number' && Number.isFinite(precision) && precision > 0) {
    return precision
  }
  return window.devicePixelRatio
}
