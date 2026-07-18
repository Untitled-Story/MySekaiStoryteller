type OrientationLockType =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary'

type ScreenOrientationLike = {
  lock?: (orientation: OrientationLockType) => Promise<void>
  unlock?: () => void
}

export async function lockLandscapeOrientation(): Promise<boolean> {
  if (typeof screen === 'undefined') return false
  const orientation: ScreenOrientationLike | undefined = (
    screen as Screen & { orientation?: ScreenOrientationLike }
  ).orientation
  if (!orientation?.lock) return false

  try {
    await orientation.lock('landscape')
    return true
  } catch {
    try {
      await orientation.lock('landscape-primary')
      return true
    } catch {
      return false
    }
  }
}

export function unlockOrientation(): void {
  if (typeof screen === 'undefined') return
  const orientation: ScreenOrientationLike | undefined = (
    screen as Screen & { orientation?: ScreenOrientationLike }
  ).orientation
  try {
    orientation?.unlock?.()
  } catch {
    // ignore unlock failures
  }
}
