import type { JSX } from 'react'
import { useMemo } from 'react'
import type { DriveStep } from 'driver.js'
import { ProductTour } from './ProductTour'
import { useTranslation } from 'react-i18next'

export function MainProductTour({
  active,
  onComplete
}: {
  active: boolean
  onComplete: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const steps: readonly DriveStep[] = useMemo(
    (): readonly DriveStep[] => [
      {
        popover: {
          title: t('onboarding.welcomeTitle'),
          description: t('onboarding.welcomeDescription')
        }
      },
      {
        element: '[data-tour="main-projects"]',
        popover: {
          title: t('onboarding.projectsTitle'),
          description: t('onboarding.projectsDescription'),
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '[data-tour="main-settings"]',
        popover: {
          title: t('onboarding.settingsTitle'),
          description: t('onboarding.settingsDescription'),
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '[data-tour="main-create-project"]',
        data: { completeOnElementClick: true },
        popover: {
          title: t('onboarding.createTitle'),
          description: t('onboarding.createDescription'),
          side: 'left',
          align: 'center'
        }
      }
    ],
    [t]
  )

  return <ProductTour active={active} steps={steps} onComplete={onComplete} />
}
