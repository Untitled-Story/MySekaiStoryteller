import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class LayoutClearSnippet extends BaseSnippet<SnippetByType<'LayoutClear'>> {
  protected async handle(): Promise<void> {
    const { model } = this.snippet.data

    await this.runtime.scene.clearModel({ modelKey: model })
  }
}
