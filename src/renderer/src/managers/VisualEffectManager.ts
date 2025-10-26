import { Ticker } from 'pixi.js'
import AdvancedModel from '../model/AdvancedModel'
import { VisualEffect } from '../effects/VisualEffect'
import { HologramEffect } from '../effects/HologramEffect'
import TriangleParticleEffect from '../effects/TriangleParticleEffect'

interface EffectSet {
  effects: Record<string, VisualEffect>
}

export class VisualEffectManager {
  private effectSet: EffectSet = { effects: {} }
  private ticker: Ticker = new Ticker()
  private readonly effectFactories: Record<string, () => VisualEffect> = {}

  constructor(private model: AdvancedModel) {
    this.effectFactories = {
      hologram: () => new HologramEffect(this.model, this.model.width, this.model.height),
      triangles: () => new TriangleParticleEffect(this.model)
    }

    this.ticker.add((delta) => this.updateAll(delta))
    this.ticker.start()
  }

  private updateAll(delta: number): void {
    for (const name in this.effectSet.effects) {
      this.effectSet.effects[name].update(delta)
    }
  }

  public createAll(): void {
    for (const name in this.effectFactories) {
      if (!this.effectSet.effects[name]) {
        this.effectSet.effects[name] = this.effectFactories[name]()
      }
    }
  }

  public applyEffect(effectName: string): void {
    const effect = this.effectSet.effects[effectName]
    if (!effect) return

    if (!effect.parent) this.model.addChild(effect)
    effect.enabled = true
    this.model.filters = this.model.filters
      ? [...this.model.filters, ...effect.parentFilters]
      : [...effect.parentFilters]
    console.info(this.model.filters)
  }

  public disable(effectName: string): void {
    const effect = this.effectSet.effects[effectName]
    if (!effect) return

    effect.enabled = false
    if (effect.parent) effect.parent.removeChild(effect)
    if (this.model.filters) {
      this.model.filters = this.model.filters.filter((f) => !effect.parentFilters.includes(f))
    }

    effect.destroyEffect()
    delete this.effectSet.effects[effectName]
  }

  public getEffect(effectName: string): VisualEffect | undefined {
    return this.effectSet.effects[effectName]
  }

  public stopTicker(): void {
    this.ticker.stop()
  }

  public startTicker(): void {
    this.ticker.start()
  }

  public disableAll(): void {
    for (const name in this.effectSet.effects) {
      this.disable(name)
    }
  }
}
