import { Container } from 'pixi.js'
import type { Filter } from 'pixi.js'
import type { StoryModelInstance } from '@/story/types'
import type { StoryVisualEffect } from './types'

export abstract class VisualEffectBase extends Container implements StoryVisualEffect {
  protected readonly modelInstance: StoryModelInstance
  protected readonly model: StoryModelInstance['model']
  protected _parentFilters: Filter[] = []
  enabled = false

  protected constructor(model: StoryModelInstance) {
    super()
    this.modelInstance = model
    this.model = model.model
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
