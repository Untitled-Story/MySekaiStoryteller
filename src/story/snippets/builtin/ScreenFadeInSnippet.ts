import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class ScreenFadeInSnippet extends BaseSnippet<SnippetByType<'ScreenFadeIn'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.fadeIn(this.snippet.data)
  }
}
