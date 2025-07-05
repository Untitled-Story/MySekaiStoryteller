import BaseSnippet from './BaseSnippet'
import { SnippetData } from '../../../common/types/Story'
import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import AnimationManager from '../managers/AnimationManager'

export default class LayoutAppearSnippet extends BaseSnippet {
  async handleSnippet(snippet: SnippetData): Promise<void> {
    if (snippet.type !== 'LayoutAppear') {
      return
    }

    const model = this.app.getModelById(snippet.data.modelId)
    this.app.layerModel.addModelAndInitialize(model)

    await model.playMotionLastFrame(snippet.data.motion, snippet.data.facial)

    const show_task = model.show(200)
    let move_task: Promise<void> | null = null

    const from: PositionRel = StageUtils.side_to_position(
      snippet.data.from.side,
      this.app.layerModel.layoutMode,
      snippet.data.from.offset
    )
    const to: PositionRel = StageUtils.side_to_position(
      snippet.data.to.side,
      this.app.layerModel.layoutMode,
      snippet.data.to.offset
    )

    if (from.x === to.x && to.y === to.y) {
      model.setPositionRel(this.app.stage_size, to)
    } else {
      move_task = model.move(from, to, StageUtils.move_speed_to_num(snippet.data.moveSpeed))
    }

    AnimationManager.delay(10).then(() =>
      model.applyAndWait(snippet.data.motion, snippet.data.facial)
    )

    await show_task
    if (move_task) await move_task
  }
}
