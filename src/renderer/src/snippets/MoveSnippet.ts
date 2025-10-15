import BaseSnippet from './BaseSnippet'
import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import { MoveSpeed } from '../../../common/types/Story'

export default class MoveSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Move') return

    const model = this.app.getModelById(this.data.data.modelId)
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

    let move_task: Promise<void> | null = null

    if ((from.x === to.x && to.y === to.y) || this.data.data.moveSpeed === MoveSpeed.Immediate) {
      model.setPositionRel(this.app.stage_size, to)
    } else {
      move_task = model.move(
        this.app.stage_size,
        from,
        to,
        StageUtils.move_speed_to_num(this.data.data.moveSpeed)
      )
    }

    await move_task
  }
}
