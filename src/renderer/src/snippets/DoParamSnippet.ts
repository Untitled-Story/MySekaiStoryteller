import BaseSnippet from './BaseSnippet'
import { Cubism2InternalModel, Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import AnimationManager from '../managers/AnimationManager'
import { Curves } from '../../../common/types/Story'
import AdvancedModel from '../model/AdvancedModel'

export default class DoParamSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'DoParam') return

    const model = this.app.getModelById(this.data.data.modelId)
    const tasks = this.data.data.params.map((group) =>
      this.runParamAnim(
        model,
        group.paramId,
        group.start,
        group.end,
        group.curve,
        group.duration * 1000
      )
    )

    if (this.data.wait) {
      await Promise.all(tasks)
    }
  }

  private async runParamAnim(
    model: AdvancedModel,
    paramId: string,
    start: number,
    end: number,
    curve: Curves,
    time_ms: number
  ): Promise<void> {
    const setter = (value: number): void => {
      if (model.internalModel instanceof Cubism4InternalModel) {
        model.internalModel.coreModel.setParameterValueById(paramId, value)
      } else if (model.internalModel instanceof Cubism2InternalModel) {
        model.internalModel.coreModel.setParamFloat(paramId, value)
      }
    }

    let runner: (animation: (progress: number) => void, time_ms: number) => Promise<void> =
      AnimationManager.linear

    if (curve === Curves.Sine) runner = AnimationManager.sine
    else if (curve === Curves.Cosine) runner = AnimationManager.cosine

    return runner((p) => setter(start + (end - start) * p), time_ms)
  }
}
