import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  server: { middlewareMode: true }
})

try {
  const { reduceStory, reduceStoryBeforeSnippet, StoryStatePrefixCache } =
    await server.ssrLoadModule('/src/story/reduceStory.ts')
  const story = {
    version: 1,
    snippets: [
      {
        id: 'background',
        type: 'ChangeBackgroundImage',
        delay: 0,
        data: { background: 'school' }
      },
      {
        id: 'appear',
        type: 'LayoutAppear',
        delay: 0,
        data: {
          model: 'shiho',
          position: { side: 'Left', offset: 12 },
          motion: 'idle',
          facial: 'smile',
          hologram: true
        }
      },
      {
        id: 'parameter',
        type: 'DoParam',
        delay: 0,
        data: {
          model: 'shiho',
          params: [
            {
              paramId: 'ParamAngleX',
              start: 0,
              end: 7,
              curve: 'Linear',
              duration: 1
            }
          ]
        }
      },
      {
        id: 'parallel',
        type: 'Parallel',
        delay: 0,
        snippets: [
          {
            id: 'move',
            type: 'Move',
            delay: 0,
            data: {
              model: 'shiho',
              from: { side: 'Left', offset: 12 },
              to: { side: 'Right', offset: 0 },
              moveSpeed: 'Normal'
            }
          },
          {
            id: 'effect',
            type: 'ApplyEffect',
            delay: 0,
            data: {
              effectId: 'grayscale',
              target: { type: 'Model', model: 'shiho' },
              effect: { type: 'Grayscale', intensity: 1 },
              duration: 0.3
            }
          }
        ]
      },
      {
        id: 'target',
        type: 'Motion',
        delay: 0,
        data: { model: 'shiho', motion: 'wave' }
      }
    ]
  }

  const beforeTarget = reduceStoryBeforeSnippet(story, 'target')
  assert.equal(beforeTarget.backgroundKey, 'school')
  assert.deepEqual(beforeTarget.models.shiho.position, { side: 'Right', offset: 0 })
  assert.deepEqual(beforeTarget.models.shiho.lastFrame, {
    motion: 'idle',
    facial: 'smile'
  })
  assert.equal(beforeTarget.models.shiho.parameters.ParamAngleX, 7)
  assert.equal(beforeTarget.effects.grayscale.effect.type, 'Grayscale')
  const prefixCache = new StoryStatePrefixCache()
  prefixCache.update(story)
  assert.deepEqual(prefixCache.before('target'), beforeTarget)

  const finalState = reduceStory(story)
  assert.deepEqual(finalState.models.shiho.lastFrame, {
    motion: 'wave',
    facial: 'smile'
  })
  assert.deepEqual(finalState.models.shiho.parameters, {})

  const { default: StoryDispatcher } = await server.ssrLoadModule('/src/story/StoryDispatcher.ts')
  const calls = []
  const scene = {
    fastForwarding: false,
    setFastForwarding(enabled) {
      this.fastForwarding = enabled
    },
    async restoreState(state) {
      calls.push(['restore', state.backgroundKey])
    },
    commitState() {},
    invalidateState() {},
    async setLayoutMode(mode) {
      calls.push(['layout', mode])
    },
    async hideDialogue() {
      calls.push(['hide-dialogue'])
    }
  }
  const clock = {
    delay: async () => undefined,
    waitForResume: async () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    interrupt: () => undefined,
    cancel: () => undefined
  }
  const jumpStory = {
    version: 1,
    snippets: [
      {
        id: 'jump-background',
        type: 'ChangeBackgroundImage',
        delay: 0,
        data: { background: 'roof' }
      },
      {
        id: 'jump-target',
        type: 'ChangeLayoutMode',
        delay: 0,
        data: { mode: 'Three' }
      },
      { id: 'jump-after', type: 'HideTalk', delay: 0 }
    ]
  }
  const dispatcher = new StoryDispatcher({ scene, clock })
  await dispatcher.runFrom(jumpStory, 'jump-target')
  assert.deepEqual(calls, [['restore', 'roof'], ['layout', 'Three'], ['hide-dialogue']])
} finally {
  await server.close()
}
