import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import AnimationManager from '../managers/AnimationManager'
import BaseSnippet from './BaseSnippet'

// noinspection DuplicatedCode
export default class LayoutAppearSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutAppear') return

    const model = this.app.getModelById(this.data.data.modelId)
    this.app.layerModel.addModelToLayer(model)

    await model.playMotionLastFrame(this.data.data.motion, this.data.data.facial)

    const show_task = model.show(200, this.data.data.hologram)

    if (this.data.data.motion) {
      await model.closeEyes(0)
    }

    let move_task: Promise<void> | null = null

    const from: PositionRel = StageUtils.side_to_position(
      this.data.data.from.side,
      this.app.layerModel.layoutMode,
      this.data.data.from.offset
    )
    const to: PositionRel = StageUtils.side_to_position(
      this.data.data.to.side,
      this.app.layerModel.layoutMode,
      this.data.data.to.offset
    )

    if (from.x === to.x && to.y === to.y) {
      model.setPositionRel(this.app.stage_size, to)
    } else {
      move_task = model.move(
        this.app.stage_size,
        from,
        to,
        StageUtils.move_speed_to_num(this.data.data.moveSpeed)
      )
    }

    AnimationManager.delay(10).then(() => {
      if (this.data.type !== 'LayoutAppear') return

      model.applyAndWait(this.data.data.motion, this.data.data.facial, this.data.data.facialFirst)
    })

    await show_task
    if (move_task) await move_task
  }
}
