import type { Application, Container, Filter } from 'pixi.js'
import type { EffectTargetData } from '@/story/schema'
import type { StoryModelInstance, StoryPixiAccessApi } from '@/story/types'

export type StoryVisualEffectTargetType = EffectTargetData['type']

export type StoryVisualEffectTarget = {
  type: StoryVisualEffectTargetType
  container: Container
  model?: StoryModelInstance
}

export type StoryVisualEffectContext = {
  app: Application
  pixi: StoryPixiAccessApi
  target: StoryVisualEffectTarget
  animateLinear(animation: (progress: number) => void, timeMs: number): Promise<void>
}

export type StoryVisualEffect = {
  enabled: boolean
  readonly container?: Container
  readonly parentFilters?: readonly Filter[]
  setProgress?(progress: number): void
  update(delta: number): void
  destroyEffect(): void
  clearAllParticles?(): void
}

export type StoryVisualEffectFactory = (
  context: StoryVisualEffectContext,
  config: unknown
) => StoryVisualEffect

export type StoryVisualEffectRegistration =
  | {
      name: string
      targets: readonly StoryVisualEffectTargetType[]
      factory: StoryVisualEffectFactory
      effects?: never
    }
  | {
      name: string
      effects: readonly string[]
      targets?: never
      factory?: never
    }

export type StoryVisualEffectFactoryRegistration = Extract<
  StoryVisualEffectRegistration,
  { factory: StoryVisualEffectFactory }
>

export class StoryVisualEffectRegistry {
  private readonly factories = new Map<string, StoryVisualEffectFactoryRegistration>()
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
      this.factories.set(registration.name, registration)
    } else {
      this.presets.set(registration.name, registration.effects)
    }
  }

  unregister(name: string): void {
    this.factories.delete(name)
    this.presets.delete(name)
  }

  get(name: string): StoryVisualEffectFactoryRegistration | undefined {
    return this.factories.get(name)
  }

  entries(): StoryVisualEffectFactoryRegistration[] {
    return [...this.factories.values()]
  }

  resolve(name: string): StoryVisualEffectFactoryRegistration[] {
    return this.resolveEffectRegistrations(name, new Set())
  }

  clone(): StoryVisualEffectRegistry {
    return new StoryVisualEffectRegistry(
      this.registrations().map(
        (registration: StoryVisualEffectRegistration): StoryVisualEffectRegistration => ({
          ...registration
        })
      )
    )
  }

  private registrations(): StoryVisualEffectRegistration[] {
    const presets: StoryVisualEffectRegistration[] = [...this.presets.entries()].map(
      ([name, effects]: [string, readonly string[]]): StoryVisualEffectRegistration => ({
        name,
        effects: [...effects]
      })
    )
    return [...this.entries(), ...presets]
  }

  private resolveEffectRegistrations(
    name: string,
    resolving: Set<string>
  ): StoryVisualEffectFactoryRegistration[] {
    const factory: StoryVisualEffectFactoryRegistration | undefined = this.factories.get(name)
    if (factory) return [factory]

    const preset: readonly string[] | undefined = this.presets.get(name)
    if (!preset) throw new Error(`未注册 VFX: ${name}`)
    if (resolving.has(name)) {
      throw new Error(`VFX preset contains a cycle: ${[...resolving, name].join(' -> ')}`)
    }

    resolving.add(name)
    const effects: StoryVisualEffectFactoryRegistration[] = preset.flatMap(
      (effectName: string): StoryVisualEffectFactoryRegistration[] =>
        this.resolveEffectRegistrations(effectName, resolving)
    )
    resolving.delete(name)
    return effects
  }
}
