import type { Container, Filter, Ticker } from 'pixi.js'
import type { EffectTargetData } from '@/story/schema'
import type { StoryPixiAccessApi } from '@/story/types'
import type {
  StoryVisualEffect,
  StoryVisualEffectContext,
  StoryVisualEffectFactoryRegistration,
  StoryVisualEffectRegistry,
  StoryVisualEffectTarget
} from './types'

export type StoryVisualEffectManagerOptions = {
  pixi: StoryPixiAccessApi
  registry: StoryVisualEffectRegistry
  resolveTarget(target: EffectTargetData): StoryVisualEffectTarget
  animateLinear(animation: (progress: number) => void, timeMs: number): Promise<void>
}

export type StoryApplyVisualEffectOptions = {
  effectId: string
  effectName: string
  target: EffectTargetData
  config?: unknown
  durationMs?: number
}

type ManagedVisualEffect = {
  effectId: string
  target: StoryVisualEffectTarget
  effects: StoryVisualEffect[]
  progress: number
}

export class StoryVisualEffectManager {
  private readonly effects = new Map<string, ManagedVisualEffect>()
  private readonly ticker: Ticker
  private readonly update = (ticker: Ticker): void => this.updateAll(ticker.deltaTime)
  private readonly pixi: StoryPixiAccessApi
  private readonly registry: StoryVisualEffectRegistry
  private readonly resolveTarget: (target: EffectTargetData) => StoryVisualEffectTarget
  private readonly animateLinear: StoryVisualEffectManagerOptions['animateLinear']
  private destroyed = false

  constructor({ pixi, registry, resolveTarget, animateLinear }: StoryVisualEffectManagerOptions) {
    this.pixi = pixi
    this.ticker = pixi.app.ticker
    this.registry = registry
    this.resolveTarget = resolveTarget
    this.animateLinear = animateLinear
    this.ticker.add(this.update)
  }

  async apply({
    effectId,
    effectName,
    target: targetData,
    config,
    durationMs = 0
  }: StoryApplyVisualEffectOptions): Promise<void> {
    if (this.destroyed) return
    await this.remove(effectId, 0)

    const target: StoryVisualEffectTarget = this.resolveTarget(targetData)
    const registrations: StoryVisualEffectFactoryRegistration[] = this.registry.resolve(effectName)
    const supportedTargets = this.registry.getSupportedTargets(effectName)
    if (!supportedTargets.includes(target.type)) {
      throw new Error(
        `VFX ${effectName} 不支持 ${target.type} target，仅支持: ${supportedTargets.join(', ')}`
      )
    }

    const context: StoryVisualEffectContext = {
      app: this.pixi.app,
      pixi: this.pixi,
      target,
      animateLinear: this.animateLinear
    }
    const effects: StoryVisualEffect[] = registrations.map(
      (registration: StoryVisualEffectFactoryRegistration): StoryVisualEffect =>
        registration.factory(context, config)
    )
    const managed: ManagedVisualEffect = { effectId, target, effects, progress: 0 }
    this.effects.set(effectId, managed)

    for (const effect of effects) {
      attachEffect(target.container, effect)
      effect.enabled = true
      effect.setProgress?.(0)
    }

    await this.animateProgress(managed, 1, durationMs)
  }

  async remove(effectId: string, durationMs = 0): Promise<void> {
    const managed: ManagedVisualEffect | undefined = this.effects.get(effectId)
    if (!managed) return

    await this.animateProgress(managed, 0, durationMs)
    this.effects.delete(effectId)
    destroyManagedEffect(managed)
  }

  async removeMatching(predicate: (effectId: string) => boolean, durationMs = 0): Promise<void> {
    const matchingIds: string[] = [...this.effects.keys()].filter(predicate)
    await Promise.all(
      matchingIds.map((effectId: string): Promise<void> => this.remove(effectId, durationMs))
    )
  }

  async clear(durationMs = 0): Promise<void> {
    await this.removeMatching((): boolean => true, durationMs)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ticker.remove(this.update)
    for (const effect of this.effects.values()) {
      destroyManagedEffect(effect)
    }
    this.effects.clear()
  }

  private async animateProgress(
    managed: ManagedVisualEffect,
    targetProgress: number,
    durationMs: number
  ): Promise<void> {
    const startProgress: number = managed.progress
    const applyProgress = (progress: number): void => {
      managed.progress = startProgress + (targetProgress - startProgress) * progress
      for (const effect of managed.effects) {
        effect.setProgress?.(managed.progress)
      }
    }

    if (durationMs <= 0) {
      applyProgress(1)
      return
    }
    await this.animateLinear(applyProgress, durationMs)
  }

  private updateAll(delta: number): void {
    for (const managed of this.effects.values()) {
      for (const effect of managed.effects) {
        if (effect.enabled) effect.update(delta)
      }
    }
  }
}

function attachEffect(target: Container, effect: StoryVisualEffect): void {
  if (effect.container && effect.container.parent !== target) {
    effect.container.removeFromParent()
    target.addChild(effect.container)
  }
  if (effect.parentFilters && effect.parentFilters.length > 0) {
    target.filters = [...toFilterArray(target.filters), ...effect.parentFilters]
  }
}

function destroyManagedEffect(managed: ManagedVisualEffect): void {
  for (const effect of managed.effects) {
    effect.enabled = false
    effect.container?.removeFromParent()
    effect.clearAllParticles?.()
    if (effect.parentFilters && effect.parentFilters.length > 0) {
      managed.target.container.filters = toFilterArray(managed.target.container.filters).filter(
        (filter: Filter): boolean => !effect.parentFilters?.includes(filter)
      )
    }
    effect.destroyEffect()
  }
}

function toFilterArray(filters: readonly Filter[] | Filter | null | undefined): Filter[] {
  if (Array.isArray(filters)) return [...filters]
  return filters ? [filters as Filter] : []
}
