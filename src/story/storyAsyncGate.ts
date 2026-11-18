/**
 * Tracks story awaits that do NOT advance with timeManager (Assets.load, etc.).
 * Export must not tick virtual time while this is > 0, or multi-worker warm
 * reaches startFrame with the story still stuck on early content.
 */

let pendingExternalAsync = 0

export function beginStoryAsync(): void {
  pendingExternalAsync += 1
}

export function endStoryAsync(): void {
  pendingExternalAsync = Math.max(0, pendingExternalAsync - 1)
}

export function isStoryAsyncPending(): boolean {
  return pendingExternalAsync > 0
}

export function getStoryAsyncPendingCount(): number {
  return pendingExternalAsync
}

export async function trackStoryAsync<T>(work: Promise<T>): Promise<T> {
  beginStoryAsync()
  try {
    return await work
  } finally {
    endStoryAsync()
  }
}
