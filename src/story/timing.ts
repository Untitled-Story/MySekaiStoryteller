import { StoryAbortError } from './types'
import type { StoryPlaybackClock } from './playbackClock'

export async function delaySeconds(
  seconds: number,
  signal: AbortSignal,
  clock?: StoryPlaybackClock
): Promise<void> {
  throwIfAborted(signal)

  if (seconds <= 0) return

  if (clock) {
    await clock.delay(seconds * 1000, signal)
    throwIfAborted(signal)
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, seconds * 1000)

    function abort(): void {
      window.clearTimeout(timeout)
      reject(new StoryAbortError())
    }

    signal.addEventListener('abort', abort, { once: true })
  })

  throwIfAborted(signal)
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new StoryAbortError()
  }
}

export function isStoryAbortError(error: unknown): error is StoryAbortError {
  return error instanceof StoryAbortError
}
