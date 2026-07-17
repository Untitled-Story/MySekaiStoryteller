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

export async function enterImmersiveFullscreen(target: HTMLElement): Promise<boolean> {
  const requestFullscreen: (() => Promise<void>) | undefined =
    target.requestFullscreen?.bind(target) ??
    (
      target as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void
      }
    ).webkitRequestFullscreen?.bind(target)

  if (!requestFullscreen) return false

  try {
    await Promise.resolve(requestFullscreen())
    return true
  } catch {
    return false
  }
}

export async function exitImmersiveFullscreen(): Promise<void> {
  const doc: Document & {
    webkitExitFullscreen?: () => Promise<void> | void
    webkitFullscreenElement?: Element | null
  } = document

  const fullscreenElement: Element | null =
    document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
  if (!fullscreenElement) return

  const exitFullscreen: (() => Promise<void>) | undefined =
    document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document)

  if (!exitFullscreen) return

  try {
    await Promise.resolve(exitFullscreen())
  } catch {
    // ignore exit failures
  }
}
