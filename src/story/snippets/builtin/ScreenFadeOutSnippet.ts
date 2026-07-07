import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class ScreenFadeOutSnippet extends BaseSnippet<SnippetByType<'ScreenFadeOut'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.fadeOut(this.snippet.data)
  }
}
