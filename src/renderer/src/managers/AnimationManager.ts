import { Ticker, UPDATE_PRIORITY } from 'pixi.js'
import { FIXED_FPS } from '../constants'
import getSubLogger from '../utils/Logger'
import { Logger, ILogObj } from 'tslog'

export default class AnimationManager {
  private static MAX_DELTA_MS: number = Math.floor(1000 / FIXED_FPS)
  private static Logger: Logger<ILogObj> = getSubLogger('AnimationManager')

  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const task = new Promise<void>((resolve) => {
      const ticker = new Ticker()

      ticker.minFPS = FIXED_FPS
      ticker.maxFPS = FIXED_FPS

      ticker.add(() => {
        on_step(ticker)
        if (when_finish(ticker)) {
          resolve()
          ticker.destroy()
        }
      }, UPDATE_PRIORITY.INTERACTION)
      ticker.start()
    })
    await task
  }

  public static async run(animation: (progress: number) => void, time_ms: number): Promise<void> {
    let progress = 0
    animation(0)

    if (time_ms >= 30) {
      await AnimationManager.in_ticker(
        (ticker) => {
          const rawDelta = ticker.elapsedMS
          const ratio = this.MAX_DELTA_MS / rawDelta

          let usedDelta: number
          if (ratio >= 0.9 && ratio <= 1) {
            usedDelta = rawDelta
          } else if (ratio >= 0.8 && ratio < 0.9) {
            usedDelta = this.MAX_DELTA_MS
          } else {
            if (ratio <= 0.1) {
              this.Logger.warn(
                `A frame time of up to ${rawDelta}ms has been detected, with a ratio of ${ratio.toFixed(2)}. Is this really okay?`
              )
            }

            usedDelta = rawDelta
          }

          progress += usedDelta / time_ms
          progress = Math.min(progress, 1)
          animation(progress)
        },
        () => progress >= 1
      )
    }
    animation(1)
  }

  public static async delay(time_ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, time_ms)
    })
  }
}
