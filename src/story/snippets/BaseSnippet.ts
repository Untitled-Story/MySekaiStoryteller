import { delaySeconds, throwIfAborted } from '@/story/timing'
import type { LeafSnippetData, Snippet, SnippetContext, StoryRuntime } from '@/story/types'

export default abstract class BaseSnippet<TSnippet extends LeafSnippetData> implements Snippet {
  protected readonly snippet: TSnippet
  protected readonly runtime: StoryRuntime
  protected readonly signal: AbortSignal
  protected readonly path: readonly number[]

  constructor(context: SnippetContext<TSnippet>) {
    this.snippet = context.snippet
    this.runtime = context.runtime
    this.signal = context.signal
    this.path = context.path
  }

  async run(): Promise<void> {
    if (!this.runtime.scene.fastForwarding) {
      await delaySeconds(this.snippet.delay, this.signal, this.runtime.clock)
    }
    throwIfAborted(this.signal)
    await this.handle()
    throwIfAborted(this.signal)
  }

  protected abstract handle(): Promise<void>
}
