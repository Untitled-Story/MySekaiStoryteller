import { extensions, type Ticker } from 'pixi.js'
import type { Live2DFactoryOptions, Live2DModel } from 'untitled-pixi-live2d-engine'

type Live2DEngine = typeof import('untitled-pixi-live2d-engine')

let live2DCoreReady: Promise<void> | null = null
let live2DEnginePromise: Promise<Live2DEngine> | null = null
let live2DEngine: Live2DEngine | null = null
let cubismConfigured = false
const DEFAULT_EYE_BLINK_PARAMETER_IDS: readonly string[] = ['ParamEyeLOpen', 'ParamEyeROpen']
const pausedSoundOwners: Set<object> = new Set()
const pausedSounds: Set<ManagedLive2DSound> = new Set()
/** Voices that finished loading while the story was paused; they start on resume. */
const deferredSoundStarts: Set<() => void> = new Set()

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
    breathDepth: 0,
    anchorMode: 'canvas'
  }

  return new Promise<SekaiLive2DModel>((resolve, reject): void => {
    const model: SekaiLive2DModel = engine.Live2DModel.fromSync(modelUrl, {
      ...factoryOptions,
      onLoad: (): void => resolve(model),
      onError: (error: Error): void => reject(error)
    })
    // fromSync defers loading, so the listener is attached before the settings JSON is read.
    model.once('settingsJSONLoaded', fillEmptyEyeBlinkGroup)
  })
}

/**
 * Sekai exports ship an `EyeBlink` group with no `Ids`, which the engine treats as "blink
 * disabled" and never creates the auto-blink controller. Fall back to the default eye params.
 */
function fillEmptyEyeBlinkGroup(settingsJson: object): void {
  const groups: unknown = (settingsJson as { Groups?: unknown }).Groups
  if (!Array.isArray(groups)) return

  for (const group of groups as unknown[]) {
    if (!group || typeof group !== 'object') continue
    const eyeBlinkGroup = group as { Name?: unknown; Ids?: unknown }
    if (eyeBlinkGroup.Name !== 'EyeBlink') continue
    if (!Array.isArray(eyeBlinkGroup.Ids) || eyeBlinkGroup.Ids.length === 0) {
      eyeBlinkGroup.Ids = [...DEFAULT_EYE_BLINK_PARAMETER_IDS]
    }
  }
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

/**
 * Plays a voice through the engine's SoundManager for models without a Live2D motion manager,
 * so pausing the story pauses it like any other managed sound. Resolves when playback ends.
 */
export async function playSekaiSound(url: string, volume: number): Promise<void> {
  const engine: Live2DEngine = await ensureSekaiLive2DReady()

  return new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
    void engine.SoundManager.add(url, reject).then((sound): void => {
      if (!sound) {
        resolve()
        return
      }
      sound.volume = volume
      const start = (): void => engine.SoundManager.play(sound, resolve)
      if (pausedSoundOwners.size > 0) {
        deferredSoundStarts.add(start)
      } else {
        start()
      }
    })
  })
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
  for (const start of deferredSoundStarts) {
    start()
  }
  deferredSoundStarts.clear()
}

function getLive2DSoundManager(): Live2DSoundManager | null {
  if (!live2DEngine) return null
  // SoundManager is a class whose state lives in static members, so it is a function, not an object.
  const candidate: unknown = live2DEngine.SoundManager
  if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) return null

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
