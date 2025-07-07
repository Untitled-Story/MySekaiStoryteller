import { Live2DModel, MotionPriority } from 'pixi-live2d-display-advanced'
import { AlphaFilter } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import PositionRel from '../types/PositionRel'

export default class AdvancedModel extends Live2DModel {
  private _is_showed = false

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

  public async clear(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha = 1 - progress
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = alpha
    }, time)

    this._is_showed = false
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
