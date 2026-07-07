import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class ChangeLayoutModeSnippet extends BaseSnippet<
  SnippetByType<'ChangeLayoutMode'>
> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.setLayoutMode(this.snippet.data.mode)
  }
}
