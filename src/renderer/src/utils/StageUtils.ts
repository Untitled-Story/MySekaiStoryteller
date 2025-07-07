import { LayoutModes, MoveSpeed, Sides } from '../../../common/types/Story'
import Position_rel from '../types/PositionRel'

export default class StageUtils {
  public static side_to_position(
    side: Sides,
    layout_mode: LayoutModes,
    offset: number
  ): Position_rel {
    const position_map = {
      [LayoutModes.Normal]: {
        [Sides.Center]: [0.5, 0.5],
        [Sides.Left]: [0.3, 0.5],
        [Sides.Right]: [0.7, 0.5]
      },
      [LayoutModes.Three]: {
        [Sides.Center]: [0.5, 0.5],
        [Sides.Left]: [0.25, 0.5],
        [Sides.Right]: [0.75, 0.5]
      }
    }

    const position = [...(position_map[layout_mode][side] as [number, number])]
    position[0] += offset / 1920
    return {
      x: position[0],
      y: position[1]
    }
  }

  public static move_speed_to_num(move_speed: MoveSpeed): number {
    return {
      [MoveSpeed.Slow]: 700,
      [MoveSpeed.Normal]: 500,
      [MoveSpeed.Fast]: 300
    }[move_speed]
  }
}
