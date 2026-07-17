import type { JSX } from 'react'
import { useMemo } from 'react'
import type { DriveStep } from 'driver.js'
import { ProductTour } from './ProductTour'
import { useTranslation } from 'react-i18next'

export function EditorProductTour({
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
          title: t('onboarding.editorWelcomeTitle'),
          description: t('onboarding.editorWelcomeDescription')
        }
      },
      {
        element: '[data-tour="editor-add-snippet"]',
        data: { advanceOnElementClick: true },
        popover: {
          title: t('onboarding.addTitle'),
          description: t('onboarding.addDescription'),
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '[data-tour="editor-add-talk"]',
        data: { advanceOnElementClick: true },
        popover: {
          title: t('onboarding.talkTitle'),
          description: t('onboarding.talkDescription'),
          side: 'left',
          align: 'center'
        }
      },
      {
        element: '[data-tour="editor-talk-content"]',
        data: { requireNonEmptyInput: true },
        popover: {
          title: t('onboarding.contentTitle'),
          description: t('onboarding.contentDescription'),
          side: 'left',
          align: 'center'
        }
      },
      {
        element: '[data-tour="editor-preview-button"]',
        data: { completeOnElementClick: true },
        popover: {
          title: t('onboarding.previewTitle'),
          description: t('onboarding.previewDescription'),
          side: 'bottom',
          align: 'end'
        }
      }
    ],
    [t]
  )

  return <ProductTour active={active} steps={steps} onComplete={onComplete} startDelayMs={600} />
}
