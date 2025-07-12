import BaseLayer from './BaseLayer'
import { Application } from 'pixi.js'
import { LayoutModes } from '../../../common/types/Story'
import AdvancedModel from '../model/AdvancedModel'

export default class ModelLayer extends BaseLayer {
  public layoutMode: LayoutModes = LayoutModes.Normal

  constructor(app: Application) {
    super(app, 1)
  }

  public addModelAndInitialize(model: AdvancedModel): void {
    const scale = this.app.screen.height / model.internalModel.originalHeight
    model.scale.set(scale * (this.layoutMode === LayoutModes.Normal ? 2.1 : 1.8))

    this.layerContainer.addChild(model)
  }

  public removeModel(model: AdvancedModel): void {
    this.layerContainer.removeChild(model)
  }
}
