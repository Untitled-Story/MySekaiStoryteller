import BaseSnippet from './BaseSnippet'

export default class MotionSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Motion') return

    const model = this.app.getModelById(this.data.data.modelId)
    this.app.layerModel.addModelAndInitialize(model)

    await model.applyAndWait(this.data.data.motion, this.data.data.facial)
  }
}
