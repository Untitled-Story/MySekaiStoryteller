import { extensions, type Ticker } from 'pixi.js'
import type { Live2DFactoryOptions, Live2DModel } from 'untitled-pixi-live2d-engine'

type Live2DEngine = typeof import('untitled-pixi-live2d-engine')

let live2DCoreReady: Promise<void> | null = null
let live2DEnginePromise: Promise<Live2DEngine> | null = null
let live2DEngine: Live2DEngine | null = null
let cubismConfigured = false
const pausedSoundOwners: Set<object> = new Set()
const pausedSounds: Set<ManagedLive2DSound> = new Set()

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
    live2DEngine = engine
    return engine
  })

  const engine = await live2DEnginePromise

  if (!cubismConfigured) {
    engine.configureCubismSDK({ memorySizeMB: cubismMemorySizeMB })
    cubismConfigured = true
  }

  return engine
}

type ManagedLive2DSound = {
  isPlaying: boolean
  pause(): unknown
  resume(): unknown
}

type Live2DSoundManager = {
  audios: ManagedLive2DSound[]
}

/** Coordinates the engine's global SoundManager across active story runtimes. */
export function pauseSekaiLive2DSounds(owner: object): void {
  if (pausedSoundOwners.has(owner)) return

  if (pausedSoundOwners.size === 0) {
    const manager: Live2DSoundManager | null = getLive2DSoundManager()
    for (const audio of manager?.audios ?? []) {
      if (!audio.isPlaying) continue
      pausedSounds.add(audio)
      audio.pause()
    }
  }
  pausedSoundOwners.add(owner)
}

export function resumeSekaiLive2DSounds(owner: object): void {
  if (!pausedSoundOwners.delete(owner) || pausedSoundOwners.size > 0) return

  for (const audio of pausedSounds) {
    audio.resume()
  }
  pausedSounds.clear()
}

function getLive2DSoundManager(): Live2DSoundManager | null {
  if (!live2DEngine) return null
  const candidate: unknown = live2DEngine.SoundManager
  if (!candidate || typeof candidate !== 'object') return null

  const audios: unknown = (candidate as Record<string, unknown>).audios
  if (!Array.isArray(audios)) return null
  return {
    audios: audios.filter(isManagedLive2DSound)
  }
}

function isManagedLive2DSound(value: unknown): value is ManagedLive2DSound {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.isPlaying === 'boolean' &&
    typeof candidate.pause === 'function' &&
    typeof candidate.resume === 'function'
  )
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
