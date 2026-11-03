const EYE_OPEN_PARAMETER_IDS: readonly [left: string, right: string] = [
  'ParamEyeLOpen',
  'ParamEyeROpen'
]

type Live2DCoreModelLike = {
  getParameterValueById?: (id: unknown) => number
  setParameterValueById?: (id: unknown, value: number, weight?: number) => unknown
}

type Live2DInternalModelLike = {
  readonly coreModel?: Live2DCoreModelLike
  getIdSafe?: (id: string) => unknown
  on?: (event: 'beforeMotionUpdate' | 'afterMotionUpdate', listener: () => void) => unknown
}

type ParallelMotionManagerLike = {
  update?: (model: object, now: number) => boolean
}

type EyeValues = readonly [left: number, right: number]
type EyeParameterIds = readonly [left: unknown, right: unknown]

type ActiveComposition = {
  readonly token: number
  facial: EyeValues
  motion: EyeValues
}

const compositors: WeakMap<object, Live2DEyeMotionCompositor> = new WeakMap()

/**
 * Composes facial eye openness with a motion's eye curves for one playback.
 * Returns undefined for runtimes that do not expose Cubism 3+ parameter APIs.
 */
export function composeLive2DEyeMotion(
  internalModel: Live2DInternalModelLike,
  motionManager: ParallelMotionManagerLike,
  facialManager: ParallelMotionManagerLike
): (() => void) | undefined {
  if (
    !internalModel.coreModel?.getParameterValueById ||
    !internalModel.coreModel.setParameterValueById ||
    !internalModel.on ||
    !motionManager.update ||
    !facialManager.update
  ) {
    return undefined
  }

  let compositor: Live2DEyeMotionCompositor | undefined = compositors.get(internalModel)
  if (!compositor) {
    compositor = new Live2DEyeMotionCompositor(internalModel, motionManager, facialManager)
    compositors.set(internalModel, compositor)
  }

  return compositor.begin()
}

class Live2DEyeMotionCompositor {
  private readonly coreModel: Required<
    Pick<Live2DCoreModelLike, 'getParameterValueById' | 'setParameterValueById'>
  >
  private readonly parameterIds: EyeParameterIds
  private readonly motionManager: ParallelMotionManagerLike
  private readonly facialManager: ParallelMotionManagerLike
  private readonly updateMotion: (model: object, now: number) => boolean
  private readonly updateFacial: (model: object, now: number) => boolean
  private active?: ActiveComposition
  private nextToken: number = 0

  constructor(
    internalModel: Live2DInternalModelLike,
    motionManager: ParallelMotionManagerLike,
    facialManager: ParallelMotionManagerLike
  ) {
    this.coreModel = internalModel.coreModel as Required<
      Pick<Live2DCoreModelLike, 'getParameterValueById' | 'setParameterValueById'>
    >
    this.parameterIds = [
      internalModel.getIdSafe?.(EYE_OPEN_PARAMETER_IDS[0]) ?? EYE_OPEN_PARAMETER_IDS[0],
      internalModel.getIdSafe?.(EYE_OPEN_PARAMETER_IDS[1]) ?? EYE_OPEN_PARAMETER_IDS[1]
    ]
    this.motionManager = motionManager
    this.facialManager = facialManager
    this.updateMotion = motionManager.update as (model: object, now: number) => boolean
    this.updateFacial = facialManager.update as (model: object, now: number) => boolean

    motionManager.update = (model: object, now: number): boolean =>
      this.updateMotionLayer(model, now)
    facialManager.update = (model: object, now: number): boolean =>
      this.updateFacialLayer(model, now)
    internalModel.on?.('beforeMotionUpdate', (): void => this.beforeMotionUpdate())
    internalModel.on?.('afterMotionUpdate', (): void => this.afterMotionUpdate())
  }

  begin(): () => void {
    const token: number = ++this.nextToken
    this.active = {
      token,
      facial: this.readEyeValues(),
      motion: [1, 1]
    }

    return (): void => {
      if (this.active?.token === token) {
        this.active = undefined
      }
    }
  }

  private beforeMotionUpdate(): void {
    if (this.active) {
      // Do not feed the previous frame's multiplied result back into either layer.
      this.writeEyeValues(this.active.facial)
    }
  }

  private updateMotionLayer(model: object, now: number): boolean {
    const active: ActiveComposition | undefined = this.active
    if (!active) {
      return this.updateMotion.call(this.motionManager, model, now)
    }

    // Eye curves in a motion are blink percentages, so evaluate them from a neutral value.
    this.writeEyeValues([1, 1])
    try {
      const updated: boolean = this.updateMotion.call(this.motionManager, model, now)
      if (updated && this.active === active) {
        active.motion = this.readEyeValues()
      }
      return updated
    } finally {
      if (this.active === active) {
        this.writeEyeValues(active.facial)
      }
    }
  }

  private updateFacialLayer(model: object, now: number): boolean {
    const active: ActiveComposition | undefined = this.active
    const updated: boolean = this.updateFacial.call(this.facialManager, model, now)
    if (updated && active && this.active === active) {
      active.facial = this.readEyeValues()
    }
    return updated
  }

  private afterMotionUpdate(): void {
    const active: ActiveComposition | undefined = this.active
    if (!active) return

    this.writeEyeValues([active.facial[0] * active.motion[0], active.facial[1] * active.motion[1]])
  }

  private readEyeValues(): EyeValues {
    return [
      this.coreModel.getParameterValueById(this.parameterIds[0]),
      this.coreModel.getParameterValueById(this.parameterIds[1])
    ]
  }

  private writeEyeValues(values: EyeValues): void {
    this.coreModel.setParameterValueById(this.parameterIds[0], values[0])
    this.coreModel.setParameterValueById(this.parameterIds[1], values[1])
  }
}
