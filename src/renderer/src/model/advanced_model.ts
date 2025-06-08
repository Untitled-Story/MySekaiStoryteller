import {
  Live2DModel,
  MotionPriority,
  Cubism4ParallelMotionManager
} from 'pixi-live2d-display-advanced'
import { AlphaFilter } from 'pixi.js'
import AnimationManager from '../managers/animation_manager'
import PositionRel from '../types/position_rel'
import getSubLogger from '../utils/logger'

export default class AdvancedModel extends Live2DModel {
  private _is_showed = false
  private logger = getSubLogger('AdvancedModel')

  get is_showed(): boolean {
    return this._is_showed
  }

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

    this._is_showed = true
  }

  public async applyAndWait(motion?: string, facial?: string): Promise<void> {
    const waits: Promise<unknown>[] = []
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    this.logger.debug('Applying motions')
    if (motion) {
      waits.push(this.applyMotion(motion))
    }
    if (facial) {
      waits.push(this.applyFacial(facial))
    }

    await Promise.all(waits)

    this.logger.debug('Waiting for motions finish')

    await AnimationManager.in_ticker(
      () => {},
      () => motion_manager.isFinished() && facial_manager.isFinished()
    )
    this.logger.debug('Motions finished')
  }

  public setPositionRel(stage_size: [number, number], position: PositionRel): void {
    this.position.set(stage_size[0] * position.x, stage_size[1] * (position.y + 0.3))
  }

  public async move(from: PositionRel, to: PositionRel, time_ms: number): Promise<void> {
    if (from === to) return

    await AnimationManager.run((progress) => {
      this.position.x = (to.x - from.x) * progress + from.x
      this.position.y = (to.y - from.y) * progress + to.y
    }, time_ms)
  }

  public async playMotionLastFrame(motion?: string, facial?: string): Promise<void> {
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    const waits: Promise<unknown>[] = []

    if (
      motion_manager instanceof Cubism4ParallelMotionManager &&
      facial_manager instanceof Cubism4ParallelMotionManager
    ) {
      if (motion) {
        waits.push(motion_manager.playMotionLastFrame(this, motion, 0))
      }

      if (facial) {
        waits.push(facial_manager.playMotionLastFrame(this, facial, 0))
      }

      await Promise.all(waits)

      await AnimationManager.in_ticker(
        () => {},
        () => motion_manager.isFinished() && facial_manager.isFinished()
      )
    } else {
      await this.applyAndWait(motion, facial)
    }
  }
}
