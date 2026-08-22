import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true }
})

try {
  const { composeLive2DEyeMotion } = await server.ssrLoadModule(
    '/src/story/composeLive2DEyeMotion.ts'
  )
  const values = new Map([
    ['ParamEyeLOpen', 1],
    ['ParamEyeROpen', 1]
  ])
  const listeners = new Map()
  const coreModel = {
    getParameterValueById(id) {
      return values.get(id) ?? 0
    },
    setParameterValueById(id, value) {
      values.set(id, value)
    }
  }
  const internalModel = {
    coreModel,
    getIdSafe(id) {
      return id
    },
    on(event, listener) {
      const eventListeners = listeners.get(event) ?? []
      eventListeners.push(listener)
      listeners.set(event, eventListeners)
    }
  }

  let motionEyes = [0.25, 0.5]
  let facialEyes = [0.8, 0.6]
  let facialUpdated = true
  const motionManager = {
    update() {
      coreModel.setParameterValueById('ParamEyeLOpen', motionEyes[0])
      coreModel.setParameterValueById('ParamEyeROpen', motionEyes[1])
      return true
    }
  }
  const facialManager = {
    update() {
      if (!facialUpdated) return false
      coreModel.setParameterValueById('ParamEyeLOpen', facialEyes[0])
      coreModel.setParameterValueById('ParamEyeROpen', facialEyes[1])
      return true
    }
  }
  const emit = (event) => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const tick = (now) => {
    emit('beforeMotionUpdate')
    motionManager.update(coreModel, now)
    facialManager.update(coreModel, now)
    emit('afterMotionUpdate')
  }

  const finishComposition = composeLive2DEyeMotion(internalModel, motionManager, facialManager)
  assert.equal(typeof finishComposition, 'function')

  tick(0)
  assert.equal(values.get('ParamEyeLOpen'), 0.8 * 0.25)
  assert.equal(values.get('ParamEyeROpen'), 0.6 * 0.5)

  facialUpdated = false
  motionEyes = [0.5, 0.5]
  tick(16)
  assert.equal(values.get('ParamEyeLOpen'), 0.8 * 0.5)
  assert.equal(values.get('ParamEyeROpen'), 0.6 * 0.5)

  motionEyes = [1, 1]
  tick(32)
  assert.equal(values.get('ParamEyeLOpen'), 0.8)
  assert.equal(values.get('ParamEyeROpen'), 0.6)

  finishComposition()
  motionEyes = [0.4, 0.7]
  tick(48)
  assert.equal(values.get('ParamEyeLOpen'), 0.4)
  assert.equal(values.get('ParamEyeROpen'), 0.7)

  assert.equal(composeLive2DEyeMotion({}, motionManager, facialManager), undefined)

  const fixtureUrl = new URL(
    '../tests/models/01ichika_normal_3.0_f_t04/motions/w-adult-think01.motion3.json',
    import.meta.url
  )
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
  const eyeCurves = fixture.Curves.filter(
    (curve) => curve.Id === 'ParamEyeLOpen' || curve.Id === 'ParamEyeROpen'
  )
  assert.equal(eyeCurves.length, 2)
  for (const curve of eyeCurves) {
    const keyframeValues = readKeyframeValues(curve.Segments)
    assert.ok(keyframeValues.includes(0))
    assert.ok(keyframeValues.includes(1))
  }
} finally {
  await server.close()
}

function readKeyframeValues(segments) {
  const values = [segments[1]]
  let index = 2

  while (index < segments.length) {
    const segmentType = segments[index]
    if (segmentType === 1) {
      values.push(segments[index + 6])
      index += 7
    } else {
      values.push(segments[index + 2])
      index += 3
    }
  }

  return values
}
