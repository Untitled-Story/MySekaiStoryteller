import { Ticker } from 'pixi.js'
import { FIXED_FPS } from '../constants'

export default class AnimationManager {
  private static MAX_DELTA_MS: number = Math.floor(1000 / FIXED_FPS)

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
      })
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
          const clampedDelta = Math.min(rawDelta, this.MAX_DELTA_MS)

          progress += clampedDelta / time_ms
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
