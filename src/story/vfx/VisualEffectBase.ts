import { Container } from 'pixi.js'
import type { Filter } from 'pixi.js'
import type { StoryVisualEffect } from './types'
import type { StoryVisualEffectContext } from './types'
import type { StoryModelInstance } from '@/story/types'

export abstract class VisualEffectBase extends Container implements StoryVisualEffect {
  protected readonly modelInstance: StoryModelInstance
  protected readonly model: StoryModelInstance['model']
  protected _parentFilters: Filter[] = []
  enabled = false

  protected constructor(context: StoryVisualEffectContext) {
    super()
    if (!context.target.model) {
      throw new Error('该 VFX 只能应用于模型 target')
    }
    this.modelInstance = context.target.model
    this.model = context.target.model.model
  }

  get container(): Container {
    return this
  }

  get parentFilters(): readonly Filter[] {
    return this._parentFilters
  }

  abstract update(delta: number): void

  abstract destroyEffect(): void

  clearAllParticles(): void {
    // Optional hook for particle effects.
  }
}
