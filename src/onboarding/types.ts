export type OnboardingSettings = {
  mainTourCompleted: boolean
  editorTourCompleted: boolean
}

export const DEFAULT_ONBOARDING: OnboardingSettings = {
  mainTourCompleted: false,
  editorTourCompleted: false
}

export function normalizeOnboardingSettings(
  value: OnboardingSettings | undefined
): OnboardingSettings {
  return {
    mainTourCompleted: value?.mainTourCompleted === true,
    editorTourCompleted: value?.editorTourCompleted === true
  }
}
