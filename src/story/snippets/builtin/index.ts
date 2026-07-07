import type { StorySnippetRegistration } from '@/story/snippets/registry'
import ChangeBackgroundImageSnippet from './ChangeBackgroundImageSnippet'
import ChangeLayoutModeSnippet from './ChangeLayoutModeSnippet'
import DoParamSnippet from './DoParamSnippet'
import HideTalkSnippet from './HideTalkSnippet'
import LayoutAppearSnippet from './LayoutAppearSnippet'
import LayoutClearSnippet from './LayoutClearSnippet'
import MotionSnippet from './MotionSnippet'
import MoveSnippet from './MoveSnippet'
import ScreenFadeInSnippet from './ScreenFadeInSnippet'
import ScreenFadeOutSnippet from './ScreenFadeOutSnippet'
import TalkSnippet from './TalkSnippet'
import TelopSnippet from './TelopSnippet'

export const builtinSnippetRegistrations = [
  {
    type: 'ChangeLayoutMode',
    constructor: ChangeLayoutModeSnippet
  },
  {
    type: 'ChangeBackgroundImage',
    constructor: ChangeBackgroundImageSnippet
  },
  {
    type: 'LayoutAppear',
    constructor: LayoutAppearSnippet
  },
  {
    type: 'LayoutClear',
    constructor: LayoutClearSnippet
  },
  {
    type: 'Talk',
    constructor: TalkSnippet
  },
  {
    type: 'HideTalk',
    constructor: HideTalkSnippet
  },
  {
    type: 'Move',
    constructor: MoveSnippet
  },
  {
    type: 'Motion',
    constructor: MotionSnippet
  },
  {
    type: 'Telop',
    constructor: TelopSnippet
  },
  {
    type: 'DoParam',
    constructor: DoParamSnippet
  },
  {
    type: 'ScreenFadeOut',
    constructor: ScreenFadeOutSnippet
  },
  {
    type: 'ScreenFadeIn',
    constructor: ScreenFadeInSnippet
  }
] satisfies StorySnippetRegistration[]
