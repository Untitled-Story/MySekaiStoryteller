export type AppRuntimePlatform = 'android' | 'ios' | 'desktop' | 'unknown'

const MOBILE_UA_PATTERN: RegExp = /Android|iPhone|iPad|iPod|Mobile/i

export function getRuntimePlatform(): AppRuntimePlatform {
  if (typeof navigator === 'undefined') return 'unknown'

  const userAgent: string = navigator.userAgent
  if (/Android/i.test(userAgent)) return 'android'
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  if (MOBILE_UA_PATTERN.test(userAgent)) return 'unknown'
  return 'desktop'
}

export function isMobileRuntime(): boolean {
  if (typeof window === 'undefined') return false
  if (shouldForceMobileShell()) return true

  const platform: AppRuntimePlatform = getRuntimePlatform()
  return platform === 'android' || platform === 'ios'
}

export function isDesktopRuntime(): boolean {
  return !isMobileRuntime()
}

/** Prefer single-webview in-app routes instead of multi-window open_* commands. */
export function prefersInAppNavigation(): boolean {
  return isMobileRuntime()
}

export function shouldForceMobileShell(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params: URLSearchParams = new URLSearchParams(window.location.search)
    if (params.get('mobileShell') === '1') return true
    return window.localStorage.getItem('mss.mobileShell') === '1'
  } catch {
    return false
  }
}

export function editorRoutePath(projectName: string): string {
  return `/editor/${encodeURIComponent(projectName)}`
}

export function playerRoutePath(projectName: string): string {
  return `/player/${encodeURIComponent(projectName)}`
}

export function homeRoutePath(): string {
  return '/'
}
