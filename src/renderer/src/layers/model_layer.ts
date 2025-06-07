import BaseLayer from './base_layer'
import { Application, Container } from 'pixi.js'
import { LayoutModes } from '../../../common/types/story'
import AdvancedModel from '../model/advanced_model'

export default class ModelLayer extends BaseLayer {
  public readonly container: Container

  public layoutMode: LayoutModes = LayoutModes.Normal

  constructor(app: Application) {
    super(app)

    this.container = new Container()
    this.container.zIndex = 1

    this.stage.addChild(this.container)
  }

  public addModelAndInitialize(model: AdvancedModel): void {
    model.anchor.set(0.5)

    const scale = this.app.screen.height / model.internalModel.originalHeight
    model.scale.set(scale * (this.layoutMode === LayoutModes.Normal ? 2.1 : 1.8))

    this.container.addChild(model)
  }
}
