import { extensions, type Ticker } from 'pixi.js'
import type { Live2DFactoryOptions, Live2DModel } from 'untitled-pixi-live2d-engine'

type Live2DEngine = typeof import('untitled-pixi-live2d-engine')

let live2DCoreReady: Promise<void> | null = null
let live2DEnginePromise: Promise<Live2DEngine> | null = null
let cubismConfigured = false

export type SekaiLive2DModel = Live2DModel

export type LoadSekaiLive2DModelOptions = {
  ticker?: Ticker
  cubismMemorySizeMB?: number
}

export async function loadSekaiLive2DModel(
  modelUrl: string,
  options: LoadSekaiLive2DModelOptions = {}
): Promise<SekaiLive2DModel> {
  const engine = await ensureSekaiLive2DReady(options.cubismMemorySizeMB)

  const factoryOptions: Live2DFactoryOptions = {
    ticker: options.ticker,
    autoFocus: false,
    autoHitTest: false,
    breathDepth: 0
  }

  return engine.Live2DModel.from(modelUrl, factoryOptions)
}

export async function ensureSekaiLive2DReady(cubismMemorySizeMB = 32): Promise<Live2DEngine> {
  await ensureLive2DCoreScripts()

  live2DEnginePromise ??= import('untitled-pixi-live2d-engine').then(async (engine) => {
    extensions.add(engine.Live2DPlugin)
    return engine
  })

  const engine = await live2DEnginePromise

  if (!cubismConfigured) {
    engine.configureCubismSDK({ memorySizeMB: cubismMemorySizeMB })
    cubismConfigured = true
  }

  return engine
}

async function ensureLive2DCoreScripts(): Promise<void> {
  live2DCoreReady ??= loadCoreScripts()
  await live2DCoreReady
}

async function loadCoreScripts(): Promise<void> {
  await loadScriptOnce('/live2d-core/live2d.min.js')
  await loadScriptOnce('/live2d-core/live2dcubismcore.js')
}

function loadScriptOnce(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
  if (existing?.dataset.loaded === 'true') {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement('script')

    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true'
        resolve()
      },
      { once: true }
    )
    script.addEventListener(
      'error',
      () => reject(new Error(`Live2D core script failed to load: ${src}`)),
      { once: true }
    )

    if (!existing) {
      script.src = src
      document.head.appendChild(script)
    }
  })
}
