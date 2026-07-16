import type { JSX } from 'react'
import { useMemo } from 'react'
import type { DriveStep } from 'driver.js'
import { ProductTour } from './ProductTour'

export function MainProductTour({
  active,
  onComplete
}: {
  active: boolean
  onComplete: () => void
}): JSX.Element {
  const steps: readonly DriveStep[] = useMemo(
    (): readonly DriveStep[] => [
      {
        popover: {
          title: '欢迎来到 MySekaiStoryteller',
          description:
            '这是一个专为《Project SEKAI》打造的同人故事编辑器。<br />花一分钟，我们一起熟悉一下吧。'
        }
      },
      {
        element: '[data-tour="main-projects"]',
        popover: {
          title: '管理你的项目',
          description: '你的项目都在这里啦。随时都能回来继续编辑、播放，或是重命名和删除它们。',
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '[data-tour="main-settings"]',
        popover: {
          title: '调整成你喜欢的样子',
          description: '主题、渲染、字体、快捷键，都能在设置里慢慢调，让编辑器用起来更顺手。',
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '[data-tour="main-create-project"]',
        data: { completeOnElementClick: true },
        popover: {
          title: '创建你的第一个项目',
          description:
            '一切都从第一个项目开始。<br />它的所有资源都会保存在你刚才选择的数据目录里。<span class="mss-tour-action">点击这里，动手创建</span>',
          side: 'left',
          align: 'center'
        }
      }
    ],
    []
  )

  return <ProductTour active={active} steps={steps} onComplete={onComplete} />
}
