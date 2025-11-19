import { Ticker, UPDATE_PRIORITY } from 'pixi.js'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'

export default class AnimationManager {
  private static logger: Logger<ILogObj> = getSubLogger('AnimationManager').getSubLogger({
    name: 'WatchDog'
  })

  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const task = new Promise<void>((resolve) => {
      const ticker = new Ticker()
      ticker.maxFPS = 60

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

  public static async linear(
    animation: (progress: number) => void,
    time_ms: number
  ): Promise<void> {
    let progress = 0
    animation(0)

    if (time_ms >= 30) {
      await AnimationManager.in_ticker(
        (ticker) => {
          const rawDeltaTime = ticker.elapsedMS
          let usedTime = rawDeltaTime
          if (usedTime > 100) {
            this.logger.warn(`A frame time of up to ${rawDeltaTime.toFixed(2)}ms has been detected`)
            usedTime = 20
          }

          progress += usedTime / time_ms
          progress = Math.min(progress, 1)
          animation(progress)
        },
        () => progress >= 1
      )
    }
    animation(1)
  }

  public static async cosine(
    animation: (progress: number) => void,
    time_ms: number
  ): Promise<void> {
    await AnimationManager.linear((p) => {
      const eased = (1 - Math.cos(p * Math.PI)) / 2
      animation(eased)
    }, time_ms)
  }

  public static async sine(animation: (progress: number) => void, time_ms: number): Promise<void> {
    await AnimationManager.linear((p) => {
      const eased = Math.sin((p * Math.PI) / 2)
      animation(eased)
    }, time_ms)
  }

  public static async delay(time_ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, time_ms)
    })
  }
}
