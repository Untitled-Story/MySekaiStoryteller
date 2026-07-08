import { Ticker } from 'pixi.js'
import type { Filter } from 'pixi.js'
import type { StoryModelInstance, StoryPixiAccessApi } from '@/story/types'
import type {
  StoryVisualEffect,
  StoryVisualEffectContext,
  StoryVisualEffectRegistry
} from './types'

export type StoryVisualEffectManagerOptions = {
  pixi: StoryPixiAccessApi
  model: StoryModelInstance
  registry: StoryVisualEffectRegistry
  animateLinear(animation: (progress: number) => void, timeMs: number): Promise<void>
}

class StoryVisualEffectTicker {
  private static instance: Ticker | null = null

  static getInstance(): Ticker {
    StoryVisualEffectTicker.instance ??= createStartedTicker()
    return StoryVisualEffectTicker.instance
  }
}

export class StoryVisualEffectManager {
  private readonly effects = new Map<string, StoryVisualEffect>()
  private readonly ticker = StoryVisualEffectTicker.getInstance()
  private readonly update = (ticker: Ticker): void => this.updateAll(ticker.deltaTime)
  private readonly context: StoryVisualEffectContext
  private readonly registry: StoryVisualEffectRegistry
  private destroyed = false

  constructor({ pixi, model, registry, animateLinear }: StoryVisualEffectManagerOptions) {
    this.context = {
      app: pixi.app,
      pixi,
      model,
      animateLinear
    }
    this.registry = registry

    for (const [name, factory] of registry.entries()) {
      this.effects.set(name, factory(this.context))
    }

    this.ticker.add(this.update)
  }

  apply(effectName: string): void {
    for (const resolvedEffectName of this.registry.resolve(effectName)) {
      this.applyConcrete(resolvedEffectName)
    }
  }

  disable(effectName: string): void {
    for (const resolvedEffectName of this.registry.resolve(effectName)) {
      this.disableConcrete(resolvedEffectName)
    }
  }

  disableAll(): void {
    for (const name of this.effects.keys()) {
      this.disableConcrete(name)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    this.ticker.remove(this.update)
    for (const effect of this.effects.values()) {
      effect.container?.removeFromParent()
      effect.destroyEffect()
    }
    this.effects.clear()
  }

  private applyConcrete(effectName: string): void {
    const effect = this.effects.get(effectName)
    if (!effect) return

    const { model } = this.context.model
    if (effect.container && !effect.container.parent) {
      model.addChild(effect.container)
    }
    effect.enabled = true
    const parentFilters = effect.parentFilters ?? []
    if (parentFilters.length > 0) {
      model.filters = appendFilters(model.filters, parentFilters)
    }
  }

  private disableConcrete(effectName: string): void {
    const effect = this.effects.get(effectName)
    if (!effect) return

    effect.enabled = false
    effect.container?.removeFromParent()
    const parentFilters = effect.parentFilters ?? []
    if (parentFilters.length > 0) {
      const currentFilters = this.context.model.model.filters
      this.context.model.model.filters = currentFilters
        ? currentFilters.filter((filter) => !parentFilters.includes(filter))
        : currentFilters
    }
    effect.clearAllParticles?.()
  }

  private updateAll(delta: number): void {
    for (const effect of this.effects.values()) {
      effect.update(delta)
    }
  }
}

function createStartedTicker(): Ticker {
  const ticker = new Ticker()
  ticker.start()
  return ticker
}

function appendFilters(
  currentFilters: readonly Filter[] | Filter | null | undefined,
  filters: readonly Filter[]
): Filter[] {
  const current = Array.isArray(currentFilters)
    ? currentFilters
    : currentFilters
      ? [currentFilters]
      : []
  return [...current, ...filters]
}
