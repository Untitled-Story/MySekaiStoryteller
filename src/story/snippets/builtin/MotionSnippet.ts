import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class MotionSnippet extends BaseSnippet<SnippetByType<'Motion'>> {
  protected async handle(): Promise<void> {
    const { model, motion, facial } = this.snippet.data

    await this.runtime.scene.playMotion({
      modelKey: model,
      motion,
      facial
    })
  }
}
