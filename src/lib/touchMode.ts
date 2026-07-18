export type InteractionSettings = {
  touchMode: boolean
  touchModePromptSeen: boolean
}

export const DEFAULT_INTERACTION: InteractionSettings = {
  touchMode: false,
  touchModePromptSeen: false
}

export function detectPreferTouchMode(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  try {
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true
      if (window.matchMedia('(hover: none)').matches && navigator.maxTouchPoints > 0) return true
    }
  } catch {
    // ignore matchMedia failures
  }

  return navigator.maxTouchPoints > 0
}

export function normalizeInteractionSettings(
  value: Partial<InteractionSettings> | undefined,
  options?: { detectDefaultWhenMissing?: boolean }
): InteractionSettings {
  const detectDefaultWhenMissing: boolean = options?.detectDefaultWhenMissing ?? false
  const hasStoredTouchMode: boolean = typeof value?.touchMode === 'boolean'

  return {
    touchMode: hasStoredTouchMode
      ? Boolean(value?.touchMode)
      : detectDefaultWhenMissing
        ? detectPreferTouchMode()
        : DEFAULT_INTERACTION.touchMode,
    touchModePromptSeen: Boolean(value?.touchModePromptSeen)
  }
}
