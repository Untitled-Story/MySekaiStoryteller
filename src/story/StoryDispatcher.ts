import type { LeafSnippetData, SnippetData, StoryData } from './schema'
import {
  StoryAbortError,
  StorySnippetError,
  type SnippetConstructor,
  type SnippetByType,
  type StoryDispatcherEvent,
  type StoryDispatcherOptions,
  type StoryDispatcherStatus,
  type StoryRunOptions,
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
  private activeStory: StoryData | null = null
  private targetReachedPromise: Promise<void> | null = null
  private resolveTargetReached: (() => void) | null = null

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

  pause(): void {
    if (this.status !== 'running') return

    this.runtime.clock.pause()
    this.status = 'paused'
    if (this.activeStory) this.emit({ type: 'story:pause', story: this.activeStory })
  }

  resume(): void {
    if (this.status !== 'paused') return

    this.runtime.clock.resume()
    this.status = 'running'
    if (this.activeStory) this.emit({ type: 'story:resume', story: this.activeStory })
  }

  cancel(): void {
    if (this.status === 'completed' || this.status === 'cancelled' || this.status === 'failed')
      return
    this.abortController.abort()
    this.runtime.clock.cancel()
  }

  async run(story: StoryData): Promise<void> {
    await this.runInternal(story, null, null)
  }

  async runFrom(story: StoryData, snippetId: string, options: StoryRunOptions = {}): Promise<void> {
    if (!findSnippetById(story.snippets, snippetId)) {
      throw new Error(`Story snippet 不存在: ${snippetId}`)
    }

    await this.runInternal(story, snippetId, options.pauseAfterSnippetId ?? null)
  }

  private async runInternal(
    story: StoryData,
    targetSnippetId: string | null,
    pauseAfterSnippetId: string | null
  ): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') {
      throw new Error('StoryDispatcher is already running')
    }

    this.runtime.scene.setFastForwarding(targetSnippetId !== null)
    this.targetReachedPromise = targetSnippetId
      ? new Promise<void>((resolve: () => void): void => {
          this.resolveTargetReached = resolve
        })
      : null
    this.status = 'running'
    this.activeStory = story
    this.emit({ type: 'story:start', story })

    const externalAbort = (): void => {
      this.abortController.abort()
      this.runtime.clock.cancel()
    }
    this.externalSignal?.addEventListener('abort', externalAbort, { once: true })

    try {
      throwIfAborted(this.signal)
      await this.waitForPlayback()
      await this.runSequence(story.snippets, [], targetSnippetId, pauseAfterSnippetId)
      // A requested pause can happen after the final snippet has completed. Keep the
      // run suspended at that position until the caller explicitly resumes it.
      await this.waitForPlayback()
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
      this.runtime.scene.setFastForwarding(false)
      this.targetReachedPromise = null
      this.resolveTargetReached = null
      this.externalSignal?.removeEventListener('abort', externalAbort)
      this.activeStory = null
    }
  }

  private async runSequence(
    snippets: readonly SnippetData[],
    path: readonly number[],
    targetSnippetId: string | null,
    pauseAfterSnippetId: string | null
  ): Promise<void> {
    for (let index = 0; index < snippets.length; index += 1) {
      throwIfAborted(this.signal)
      await this.waitForPlayback()
      await this.runSnippet(snippets[index], [...path, index], targetSnippetId, pauseAfterSnippetId)
    }
  }

  private async runSnippet(
    snippet: SnippetData,
    path: readonly number[],
    targetSnippetId: string | null,
    pauseAfterSnippetId: string | null
  ): Promise<void> {
    await this.waitForPlayback()

    if (targetSnippetId !== null && snippet.id === targetSnippetId) {
      this.runtime.scene.setFastForwarding(false)
      this.resolveTargetReached?.()
      this.resolveTargetReached = null
    }

    const fastForwarding: boolean = this.runtime.scene.fastForwarding
    if (!fastForwarding) this.emit({ type: 'snippet:start', snippet, path })

    try {
      if (snippet.type === 'Parallel') {
        if (!fastForwarding) {
          await delaySeconds(snippet.delay, this.signal, this.runtime.clock)
        }
        await this.runParallel(snippet.snippets, path, targetSnippetId, pauseAfterSnippetId)
      } else {
        await this.runLeafSnippet(snippet, path)
      }

      if (!fastForwarding) {
        this.emit({ type: 'snippet:complete', snippet, path })
        if (snippet.id === pauseAfterSnippetId) this.pause()
      }
    } catch (error: unknown) {
      if (isStoryAbortError(error) || this.signal.aborted) {
        throw new StoryAbortError()
      }

      this.emit({ type: 'snippet:error', snippet, path, error })
      throw error instanceof StorySnippetError ? error : new StorySnippetError(snippet, path, error)
    }
  }

  private async runParallel(
    snippets: readonly SnippetData[],
    path: readonly number[],
    targetSnippetId: string | null,
    pauseAfterSnippetId: string | null
  ): Promise<void> {
    if (!this.runtime.scene.fastForwarding) {
      await Promise.all(
        snippets.map(
          (child: SnippetData, index: number): Promise<void> =>
            this.runSnippet(child, [...path, index], targetSnippetId, pauseAfterSnippetId)
        )
      )
      return
    }

    const targetBranchIndex: number = snippets.findIndex((child: SnippetData): boolean =>
      findSnippetById([child], targetSnippetId)
    )
    if (targetBranchIndex < 0) {
      for (let index = 0; index < snippets.length; index += 1) {
        await this.runSnippet(
          snippets[index],
          [...path, index],
          targetSnippetId,
          pauseAfterSnippetId
        )
      }
      return
    }

    for (let index = 0; index < targetBranchIndex; index += 1) {
      await this.runSnippet(snippets[index], [...path, index], targetSnippetId, pauseAfterSnippetId)
    }
    const targetTask: Promise<void> = this.runSnippet(
      snippets[targetBranchIndex],
      [...path, targetBranchIndex],
      targetSnippetId,
      pauseAfterSnippetId
    )
    if (this.targetReachedPromise) {
      await Promise.race([this.targetReachedPromise, targetTask])
    }
    const remainingTasks: Promise<void>[] = snippets
      .slice(targetBranchIndex + 1)
      .map(
        (child: SnippetData, offset: number): Promise<void> =>
          this.runSnippet(
            child,
            [...path, targetBranchIndex + offset + 1],
            targetSnippetId,
            pauseAfterSnippetId
          )
      )
    await Promise.all([targetTask, ...remainingTasks])
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

  private async waitForPlayback(): Promise<void> {
    if (this.status !== 'paused') return
    await this.runtime.clock.waitForResume(this.signal)
  }

  private emit(event: StoryDispatcherEvent): void {
    this.onEvent?.(event)
  }
}

function findSnippetById(snippets: readonly SnippetData[], snippetId: string | null): boolean {
  if (!snippetId) return false

  return snippets.some((snippet: SnippetData): boolean => {
    if (snippet.id === snippetId) return true
    return snippet.type === 'Parallel' && findSnippetById(snippet.snippets, snippetId)
  })
}
