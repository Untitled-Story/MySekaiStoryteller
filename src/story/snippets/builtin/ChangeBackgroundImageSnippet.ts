import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class ChangeBackgroundImageSnippet extends BaseSnippet<
  SnippetByType<'ChangeBackgroundImage'>
> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.setBackground(this.snippet.data.background)
  }
}
