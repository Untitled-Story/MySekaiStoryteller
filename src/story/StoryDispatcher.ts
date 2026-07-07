import type { LeafSnippetData, SnippetData, StoryData } from './schema'
import {
  StoryAbortError,
  StorySnippetError,
  type SnippetConstructor,
  type SnippetByType,
  type StoryDispatcherEvent,
  type StoryDispatcherOptions,
  type StoryDispatcherStatus,
  type StoryRuntime
} from './types'
import { delaySeconds, isStoryAbortError, throwIfAborted } from './timing'
import { createBuiltinSnippetRegistry, type StorySnippetRegistry } from './snippets/registry'

export default class StoryDispatcher {
  private readonly runtime: StoryRuntime
  private readonly registry: StorySnippetRegistry
  private readonly abortController = new AbortController()
  private readonly externalSignal?: AbortSignal
  private readonly onEvent?: (event: StoryDispatcherEvent) => void
  private status: StoryDispatcherStatus = 'idle'

  constructor(
    runtime: StoryRuntime,
    options: StoryDispatcherOptions = {},
    registry: StorySnippetRegistry = createBuiltinSnippetRegistry()
  ) {
    this.runtime = runtime
    this.registry = registry
    this.externalSignal = options.signal
    this.onEvent = options.onEvent
  }

  get currentStatus(): StoryDispatcherStatus {
    return this.status
  }

  cancel(): void {
    if (this.status === 'completed' || this.status === 'cancelled') return
    this.abortController.abort()
  }

  async run(story: StoryData): Promise<void> {
    if (this.status === 'running') {
      throw new Error('StoryDispatcher is already running')
    }

    this.status = 'running'
    this.emit({ type: 'story:start', story })

    const externalAbort = (): void => this.abortController.abort()
    this.externalSignal?.addEventListener('abort', externalAbort, { once: true })

    try {
      throwIfAborted(this.signal)
      await this.runSequence(story.snippets, [])
      this.status = 'completed'
      this.emit({ type: 'story:complete', story })
    } catch (error: unknown) {
      if (isStoryAbortError(error) || this.signal.aborted) {
        this.status = 'cancelled'
        this.emit({ type: 'story:cancel', story })
        return
      }

      this.status = 'failed'
      this.emit({ type: 'story:error', story, error })
      throw error
    } finally {
      this.externalSignal?.removeEventListener('abort', externalAbort)
    }
  }

  private async runSequence(
    snippets: readonly SnippetData[],
    path: readonly number[]
  ): Promise<void> {
    for (let index = 0; index < snippets.length; index += 1) {
      throwIfAborted(this.signal)
      await this.runSnippet(snippets[index], [...path, index])
    }
  }

  private async runSnippet(snippet: SnippetData, path: readonly number[]): Promise<void> {
    this.emit({ type: 'snippet:start', snippet, path })

    try {
      if (snippet.type === 'Parallel') {
        await delaySeconds(snippet.delay, this.signal)
        await Promise.all(
          snippet.snippets.map((child, index) => this.runSnippet(child, [...path, index]))
        )
      } else {
        await this.runLeafSnippet(snippet, path)
      }

      this.emit({ type: 'snippet:complete', snippet, path })
    } catch (error: unknown) {
      if (isStoryAbortError(error) || this.signal.aborted) {
        throw new StoryAbortError()
      }

      this.emit({ type: 'snippet:error', snippet, path, error })
      throw error instanceof StorySnippetError ? error : new StorySnippetError(snippet, path, error)
    }
  }

  private async runLeafSnippet(snippet: LeafSnippetData, path: readonly number[]): Promise<void> {
    const Snippet = this.getSnippetConstructor(snippet.type)
    const instance = new Snippet({
      snippet,
      runtime: this.runtime,
      signal: this.signal,
      path
    })

    await instance.run()
  }

  private getSnippetConstructor<TType extends LeafSnippetData['type']>(
    type: TType
  ): SnippetConstructor<SnippetByType<TType>> {
    return this.registry.get(type)
  }

  private get signal(): AbortSignal {
    return this.abortController.signal
  }

  private emit(event: StoryDispatcherEvent): void {
    this.onEvent?.(event)
  }
}
