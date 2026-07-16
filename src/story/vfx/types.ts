import type { Application, Container, Filter } from 'pixi.js'
import type { EffectTargetData } from '@/story/schema'
import type { StoryModelInstance, StoryPixiAccessApi } from '@/story/types'

export type StoryVisualEffectTargetType = EffectTargetData['type']

const STORY_VISUAL_EFFECT_TARGET_TYPES: readonly StoryVisualEffectTargetType[] = [
  'Model',
  'Stage',
  'Screen'
]

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
      targets: readonly StoryVisualEffectTargetType[]
      effects: readonly string[]
      factory?: never
    }

export type StoryVisualEffectFactoryRegistration = Extract<
  StoryVisualEffectRegistration,
  { factory: StoryVisualEffectFactory }
>

type StoryVisualEffectPresetRegistration = Extract<
  StoryVisualEffectRegistration,
  { effects: readonly string[] }
>

export class StoryVisualEffectRegistry {
  private readonly factories = new Map<string, StoryVisualEffectFactoryRegistration>()
  private readonly presets = new Map<string, StoryVisualEffectPresetRegistration>()

  constructor(registrations: readonly StoryVisualEffectRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration)
    }
  }

  register(registration: StoryVisualEffectRegistration): void {
    validateRegistration(registration)
    const previousFactory: StoryVisualEffectFactoryRegistration | undefined = this.factories.get(
      registration.name
    )
    const previousPreset: StoryVisualEffectPresetRegistration | undefined = this.presets.get(
      registration.name
    )
    this.factories.delete(registration.name)
    this.presets.delete(registration.name)

    try {
      if (registration.factory) {
        this.factories.set(registration.name, registration)
      } else {
        this.presets.set(registration.name, registration)
        this.validatePresetTargets(registration)
      }
    } catch (error: unknown) {
      this.factories.delete(registration.name)
      this.presets.delete(registration.name)
      if (previousFactory) this.factories.set(registration.name, previousFactory)
      if (previousPreset) this.presets.set(registration.name, previousPreset)
      throw error
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

  getSupportedTargets(name: string): StoryVisualEffectTargetType[] {
    return this.resolveSupportedTargets(name, new Set())
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
    const presets: StoryVisualEffectRegistration[] = [...this.presets.values()].map(
      (registration: StoryVisualEffectPresetRegistration): StoryVisualEffectRegistration => ({
        ...registration,
        targets: [...registration.targets],
        effects: [...registration.effects]
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

    const preset: StoryVisualEffectPresetRegistration | undefined = this.presets.get(name)
    if (!preset) throw new Error(`未注册 VFX: ${name}`)
    if (resolving.has(name)) {
      throw new Error(`VFX preset contains a cycle: ${[...resolving, name].join(' -> ')}`)
    }

    resolving.add(name)
    const effects: StoryVisualEffectFactoryRegistration[] = preset.effects.flatMap(
      (effectName: string): StoryVisualEffectFactoryRegistration[] =>
        this.resolveEffectRegistrations(effectName, resolving)
    )
    resolving.delete(name)
    return effects
  }

  private resolveSupportedTargets(
    name: string,
    resolving: Set<string>
  ): StoryVisualEffectTargetType[] {
    const factory: StoryVisualEffectFactoryRegistration | undefined = this.factories.get(name)
    if (factory) return [...factory.targets]

    const preset: StoryVisualEffectPresetRegistration | undefined = this.presets.get(name)
    if (!preset) throw new Error(`未注册 VFX: ${name}`)
    if (resolving.has(name)) {
      throw new Error(`VFX preset contains a cycle: ${[...resolving, name].join(' -> ')}`)
    }

    resolving.add(name)
    const childTargets: StoryVisualEffectTargetType[][] = preset.effects.map(
      (effectName: string): StoryVisualEffectTargetType[] =>
        this.resolveSupportedTargets(effectName, resolving)
    )
    resolving.delete(name)
    return preset.targets.filter((target: StoryVisualEffectTargetType): boolean =>
      childTargets.every((targets: StoryVisualEffectTargetType[]): boolean =>
        targets.includes(target)
      )
    )
  }

  private validatePresetTargets(registration: StoryVisualEffectPresetRegistration): void {
    const supportedTargets: StoryVisualEffectTargetType[] = this.getSupportedTargets(
      registration.name
    )
    const unsupportedTargets: StoryVisualEffectTargetType[] = registration.targets.filter(
      (target: StoryVisualEffectTargetType): boolean => !supportedTargets.includes(target)
    )
    if (unsupportedTargets.length > 0) {
      throw new Error(
        `VFX preset ${registration.name} 的 target 与子效果不兼容: ${unsupportedTargets.join(', ')}`
      )
    }
  }
}

function validateRegistration(registration: StoryVisualEffectRegistration): void {
  if (!registration.name.trim()) throw new Error('VFX registration name 不能为空')
  if (registration.targets.length === 0) {
    throw new Error(`VFX ${registration.name} 至少需要一个 target`)
  }
  for (const target of registration.targets) {
    if (!STORY_VISUAL_EFFECT_TARGET_TYPES.includes(target)) {
      throw new Error(`VFX ${registration.name} 包含无效 target: ${String(target)}`)
    }
  }
  if (!registration.factory && registration.effects.length === 0) {
    throw new Error(`VFX preset ${registration.name} 至少需要一个 effect`)
  }
}
