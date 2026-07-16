import { BlurFilter } from 'pixi.js'
import type { Filter } from 'pixi.js'
import { AdjustmentFilter, ColorOverlayFilter, CRTFilter, OldFilmFilter } from 'pixi-filters'
import type { VisualEffectData } from '@/story/schema'
import type { StoryVisualEffect, StoryVisualEffectFactory } from '@/story/vfx/types'

type EffectByType<TType extends VisualEffectData['type']> = Extract<
  VisualEffectData,
  { type: TType }
>

abstract class FilterEffectBase<TFilter extends Filter> implements StoryVisualEffect {
  enabled = false
  readonly parentFilters: readonly Filter[]

  protected constructor(protected readonly filter: TFilter) {
    this.parentFilters = [filter]
  }

  abstract setProgress(progress: number): void

  update(delta: number): void {
    void delta
  }

  destroyEffect(): void {
    this.filter.destroy()
  }
}

class GrayscaleEffect extends FilterEffectBase<AdjustmentFilter> {
  constructor(private readonly config: EffectByType<'Grayscale'>) {
    super(new AdjustmentFilter({ saturation: 1 }))
  }

  setProgress(progress: number): void {
    this.filter.saturation = 1 - this.config.intensity * progress
  }
}

class BlurEffect extends FilterEffectBase<BlurFilter> {
  constructor(private readonly config: EffectByType<'Blur'>) {
    super(
      new BlurFilter({
        strength: 0,
        quality: config.quality,
        kernelSize: config.kernelSize
      })
    )
  }

  setProgress(progress: number): void {
    this.filter.strength = this.config.strength * progress
  }
}

class OldFilmEffect extends FilterEffectBase<OldFilmFilter> {
  constructor(private readonly config: EffectByType<'OldFilm'>) {
    super(
      new OldFilmFilter({
        ...config,
        sepia: 0,
        noise: 0,
        scratch: 0,
        vignettingAlpha: 0
      })
    )
  }

  setProgress(progress: number): void {
    this.filter.sepia = this.config.sepia * progress
    this.filter.noise = this.config.noise * progress
    this.filter.scratch = this.config.scratch * progress
    this.filter.vignettingAlpha = this.config.vignettingAlpha * progress
  }

  override update(delta: number): void {
    void delta
    if (this.enabled) this.filter.seed = Math.random()
  }
}

class CrtEffect extends FilterEffectBase<CRTFilter> {
  constructor(private readonly config: EffectByType<'CRT'>) {
    super(
      new CRTFilter({
        ...config,
        curvature: 0,
        lineContrast: 0,
        noise: 0,
        vignettingAlpha: 0,
        time: 0
      })
    )
  }

  setProgress(progress: number): void {
    this.filter.curvature = this.config.curvature * progress
    this.filter.lineContrast = this.config.lineContrast * progress
    this.filter.noise = this.config.noise * progress
    this.filter.vignettingAlpha = this.config.vignettingAlpha * progress
  }

  override update(delta: number): void {
    if (!this.enabled) return
    this.filter.time += delta * 0.01
    this.filter.seed = Math.random()
  }
}

class ColorOverlayEffect extends FilterEffectBase<ColorOverlayFilter> {
  constructor(private readonly config: EffectByType<'ColorOverlay'>) {
    super(new ColorOverlayFilter({ color: config.color, alpha: 0 }))
  }

  setProgress(progress: number): void {
    this.filter.alpha = this.config.alpha * progress
  }
}

export const createGrayscaleEffect: StoryVisualEffectFactory = (_context, config) =>
  new GrayscaleEffect(requireConfig(config, 'Grayscale'))

export const createBlurEffect: StoryVisualEffectFactory = (_context, config) =>
  new BlurEffect(requireConfig(config, 'Blur'))

export const createOldFilmEffect: StoryVisualEffectFactory = (_context, config) =>
  new OldFilmEffect(requireConfig(config, 'OldFilm'))

export const createCrtEffect: StoryVisualEffectFactory = (_context, config) =>
  new CrtEffect(requireConfig(config, 'CRT'))

export const createColorOverlayEffect: StoryVisualEffectFactory = (_context, config) =>
  new ColorOverlayEffect(requireConfig(config, 'ColorOverlay'))

function requireConfig<TType extends VisualEffectData['type']>(
  config: unknown,
  type: TType
): EffectByType<TType> {
  if (!config || typeof config !== 'object' || !('type' in config) || config.type !== type) {
    throw new Error(`VFX ${type} 配置无效`)
  }
  return config as EffectByType<TType>
}
