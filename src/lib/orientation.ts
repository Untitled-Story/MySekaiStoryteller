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

type NativeOrientationBridge = {
  setLandscape: (enabled: boolean) => void
}

function getNativeOrientationBridge(): NativeOrientationBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { MssOrientation?: NativeOrientationBridge }).MssOrientation
}

export async function lockLandscapeOrientation(): Promise<boolean> {
  const nativeBridge: NativeOrientationBridge | undefined = getNativeOrientationBridge()
  if (nativeBridge) {
    try {
      nativeBridge.setLandscape(true)
      return true
    } catch {
      // Fall through to the Web Screen Orientation API.
    }
  }

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
  try {
    getNativeOrientationBridge()?.setLandscape(false)
  } catch {
    // Continue and also release any Web Screen Orientation lock.
  }

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
