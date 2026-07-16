import type { Application, Ticker } from 'pixi.js'
import { pauseSekaiLive2DSounds, resumeSekaiLive2DSounds } from '@/lib/live2d'
import { StoryAbortError } from './types'

type ClockTask = {
  tick(deltaMs: number): void
  cancel(): void
}

export class StoryPlaybackClock {
  private readonly app: Application
  private readonly tasks: Set<ClockTask> = new Set()
  private readonly resumeWaiters: Set<() => void> = new Set()
  private readonly tick = (ticker: Ticker): void => this.advance(ticker.elapsedMS)
  private paused = false
  private destroyed = false

  constructor(app: Application) {
    this.app = app
    this.app.ticker.add(this.tick)
  }

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    if (this.destroyed || this.paused) return

    this.paused = true
    pauseSekaiLive2DSounds(this)
    this.app.render()
    this.app.ticker.stop()
  }

  resume(): void {
    if (this.destroyed || !this.paused) return

    this.paused = false
    this.app.ticker.start()
    resumeSekaiLive2DSounds(this)
    for (const resolve of this.resumeWaiters) {
      resolve()
    }
    this.resumeWaiters.clear()
  }

  delay(timeMs: number, signal?: AbortSignal): Promise<void> {
    if (timeMs <= 0) {
      this.throwIfUnavailable(signal)
      return Promise.resolve()
    }

    let elapsedMs = 0
    return this.createTask((deltaMs: number, complete: () => void): void => {
      elapsedMs += deltaMs
      if (elapsedMs >= timeMs) complete()
    }, signal)
  }

  animate(
    animation: (progress: number) => void,
    timeMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    this.throwIfUnavailable(signal)
    animation(0)

    if (timeMs < 30) {
      animation(1)
      return Promise.resolve()
    }

    let elapsedMs = 0
    return this.createTask((deltaMs: number, complete: () => void): void => {
      elapsedMs = Math.min(timeMs, elapsedMs + deltaMs)
      const progress = elapsedMs / timeMs
      animation(progress)
      if (progress >= 1) {
        animation(1)
        complete()
      }
    }, signal)
  }

  waitUntil(predicate: () => boolean, signal?: AbortSignal): Promise<void> {
    this.throwIfUnavailable(signal)
    if (predicate()) return Promise.resolve()

    return this.createTask((_deltaMs: number, complete: () => void): void => {
      if (predicate()) complete()
    }, signal)
  }

  waitForResume(signal?: AbortSignal): Promise<void> {
    this.throwIfUnavailable(signal)
    if (!this.paused) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.resumeWaiters.delete(onResume)
        reject(new StoryAbortError())
      }
      const onResume = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      this.resumeWaiters.add(onResume)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  cancel(): void {
    if (this.destroyed) return

    this.destroyed = true
    this.paused = false
    this.app.ticker.remove(this.tick)
    this.app.ticker.start()
    resumeSekaiLive2DSounds(this)

    for (const task of [...this.tasks]) {
      task.cancel()
    }
    this.tasks.clear()

    for (const resolve of this.resumeWaiters) {
      resolve()
    }
    this.resumeWaiters.clear()
  }

  private advance(rawDeltaMs: number): void {
    if (this.destroyed || this.paused) return

    // A resumed browser ticker can report the entire paused interval. Cap it to prevent jumps.
    const deltaMs = Math.min(Math.max(rawDeltaMs, 0), 20)
    for (const task of [...this.tasks]) {
      task.tick(deltaMs)
    }
  }

  private createTask(
    runner: (deltaMs: number, complete: () => void) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.throwIfUnavailable(signal)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let task: ClockTask | null = null

      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (task) this.tasks.delete(task)
        signal?.removeEventListener('abort', abort)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const abort = (): void => settle(new StoryAbortError())
      const complete = (): void => settle()

      task = {
        tick: (deltaMs: number): void => {
          try {
            runner(deltaMs, complete)
          } catch (error: unknown) {
            settle(error)
          }
        },
        cancel: abort
      }
      this.tasks.add(task)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private throwIfUnavailable(signal?: AbortSignal): void {
    if (this.destroyed || signal?.aborted) {
      throw new StoryAbortError()
    }
  }
}
