import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class RemoveEffectSnippet extends BaseSnippet<SnippetByType<'RemoveEffect'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.removeEffect(this.snippet.data)
  }
}
