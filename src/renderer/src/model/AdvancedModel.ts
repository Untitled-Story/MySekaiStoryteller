import {
  Cubism2InternalModel,
  Cubism4InternalModel,
  Live2DModel,
  MotionPriority
} from 'pixi-live2d-display-advanced'
import AnimationManager from '../managers/AnimationManager'
import PositionRel from '../types/PositionRel'
import { getRandomNumber } from '../utils/HelperUtils'
import { ModelData } from '../../../common/types/Story'
import { VisualEffectManager } from '../managers/VisualEffectManager'
import { AlphaFilter, Ticker } from 'pixi.js'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'

export default class AdvancedModel extends Live2DModel {
  public autoBlink: boolean = true
  public lastChangeBlinkTime: number | null = null

  private _metadata: ModelData | null = null

  private visualEffectManager!: VisualEffectManager
  private inHologram: boolean = false

  private logger: Logger<ILogObj> = getSubLogger('AdvancedModel[Uninitialized]')

  get metadata(): ModelData {
    return this._metadata!
  }

  public initialize(metadata: ModelData, ticker: Ticker): void {
    if (!this._metadata) {
      this._metadata = metadata
    } else {
      throw new Error('Initialize model metadata more than once.')
    }
    this.visible = true
    this.internalModel.extendParallelMotionManager(2)

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2

    this.filters = [alpha_filter]

    this.anchor.x = 0.5
    this.anchor.y = this.metadata.anchor

    this.visualEffectManager = new VisualEffectManager(this, ticker)
    this.visualEffectManager.createAll()

    this.logger = getSubLogger(`AdvancedModel(${this._metadata.id})`)
  }

  public async applyMotion(motion: string, ignoreParams: boolean = false): Promise<void> {
    const manager = this.internalModel.parallelMotionManager[0]
    if (ignoreParams) {
      await manager.startMotion(motion, 0, MotionPriority.FORCE, [
        'ParamEyeROpen',
        'ParamEyeLOpen',
        'ParamEyeballX',
        'ParamEyeballY'
      ])
    } else {
      await manager.startMotion(motion, 0, MotionPriority.FORCE)
    }
  }

  public async applyFacial(facial: string): Promise<void> {
    const manager = this.internalModel.parallelMotionManager[1]
    await manager.startMotion(facial, 0, MotionPriority.FORCE)
  }

  public async show(time: number, hologram: boolean): Promise<void> {
    this.autoBlink = true

    if (hologram) {
      this.inHologram = true
      this.visualEffectManager.applyEffect('hologram')
      this.visualEffectManager.applyEffect('triangles')
    }

    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)

    this.lastChangeBlinkTime = AnimationManager.now()
    AnimationManager.delay(getRandomNumber(4000, 6500), false)
      .then(() => this.updateAutoBlink())
      .catch(this.logger.error)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)

    if (this.inHologram) {
      this.inHologram = false
      this.visualEffectManager.disableAll()
    }

    this.lastChangeBlinkTime = AnimationManager.now()
    this.autoBlink = false
  }

  public async applyAndWait(
    motion?: string,
    facial?: string,
    facialFirst?: boolean
  ): Promise<void> {
    const waits: Promise<void>[] = []
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    if (motion) {
      waits.push(this.applyMotion(motion, facialFirst))
    }
    if (facial) {
      waits.push(this.applyFacial(facial))
    }

    this.lastChangeBlinkTime = AnimationManager.now()

    await Promise.all(waits)

    await AnimationManager.in_ticker(
      () => {},
      () => motion_manager.isFinished() && facial_manager.isFinished()
    )

    this.lastChangeBlinkTime = AnimationManager.now()
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

    await AnimationManager.linear((progress) => {
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

  public async closeEyes(time_ms: number, track: boolean = true): Promise<void> {
    await AnimationManager.linear(
      (progress) => {
        if (this.internalModel instanceof Cubism2InternalModel) {
          this.internalModel.eyeBlink!.setEyeParams(1 - progress)
        } else if (this.internalModel instanceof Cubism4InternalModel) {
          this.internalModel.coreModel.setParameterValueById('ParamEyeLOpen', 1 - progress)
          this.internalModel.coreModel.setParameterValueById('ParamEyeROpen', 1 - progress)
        } else {
          throw new Error('Not implement.')
        }
      },
      time_ms,
      false,
      track
    )
  }

  public async openEyes(
    time_ms: number,
    max_value: number = 1,
    track: boolean = true
  ): Promise<void> {
    await AnimationManager.linear(
      (progress) => {
        if (this.internalModel instanceof Cubism2InternalModel) {
          this.internalModel.eyeBlink!.setEyeParams(progress * max_value)
        } else if (this.internalModel instanceof Cubism4InternalModel) {
          this.internalModel.coreModel.setParameterValueById('ParamEyeLOpen', progress * max_value)
          this.internalModel.coreModel.setParameterValueById('ParamEyeROpen', progress * max_value)
        } else {
          throw new Error('Not implement.')
        }
      },
      time_ms,
      false,
      track
    )
  }

  private async updateAutoBlink(): Promise<void> {
    while (this.autoBlink) {
      const now = AnimationManager.now()
      if (this.lastChangeBlinkTime && now - this.lastChangeBlinkTime < 2500) {
        await AnimationManager.delay(500, false)
        continue
      }

      if (this.internalModel instanceof Cubism2InternalModel) {
        if (
          this.internalModel.coreModel.getParamFloat('PARAM_EYE_L_OPEN') < 1 ||
          this.internalModel.coreModel.getParamFloat('PARAM_EYE_R_OPEN') < 1
        ) {
          this.logger.info('Blink has been blocked by eye param')
          await AnimationManager.delay(getRandomNumber(4000, 6500), false)
          continue
        }
      } else if (this.internalModel instanceof Cubism4InternalModel) {
        if (
          this.internalModel.coreModel.getParameterValueById('ParamEyeLOpen') < 1 ||
          this.internalModel.coreModel.getParameterValueById('ParamEyeROpen') < 1
        ) {
          this.logger.info('Blink has been blocked by eye param')
          await AnimationManager.delay(getRandomNumber(4000, 6500), false)
          continue
        }
      } else {
        throw new Error('Not implement.')
      }

      await this.closeEyes(200, false)
      await this.openEyes(250, 1, false)

      this.lastChangeBlinkTime = AnimationManager.now()

      await AnimationManager.delay(getRandomNumber(4000, 6500), false)
    }
  }
}
