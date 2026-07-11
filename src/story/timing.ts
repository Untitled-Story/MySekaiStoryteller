import { StoryAbortError } from './types'
import { timeManager } from './timeManager'

export async function delaySeconds(seconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)

  if (seconds <= 0) return

  return timeManager.delay(seconds, signal).catch((err) => {
    if (err instanceof Error && err.message === 'Aborted') {
      throw new StoryAbortError()
    }
    throw err
  })
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new StoryAbortError()
  }
}

export function isStoryAbortError(error: unknown): error is StoryAbortError {
  return error instanceof StoryAbortError
}
