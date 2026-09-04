import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true }
})

try {
  const { importAssetsSequentially } = await server.ssrLoadModule(
    '/src/windows/editor/importAssetsSequentially.ts'
  )
  const { registerExistingModelsSequentially } = await server.ssrLoadModule(
    '/src/windows/editor/registerExistingModelsSequentially.ts'
  )
  const { importNewModelsSequentially } = await server.ssrLoadModule(
    '/src/windows/editor/importNewModelsSequentially.ts'
  )

  const backgroundOrder = []
  let activeImports = 0
  let maximumActiveImports = 0
  const backgroundResult = await importAssetsSequentially(
    ['classroom.png', 'school.jpg', 'rooftop.webp'],
    async (sourcePath) => {
      activeImports += 1
      maximumActiveImports = Math.max(maximumActiveImports, activeImports)
      backgroundOrder.push(`start:${sourcePath}`)
      await Promise.resolve()
      backgroundOrder.push(`finish:${sourcePath}`)
      activeImports -= 1
      return sourcePath.toUpperCase()
    },
    (result, sourcePath) => backgroundOrder.push(`saved:${sourcePath}:${result}`)
  )

  assert.equal(backgroundResult.successCount, 3)
  assert.deepEqual(backgroundResult.failures, [])
  assert.equal(maximumActiveImports, 1)
  assert.deepEqual(backgroundOrder, [
    'start:classroom.png',
    'finish:classroom.png',
    'saved:classroom.png:CLASSROOM.PNG',
    'start:school.jpg',
    'finish:school.jpg',
    'saved:school.jpg:SCHOOL.JPG',
    'start:rooftop.webp',
    'finish:rooftop.webp',
    'saved:rooftop.webp:ROOFTOP.WEBP'
  ])

  const attemptedVoices = []
  const importedVoices = []
  const voiceFailure = 'unsupported audio content'
  const voiceResult = await importAssetsSequentially(
    ['intro.ogg', 'broken.wav', 'outro.m4a'],
    async (sourcePath) => {
      attemptedVoices.push(sourcePath)
      if (sourcePath === 'broken.wav') throw voiceFailure
      return { key: sourcePath.replace('.', '-') }
    },
    (result) => importedVoices.push(result.key)
  )

  assert.deepEqual(attemptedVoices, ['intro.ogg', 'broken.wav', 'outro.m4a'])
  assert.deepEqual(importedVoices, ['intro-ogg', 'outro-m4a'])
  assert.equal(voiceResult.successCount, 2)
  assert.equal(voiceResult.failures.length, 1)
  assert.equal(voiceResult.failures[0].sourcePath, 'broken.wav')
  assert.equal(voiceResult.failures[0].error, voiceFailure)

  const attemptedModels = []
  const registeredModels = []
  const modelFailure = 'global model is unavailable'
  const modelResult = await registerExistingModelsSequentially(
    [
      { modelId: 'miku', key: 'lead-miku', name: 'Lead Miku' },
      { modelId: 'missing-model', key: 'missing-key' },
      { modelId: 'rin', name: 'Guest Rin' }
    ],
    async (modelId, key, name) => {
      attemptedModels.push({ modelId, key, name })
      if (modelId === 'missing-model') throw modelFailure
      return { key: `${modelId}-asset` }
    },
    (result, modelId) => registeredModels.push({ modelId, key: result.key })
  )

  assert.deepEqual(attemptedModels, [
    { modelId: 'miku', key: 'lead-miku', name: 'Lead Miku' },
    { modelId: 'missing-model', key: 'missing-key', name: undefined },
    { modelId: 'rin', key: undefined, name: 'Guest Rin' }
  ])
  assert.deepEqual(registeredModels, [
    { modelId: 'miku', key: 'miku-asset' },
    { modelId: 'rin', key: 'rin-asset' }
  ])
  assert.equal(modelResult.successCount, 2)
  assert.equal(modelResult.failures.length, 1)
  assert.equal(modelResult.failures[0].modelId, 'missing-model')
  assert.equal(modelResult.failures[0].error, modelFailure)

  const customRegistrations = []
  const singleModelResult = await registerExistingModelsSequentially(
    [{ modelId: 'len', key: 'lead-vocal', name: 'Lead vocal' }],
    async (modelId, key, name) => {
      customRegistrations.push({ modelId, key, name })
      return { key }
    },
    () => undefined
  )

  assert.deepEqual(customRegistrations, [{ modelId: 'len', key: 'lead-vocal', name: 'Lead vocal' }])
  assert.equal(singleModelResult.successCount, 1)
  assert.deepEqual(singleModelResult.failures, [])

  const failedModelResult = await registerExistingModelsSequentially(
    [{ modelId: 'missing-a' }, { modelId: 'missing-b' }],
    async (modelId) => {
      throw new Error(`failed:${modelId}`)
    },
    () => assert.fail('The success callback must not run when every model registration fails')
  )

  assert.equal(failedModelResult.successCount, 0)
  assert.deepEqual(
    failedModelResult.failures.map((failure) => failure.modelId),
    ['missing-a', 'missing-b']
  )
  assert.match(failedModelResult.failures[0].error.message, /missing-a/)
  assert.match(failedModelResult.failures[1].error.message, /missing-b/)

  const newModelImportCalls = []
  const newModelRegistrationCalls = []
  const importedNewModels = []
  const registeredNewModels = []
  let activeModelImports = 0
  let maximumActiveModelImports = 0
  const invalidModelError = 'invalid model archive'
  const newModelResult = await importNewModelsSequentially(
    [
      { sourcePath: 'miku.model3.json', key: 'lead-miku', name: 'Lead Miku' },
      {
        sourcePath: 'rin.zip',
        archiveEntry: 'rin/rin.model3.json',
        key: 'guest-rin',
        name: 'Guest Rin'
      },
      { sourcePath: 'broken.zip', archiveEntry: 'broken/model.json' }
    ],
    async (sourcePath, name, archiveEntry) => {
      activeModelImports += 1
      maximumActiveModelImports = Math.max(maximumActiveModelImports, activeModelImports)
      newModelImportCalls.push({ sourcePath, name, archiveEntry })
      await Promise.resolve()
      activeModelImports -= 1
      if (sourcePath === 'broken.zip') throw invalidModelError
      return { modelId: `global-${sourcePath}`, registry: sourcePath }
    },
    async (modelId, key, name) => {
      newModelRegistrationCalls.push({ modelId, key, name })
      return { key: key ?? modelId }
    },
    (result, request) =>
      importedNewModels.push({ modelId: result.modelId, sourcePath: request.sourcePath }),
    (result, request) =>
      registeredNewModels.push({ key: result.key, sourcePath: request.sourcePath })
  )

  assert.equal(maximumActiveModelImports, 1)
  assert.deepEqual(newModelImportCalls, [
    { sourcePath: 'miku.model3.json', name: 'Lead Miku', archiveEntry: undefined },
    { sourcePath: 'rin.zip', name: 'Guest Rin', archiveEntry: 'rin/rin.model3.json' },
    { sourcePath: 'broken.zip', name: undefined, archiveEntry: 'broken/model.json' }
  ])
  assert.deepEqual(newModelRegistrationCalls, [
    { modelId: 'global-miku.model3.json', key: 'lead-miku', name: 'Lead Miku' },
    { modelId: 'global-rin.zip', key: 'guest-rin', name: 'Guest Rin' }
  ])
  assert.deepEqual(importedNewModels, [
    { modelId: 'global-miku.model3.json', sourcePath: 'miku.model3.json' },
    { modelId: 'global-rin.zip', sourcePath: 'rin.zip' }
  ])
  assert.deepEqual(registeredNewModels, [
    { key: 'lead-miku', sourcePath: 'miku.model3.json' },
    { key: 'guest-rin', sourcePath: 'rin.zip' }
  ])
  assert.equal(newModelResult.successCount, 2)
  assert.equal(newModelResult.importedCount, 2)
  assert.equal(newModelResult.failures.length, 1)
  assert.equal(newModelResult.failures[0].sourcePath, 'broken.zip')
  assert.equal(newModelResult.failures[0].stage, 'import')
  assert.equal(newModelResult.failures[0].modelId, undefined)
  assert.equal(newModelResult.failures[0].error, invalidModelError)

  const importedBeforeRegistrationFailure = []
  const registeredAfterFailure = []
  const registrationFailureResult = await importNewModelsSequentially(
    [{ sourcePath: 'unregistered.zip' }, { sourcePath: 'len.model3.json' }],
    async (sourcePath) => ({ modelId: `global-${sourcePath}` }),
    async (modelId) => {
      if (modelId === 'global-unregistered.zip') throw new Error('project registration failed')
      return { key: modelId }
    },
    (result) => importedBeforeRegistrationFailure.push(result.modelId),
    (result) => registeredAfterFailure.push(result.key)
  )

  assert.deepEqual(importedBeforeRegistrationFailure, [
    'global-unregistered.zip',
    'global-len.model3.json'
  ])
  assert.deepEqual(registeredAfterFailure, ['global-len.model3.json'])
  assert.equal(registrationFailureResult.successCount, 1)
  assert.equal(registrationFailureResult.importedCount, 2)
  assert.equal(registrationFailureResult.failures.length, 1)
  assert.equal(registrationFailureResult.failures[0].sourcePath, 'unregistered.zip')
  assert.equal(registrationFailureResult.failures[0].stage, 'register')
  assert.equal(registrationFailureResult.failures[0].modelId, 'global-unregistered.zip')
  assert.match(registrationFailureResult.failures[0].error.message, /registration failed/)

  const allRegistrationFailedResult = await importNewModelsSequentially(
    [{ sourcePath: 'registered-a.zip' }, { sourcePath: 'registered-b.zip' }],
    async (sourcePath) => ({ modelId: `global-${sourcePath}` }),
    async (modelId) => {
      throw new Error(`registration failed:${modelId}`)
    },
    () => undefined,
    () => assert.fail('The registration callback must not run for failed registrations')
  )

  assert.equal(allRegistrationFailedResult.successCount, 0)
  assert.equal(allRegistrationFailedResult.importedCount, 2)
  assert.deepEqual(
    allRegistrationFailedResult.failures.map((failure) => ({
      sourcePath: failure.sourcePath,
      stage: failure.stage,
      modelId: failure.modelId
    })),
    [
      {
        sourcePath: 'registered-a.zip',
        stage: 'register',
        modelId: 'global-registered-a.zip'
      },
      {
        sourcePath: 'registered-b.zip',
        stage: 'register',
        modelId: 'global-registered-b.zip'
      }
    ]
  )

  const singleNewModelResult = await importNewModelsSequentially(
    [{ sourcePath: 'solo.zip', archiveEntry: 'solo/model.json' }],
    async (sourcePath, name, archiveEntry) => ({
      modelId: sourcePath,
      name,
      archiveEntry
    }),
    async (modelId, key, name) => ({ modelId, key, name }),
    () => undefined,
    () => undefined
  )

  assert.equal(singleNewModelResult.successCount, 1)
  assert.equal(singleNewModelResult.importedCount, 1)
  assert.deepEqual(singleNewModelResult.failures, [])

  const allFailedNewModelResult = await importNewModelsSequentially(
    [{ sourcePath: 'missing-model.zip' }, { sourcePath: 'invalid-model.json' }],
    async (sourcePath) => {
      throw new Error(`failed:${sourcePath}`)
    },
    async () => assert.fail('Registration must not run when every global model import fails'),
    () => assert.fail('The import callback must not run for failed model imports'),
    () => assert.fail('The registration callback must not run for failed model imports')
  )

  assert.equal(allFailedNewModelResult.successCount, 0)
  assert.equal(allFailedNewModelResult.importedCount, 0)
  assert.deepEqual(
    allFailedNewModelResult.failures.map((failure) => failure.sourcePath),
    ['missing-model.zip', 'invalid-model.json']
  )
  assert.deepEqual(
    allFailedNewModelResult.failures.map((failure) => failure.stage),
    ['import', 'import']
  )

  const allFailedPaths = []
  const allFailedResult = await importAssetsSequentially(
    ['missing.mp3', 'invalid.ogg'],
    async (sourcePath) => {
      allFailedPaths.push(sourcePath)
      throw new Error(`failed:${sourcePath}`)
    },
    () => assert.fail('The success callback must not run for failed imports')
  )

  assert.deepEqual(allFailedPaths, ['missing.mp3', 'invalid.ogg'])
  assert.equal(allFailedResult.successCount, 0)
  assert.equal(allFailedResult.failures.length, 2)
  assert.match(allFailedResult.failures[0].error.message, /missing\.mp3/)
  assert.match(allFailedResult.failures[1].error.message, /invalid\.ogg/)
} finally {
  await server.close()
}
