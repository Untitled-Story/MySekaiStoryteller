import { Container, Filter } from 'pixi.js'
import AdvancedModel from '../model/AdvancedModel'

export abstract class VisualEffect extends Container {
  protected model: AdvancedModel
  protected _parentFilters: Filter[] = []

  protected constructor(model: AdvancedModel) {
    super()
    this.model = model
  }

  public get parentFilters(): Filter[] {
    return this._parentFilters
  }

  abstract update(delta: number): void
  abstract destroyEffect(): void
}
