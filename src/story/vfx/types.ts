import type { Application, Container, Filter } from 'pixi.js'
import type { StoryModelInstance, StoryPixiAccessApi } from '@/story/types'

export type StoryVisualEffectContext = {
  app: Application
  pixi: StoryPixiAccessApi
  model: StoryModelInstance
  animateLinear(animation: (progress: number) => void, timeMs: number): Promise<void>
}

export type StoryVisualEffect = {
  enabled: boolean
  readonly container?: Container
  readonly parentFilters?: readonly Filter[]
  update(delta: number): void
  destroyEffect(): void
  clearAllParticles?(): void
}

export type StoryVisualEffectFactory = (context: StoryVisualEffectContext) => StoryVisualEffect

export type StoryVisualEffectRegistration =
  | {
      name: string
      factory: StoryVisualEffectFactory
      effects?: never
    }
  | {
      name: string
      effects: readonly string[]
      factory?: never
    }

type StoryVisualEffectFactoryRegistration = {
  name: string
  factory: StoryVisualEffectFactory
}

export class StoryVisualEffectRegistry {
  private readonly factories = new Map<string, StoryVisualEffectFactory>()
  private readonly presets = new Map<string, readonly string[]>()

  constructor(registrations: readonly StoryVisualEffectRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration)
    }
  }

  register(registration: StoryVisualEffectRegistration): void {
    this.factories.delete(registration.name)
    this.presets.delete(registration.name)

    if (registration.factory) {
      this.factories.set(registration.name, registration.factory)
    } else {
      this.presets.set(registration.name, registration.effects)
    }
  }

  unregister(name: string): void {
    this.factories.delete(name)
    this.presets.delete(name)
  }

  get(name: string): StoryVisualEffectFactory | undefined {
    return this.factories.get(name)
  }

  entries(): [string, StoryVisualEffectFactory][] {
    return [...this.factories.entries()]
  }

  resolve(name: string): string[] {
    return this.resolveEffectNames(name, new Set())
  }

  clone(): StoryVisualEffectRegistry {
    return new StoryVisualEffectRegistry(
      this.registrations().map((registration) => ({ ...registration }))
    )
  }

  private registrations(): StoryVisualEffectRegistration[] {
    const factories: StoryVisualEffectFactoryRegistration[] = this.entries().map(([name, factory]) => ({
        name,
        factory
      }))
    const presets: StoryVisualEffectRegistration[] = [...this.presets.entries()].map(
      ([name, effects]) => ({
        name,
        effects: [...effects]
      })
    )

    return [...factories, ...presets]
  }

  private resolveEffectNames(name: string, resolving: Set<string>): string[] {
    if (this.factories.has(name)) return [name]

    const preset = this.presets.get(name)
    if (!preset) return [name]

    if (resolving.has(name)) {
      throw new Error(`VFX preset contains a cycle: ${[...resolving, name].join(' -> ')}`)
    }

    resolving.add(name)
    const effects = preset.flatMap((effectName) => this.resolveEffectNames(effectName, resolving))
    resolving.delete(name)

    return effects
  }
}
