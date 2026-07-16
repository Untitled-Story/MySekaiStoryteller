import type { JSX } from 'react'
import { useMemo } from 'react'
import type { DriveStep } from 'driver.js'
import { ProductTour } from './ProductTour'

export function EditorProductTour({
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
          title: '动手做第一个片段',
          description:
            '接下来，你会亲手添加一个 Talk、写下一句台词，最后预览一下，看看它在画面里的样子吧。'
        }
      },
      {
        element: '[data-tour="editor-add-snippet"]',
        data: { advanceOnElementClick: true },
        popover: {
          title: '第一步：添加片段',
          description:
            '一个片段，就是故事里的一个瞬间；把它们一个接一个攒起来，就成了完整的剧情。<br />就像高松灯说的那样——如果能积累起一个又一个的瞬间，也许就能变成一辈子。<span class="mss-tour-action">点击“添加片段”</span>',
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '[data-tour="editor-add-talk"]',
        data: { advanceOnElementClick: true },
        popover: {
          title: '第二步：选择 Talk',
          description:
            'Talk 用来显示角色台词，之后还能给它关联模型和语音呢。<span class="mss-tour-action">点击 Talk</span>',
          side: 'left',
          align: 'center'
        }
      },
      {
        element: '[data-tour="editor-talk-content"]',
        data: { requireNonEmptyInput: true },
        popover: {
          title: '第三步：写一句台词',
          description:
            '在文本框里随便写点什么吧，改动都会自动保存的。<span class="mss-tour-action">写完后点击“完成输入”</span>',
          side: 'left',
          align: 'center'
        }
      },
      {
        element: '[data-tour="editor-preview-button"]',
        data: { completeOnElementClick: true },
        popover: {
          title: '最后一步：预览效果',
          description:
            '预览会从当前选中的 Talk 开始，看看你刚写的这句台词呈现出来是什么样子。<span class="mss-tour-action">点击“预览”，完成教程</span>',
          side: 'bottom',
          align: 'end'
        }
      }
    ],
    []
  )

  return <ProductTour active={active} steps={steps} onComplete={onComplete} startDelayMs={600} />
}
