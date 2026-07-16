import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { driver, type DriveStep, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'

export function ProductTour({
  active,
  steps,
  onComplete,
  startDelayMs = 350
}: {
  active: boolean
  steps: readonly DriveStep[]
  onComplete: () => void
  startDelayMs?: number
}): JSX.Element | null {
  const onCompleteRef = useRef<() => void>(onComplete)

  useEffect((): void => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect((): (() => void) | undefined => {
    if (!active || steps.length === 0) return undefined

    let cleaningUp: boolean = false
    let completed: boolean = false
    let tour: Driver | null = null

    function finish(): void {
      if (cleaningUp || completed) return
      completed = true
      onCompleteRef.current()
      tour?.destroy()
    }

    const timeoutId: number = window.setTimeout((): void => {
      if (cleaningUp) return

      const preparedSteps: DriveStep[] = steps.map((step: DriveStep): DriveStep => {
        const completesOnClick: boolean = step.data?.completeOnElementClick === true
        const advancesOnClick: boolean = step.data?.advanceOnElementClick === true
        const requiresInput: boolean = step.data?.requireNonEmptyInput === true
        if (!completesOnClick && !advancesOnClick && !requiresInput) return step

        if (requiresInput) {
          return {
            ...step,
            disableActiveInteraction: false,
            popover: {
              ...step.popover,
              showButtons: ['next', 'close'],
              nextBtnText: '完成输入',
              onPopoverRender: (popover, options): void => {
                step.popover?.onPopoverRender?.(popover, options)
                const input: Element | undefined = options.driver.getActiveElement()
                if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
                  return
                }
                const textInput: HTMLInputElement | HTMLTextAreaElement = input

                function updateButtonState(): void {
                  const empty: boolean = textInput.value.trim().length === 0
                  popover.nextButton.disabled = empty
                  popover.nextButton.classList.toggle('driver-popover-btn-disabled', empty)
                }

                updateButtonState()
                textInput.addEventListener('input', updateButtonState)
                window.setTimeout((): void => textInput.focus(), 0)
              },
              onNextClick: (element, activeStep, options): void => {
                if (
                  !(
                    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                  ) ||
                  element.value.trim().length === 0
                ) {
                  if (element instanceof HTMLElement) element.focus()
                  return
                }
                step.popover?.onNextClick?.(element, activeStep, options)
                options.driver.moveNext()
              }
            }
          }
        }

        return {
          ...step,
          disableActiveInteraction: false,
          onHighlightStarted: (element, activeStep, options): void => {
            step.onHighlightStarted?.(element, activeStep, options)
            element?.addEventListener(
              'click',
              completesOnClick
                ? finish
                : (): void => {
                    window.setTimeout((): void => tour?.moveNext(), 120)
                  },
              { once: true }
            )
          },
          popover: {
            ...step.popover,
            showButtons: ['close']
          }
        }
      })

      tour = driver({
        steps: preparedSteps,
        animate: true,
        duration: 240,
        overlayColor: '#080b10',
        overlayOpacity: 0.68,
        stagePadding: 6,
        stageRadius: 9,
        popoverOffset: 12,
        popoverClass: 'mss-product-tour',
        allowClose: true,
        allowScroll: true,
        allowKeyboardControl: true,
        overlayClickBehavior: (): void => undefined,
        skipMissingElement: true,
        disableActiveInteraction: true,
        showProgress: true,
        progressText: '{{current}} / {{total}}',
        nextBtnText: '下一步',
        prevBtnText: '上一步',
        doneBtnText: '开始创作',
        onPopoverRender: (popover): void => {
          popover.closeButton.title = '跳过教程'
          popover.closeButton.setAttribute('aria-label', '跳过教程')
        },
        onDoneClick: finish,
        onCloseClick: finish,
        onDestroyStarted: finish
      })
      tour.drive()
    }, startDelayMs)

    return (): void => {
      cleaningUp = true
      window.clearTimeout(timeoutId)
      tour?.destroy()
    }
  }, [active, startDelayMs, steps])

  return null
}
