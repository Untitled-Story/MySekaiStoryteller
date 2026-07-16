import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class LayoutAppearSnippet extends BaseSnippet<SnippetByType<'LayoutAppear'>> {
  protected async handle(): Promise<void> {
    const { model, motion, facial, hologram } = this.snippet.data

    await this.runtime.scene.showModel({
      modelKey: model,
      motion,
      facial,
      hologram
    })
  }
}
