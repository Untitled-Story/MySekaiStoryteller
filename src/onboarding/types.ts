export type OnboardingSettings = {
  mainTourVersion: number
  editorTourVersion: number
}

export const MAIN_TOUR_VERSION: number = 1
export const EDITOR_TOUR_VERSION: number = 1

export const DEFAULT_ONBOARDING: OnboardingSettings = {
  mainTourVersion: 0,
  editorTourVersion: 0
}

export function normalizeOnboardingSettings(
  value: OnboardingSettings | undefined
): OnboardingSettings {
  return {
    mainTourVersion: normalizeVersion(value?.mainTourVersion),
    editorTourVersion: normalizeVersion(value?.editorTourVersion)
  }
}

function normalizeVersion(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0
  return value
}
