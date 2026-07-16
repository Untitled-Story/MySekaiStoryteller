import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class ApplyEffectSnippet extends BaseSnippet<SnippetByType<'ApplyEffect'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.applyEffect(this.snippet.data)
  }
}
