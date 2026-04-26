import { Ticker, UPDATE_PRIORITY } from 'pixi.js'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'

type AnimationMode = 'realtime' | 'manual'

export default class AnimationManager {
  private static logger: Logger<ILogObj> = getSubLogger('AnimationManager').getSubLogger({
    name: 'WatchDog'
  })

  private static mode: AnimationMode = 'realtime'
  private static boundTicker: Ticker | null = null
  private static trackedTaskCount = 0
  private static manualTimeMs = 0

  public static setMode(mode: AnimationMode): void {
    this.mode = mode
  }

  public static bindTicker(ticker: Ticker): void {
    this.boundTicker = ticker
  }

  public static setManualTime(timeMs: number): void {
    this.manualTimeMs = timeMs
  }

  public static now(): number {
    return this.mode === 'manual' ? this.manualTimeMs : performance.now()
  }

  public static hasTrackedTasks(): boolean {
    return this.trackedTaskCount > 0
  }

  private static beginTrackedTask(track: boolean): () => void {
    if (!track) return () => {}

    this.trackedTaskCount++
    let finished = false

    return () => {
      if (finished) return

      finished = true
      this.trackedTaskCount--
    }
  }

  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean,
    track: boolean = true
  ): Promise<void> {
    if (this.mode === 'manual') {
      await this.inBoundTicker(on_step, when_finish, track)
      return
    }

    await this.inRealtimeTicker(on_step, when_finish, track)
  }

  private static async inRealtimeTicker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean,
    track: boolean
  ): Promise<void> {
    const finishTrackedTask = this.beginTrackedTask(track)

    const task = new Promise<void>((resolve, reject) => {
      const ticker = new Ticker()
      ticker.maxFPS = 60

      const listener = (): void => {
        try {
          on_step(ticker)
          if (when_finish(ticker)) {
            ticker.destroy()
            finishTrackedTask()
            resolve()
          }
        } catch (error) {
          ticker.destroy()
          finishTrackedTask()
          reject(error)
        }
      }

      ticker.add(listener, undefined, UPDATE_PRIORITY.INTERACTION)
      ticker.start()
    })

    await task
  }

  private static async inBoundTicker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean,
    track: boolean
  ): Promise<void> {
    if (!this.boundTicker) {
      throw new Error('AnimationManager manual mode requires a bound ticker.')
    }

    const ticker = this.boundTicker
    const finishTrackedTask = this.beginTrackedTask(track)

    await new Promise<void>((resolve, reject) => {
      const listener = (): void => {
        try {
          on_step(ticker)
          if (when_finish(ticker)) {
            ticker.remove(listener)
            finishTrackedTask()
            resolve()
          }
        } catch (error) {
          ticker.remove(listener)
          finishTrackedTask()
          reject(error)
        }
      }

      ticker.add(listener, undefined, UPDATE_PRIORITY.INTERACTION)
    })
  }

  public static async linear(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false,
    track: boolean = true
  ): Promise<void> {
    let progress = 0
    animation(0)

    if (time_ms >= 30) {
      await AnimationManager.in_ticker(
        (ticker) => {
          const rawDeltaTime = ticker.elapsedMS
          let usedTime = rawDeltaTime
          if (elegant && usedTime > 30 && usedTime < 100) {
            usedTime = 25
          }
          if (usedTime > 100) {
            this.logger.warn(`A frame time of up to ${rawDeltaTime.toFixed(2)}ms has been detected`)
            usedTime = 20
          }

          progress += usedTime / time_ms
          progress = Math.min(progress, 1)
          animation(progress)
        },
        () => progress >= 1,
        track
      )
    }
    animation(1)
  }

  public static async cosine(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false,
    track: boolean = true
  ): Promise<void> {
    await AnimationManager.linear(
      (p) => {
        const eased = (1 - Math.cos(p * Math.PI)) / 2
        animation(eased)
      },
      time_ms,
      elegant,
      track
    )
  }

  public static async sine(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false,
    track: boolean = true
  ): Promise<void> {
    await AnimationManager.linear(
      (p) => {
        const eased = Math.sin((p * Math.PI) / 2)
        animation(eased)
      },
      time_ms,
      elegant,
      track
    )
  }

  public static async delay(time_ms: number, track: boolean = true): Promise<void> {
    if (time_ms <= 0) return

    const finishTrackedTask = this.beginTrackedTask(track)

    if (this.mode === 'manual') {
      if (!this.boundTicker) {
        finishTrackedTask()
        throw new Error('AnimationManager manual mode requires a bound ticker.')
      }

      const ticker = this.boundTicker
      let elapsed = 0

      await new Promise<void>((resolve, reject) => {
        const listener = (): void => {
          try {
            elapsed += ticker.elapsedMS

            if (elapsed >= time_ms) {
              ticker.remove(listener)
              finishTrackedTask()
              resolve()
            }
          } catch (error) {
            ticker.remove(listener)
            finishTrackedTask()
            reject(error)
          }
        }

        ticker.add(listener, undefined, UPDATE_PRIORITY.INTERACTION)
      })
      return
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        finishTrackedTask()
        resolve()
      }, time_ms)
    })
  }
}
