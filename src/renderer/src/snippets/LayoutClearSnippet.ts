import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import BaseSnippet from './BaseSnippet'

// noinspection DuplicatedCode
export default class LayoutClearSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutClear') return

    const model = this.app.getModelById(this.data.data.modelId)

    let move_task: Promise<void> | null = null
    const hide_task = model.hide(50)

    const from: PositionRel = StageUtils.side_to_position(
      this.data.data.from.side,
      this.app.layerModel.layoutMode,
      this.data.data.from.offset,
      this.app.stage_size[0]
    )
    const to: PositionRel = StageUtils.side_to_position(
      this.data.data.to.side,
      this.app.layerModel.layoutMode,
      this.data.data.to.offset,
      this.app.stage_size[0]
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

    this.app.layerModel.removeModel(model)

    await hide_task
    if (move_task) await move_task
  }
}
