import { Ticker } from 'pixi.js'

export default class AnimationManager {
  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const task = new Promise<void>((resolve) => {
      const ticker = new Ticker()
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
          progress = progress + ticker.elapsedMS / time_ms
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
