import AdvancedModel from '../model/AdvancedModel'
import { Container, Filter } from 'pixi.js'

export abstract class VisualEffect extends Container {
  protected model: AdvancedModel
  protected _parentFilters: Filter[] = []
  public enabled: boolean = false

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
