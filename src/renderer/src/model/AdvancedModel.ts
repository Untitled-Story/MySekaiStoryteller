import { Live2DModel, MotionPriority } from 'pixi-live2d-display-advanced'
import { AlphaFilter } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import PositionRel from '../types/PositionRel'

export default class AdvancedModel extends Live2DModel {
  public async applyMotion(motion: string): Promise<void> {
    const manager = this.internalModel.parallelMotionManager[0]
    await manager.startMotion(motion, 0, MotionPriority.FORCE)
  }

  public async applyFacial(facial: string): Promise<void> {
    const manager = this.internalModel.parallelMotionManager[1]
    await manager.startMotion(facial, 0, MotionPriority.FORCE)
  }

  public async show(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)
  }

  public async applyAndWait(motion?: string, facial?: string): Promise<void> {
    const waits: Promise<unknown>[] = []
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    if (motion) {
      waits.push(this.applyMotion(motion))
    }
    if (facial) {
      waits.push(this.applyFacial(facial))
    }

    await Promise.all(waits)

    await AnimationManager.in_ticker(
      () => {},
      () => motion_manager.isFinished() && facial_manager.isFinished()
    )
  }

  public setPositionRel(stage_size: [number, number], position: PositionRel): void {
    this.position.set(stage_size[0] * position.x, stage_size[1] * (position.y + 0.3))
  }

  public async move(
    stage_size: [number, number],
    from: PositionRel,
    to: PositionRel,
    time_ms: number
  ): Promise<void> {
    if (from === to) return

    const abs_from: [number, number] = [stage_size[0] * from.x, stage_size[1] * (from.y + 0.3)]
    const abs_to: [number, number] = [stage_size[0] * to.x, stage_size[1] * (to.y + 0.3)]

    await AnimationManager.run((progress) => {
      this.position.x = (abs_to[0] - abs_from[0]) * progress + abs_from[0]
      this.position.y = (abs_to[1] - abs_from[1]) * progress + abs_from[1]
    }, time_ms)
  }

  public async playMotionLastFrame(motion?: string, facial?: string): Promise<void> {
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    const waits: Promise<unknown>[] = []

    if (motion) {
      waits.push(motion_manager.playMotionLastFrame(motion, 0))
    }

    if (facial) {
      waits.push(facial_manager.playMotionLastFrame(facial, 0))
    }

    const results = (await Promise.all(waits)) as boolean[]

    if (results.includes(false)) {
      await this.applyAndWait(motion, facial)
    } else {
      await AnimationManager.in_ticker(
        () => {},
        () => motion_manager.isFinished() && facial_manager.isFinished()
      )
    }
  }
}
