import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class TelopSnippet extends BaseSnippet<SnippetByType<'Telop'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.showTelop(this.snippet.data)
  }
}
