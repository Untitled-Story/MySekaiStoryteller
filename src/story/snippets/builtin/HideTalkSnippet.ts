import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class HideTalkSnippet extends BaseSnippet<SnippetByType<'HideTalk'>> {
  protected async handle(): Promise<void> {
    await this.runtime.scene.hideDialogue()
  }
}
