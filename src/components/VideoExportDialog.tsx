import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX
} from 'react'
import type { TFunction } from 'i18next'
import { save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Film,
  FolderOpen,
  LoaderCircle,
  XCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import {
  CONTAINER_AUDIO_CODECS,
  CONTAINER_VIDEO_CODECS,
  FPS_PRESETS,
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WIDTH,
  MIN_EXPORT_HEIGHT,
  MIN_EXPORT_WIDTH,
  RESOLUTION_PRESETS,
  VideoExportEngineUnavailableError,
  coerceCodecsForContainer,
  computeRecommendedBitrateMbps,
  createDefaultExportConfig,
  normalizeEvenDimension,
  normalizeExportFps,
  probeFfmpegCapabilities,
  probeWebCodecsSupport,
  runVideoExport,
  type ExportAudioCodec,
  type ExportEngineMode,
  type ExportVideoCodec,
  type FfmpegCapabilities,
  type ResolutionPreset,
  type ResolutionPresetId,
  type VideoContainerFormat,
  type VideoExportConfig,
  type VideoExportProgress,
  type VideoExportResult,
  type WebCodecsSupportStatus
} from '@/export'
import { isMobileRuntime } from '@/lib/platform'
import { cn } from '@/lib/style'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { ProjectAssets } from '@/project/assets'
import type { AppSettings } from '@/settings/types'
import { StoryAbortError } from '@/story'
import type { SnippetData, StoryData } from '@/story/schema'

export type VideoExportProjectData = {
  projectName: string
  story: StoryData
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  dataPath: string
  projectPath: string
  settings: AppSettings | null
}

export type VideoExportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  projectData?: VideoExportProjectData | null
  loadProjectData?: () => Promise<VideoExportProjectData>
}

type ExportStatus = 'idle' | 'exporting' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

const CONTAINER_OPTIONS: readonly VideoContainerFormat[] = ['mp4', 'webm', 'mov']

function hasStoryAudio(story: StoryData): boolean {
  const walk = (snippets: readonly SnippetData[]): boolean => {
    for (const snippet of snippets) {
      if (snippet.type === 'Parallel') {
        if (walk(snippet.snippets)) return true
      } else if (snippet.type === 'Talk' && Boolean(snippet.data.voice)) {
        return true
      }
    }
    return false
  }
  return walk(story.snippets)
}

function getPresetLabel(presetId: ResolutionPresetId, t: TFunction): string {
  switch (presetId) {
    case '720p':
      return t('videoExport.preset720p')
    case '1080p':
      return t('videoExport.preset1080p')
    case '2k':
      return t('videoExport.preset2k')
    case '4k':
      return t('videoExport.preset4k')
    case 'custom':
      return t('videoExport.presetCustom')
  }
}

function getVideoCodecLabel(codec: ExportVideoCodec, t: TFunction): string {
  switch (codec) {
    case 'h264':
      return t('videoExport.codecH264')
    case 'hevc':
      return t('videoExport.codecHevc')
    case 'vp9':
      return t('videoExport.codecVp9')
    case 'av1':
      return t('videoExport.codecAv1')
    case 'prores':
      return t('videoExport.codecProres')
  }
}

function getAudioCodecLabel(codec: ExportAudioCodec, t: TFunction): string {
  switch (codec) {
    case 'aac':
      return t('videoExport.audioAac')
    case 'opus':
      return t('videoExport.audioOpus')
    case 'pcm_s16le':
      return t('videoExport.audioPcm')
  }
}

function getContainerLabel(format: VideoContainerFormat): string {
  return format.toUpperCase()
}

function getContainerFileFilter(
  format: VideoContainerFormat,
  t: TFunction
): { name: string; extensions: string[] } {
  switch (format) {
    case 'mp4':
      return { name: t('videoExport.fileTypeMp4'), extensions: ['mp4'] }
    case 'webm':
      return { name: t('videoExport.fileTypeWebm'), extensions: ['webm'] }
    case 'mov':
      return { name: t('videoExport.fileTypeMov'), extensions: ['mov'] }
  }
}

function formatDurationMs(ms: number): string {
  const totalSeconds: number = Math.max(0, Math.round(ms / 1000))
  const hours: number = Math.floor(totalSeconds / 3600)
  const minutes: number = Math.floor((totalSeconds % 3600) / 60)
  const seconds: number = totalSeconds % 60
  const paddedMin: string = String(minutes).padStart(2, '0')
  const paddedSec: string = String(seconds).padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${paddedMin}:${paddedSec}`
  }
  return `${paddedMin}:${paddedSec}`
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units: readonly string[] = ['B', 'KB', 'MB', 'GB']
  let value: number = bytes
  let unitIndex: number = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision: number = unitIndex === 0 ? 0 : value >= 100 ? 1 : 2
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function getPhaseText(progress: VideoExportProgress | null, t: TFunction): string {
  if (!progress) return t('videoExport.phasePreparing')
  switch (progress.phase) {
    case 'preparing':
      return t('videoExport.phasePreparing')
    case 'rendering':
      return t('videoExport.phaseRendering')
    case 'encodingAudio':
      return t('videoExport.phaseEncodingAudio')
    case 'muxing':
      return t('videoExport.phaseMuxing')
    case 'completed':
      return t('videoExport.phaseCompleted')
    case 'cancelled':
      return t('videoExport.phaseCancelled')
    case 'failed':
      return t('videoExport.phaseFailed')
  }
}

function formatExportError(error: unknown, t: TFunction): string {
  if (error instanceof VideoExportEngineUnavailableError) {
    switch (error.code) {
      case 'WEBCODECS_AND_FFMPEG_UNAVAILABLE':
        return t('videoExport.engineUnavailableBoth')
      case 'FFMPEG_UNAVAILABLE':
        return t('videoExport.engineUnavailableFfmpeg')
      case 'WEBCODECS_UNAVAILABLE':
        return t('videoExport.engineUnavailableWebCodecs')
    }
  }
  return t('videoExport.exportFailed', {
    error: error instanceof Error ? error.message : String(error)
  })
}

function findMatchingResolutionPreset(width: number, height: number): ResolutionPresetId {
  const matched: ResolutionPreset | undefined = RESOLUTION_PRESETS.find(
    (preset: ResolutionPreset): boolean => preset.width === width && preset.height === height
  )
  return matched ? matched.id : 'custom'
}

export function VideoExportDialog({
  open,
  onOpenChange,
  projectName,
  projectData,
  loadProjectData
}: VideoExportDialogProps): JSX.Element {
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()

  const [loadedProject, setLoadedProject] = useState<VideoExportProjectData | null>(
    (): VideoExportProjectData | null => projectData ?? null
  )
  const [projectLoading, setProjectLoading] = useState<boolean>(false)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [config, setConfig] = useState<VideoExportConfig>(
    (): VideoExportConfig =>
      createDefaultExportConfig(projectData?.settings?.playback.memorySizeMb ?? 512)
  )
  const [widthText, setWidthText] = useState<string>((): string => String(config.width))
  const [heightText, setHeightText] = useState<string>((): string => String(config.height))
  const [fpsText, setFpsText] = useState<string>((): string => String(config.fps))
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false)

  const [ffmpegCaps, setFfmpegCaps] = useState<FfmpegCapabilities | null>(null)
  const [webCodecsSupport, setWebCodecsSupport] = useState<WebCodecsSupportStatus | null>(null)

  const [status, setStatus] = useState<ExportStatus>('idle')
  const [progress, setProgress] = useState<VideoExportProgress | null>(null)
  const [result, setResult] = useState<VideoExportResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const projectDataRef = useRef<VideoExportProjectData | null | undefined>(projectData)
  const loadProjectDataRef = useRef<(() => Promise<VideoExportProjectData>) | undefined>(
    loadProjectData
  )
  const tRef = useRef<TFunction>(t)
  const isExporting: boolean = status === 'exporting' || status === 'cancelling'

  const hasAudioTrack: boolean = useMemo(
    (): boolean => (loadedProject ? hasStoryAudio(loadedProject.story) : false),
    [loadedProject]
  )

  useEffect((): void => {
    projectDataRef.current = projectData
    loadProjectDataRef.current = loadProjectData
    tRef.current = t
  }, [projectData, loadProjectData, t])

  useEffect((): (() => void) | void => {
    if (!open) return

    setStatus('idle')
    setProgress(null)
    setResult(null)
    setErrorMessage(null)
    setProjectLoadError(null)

    const immediateData: VideoExportProjectData | null | undefined = projectDataRef.current
    const loader: (() => Promise<VideoExportProjectData>) | undefined = loadProjectDataRef.current

    if (immediateData) {
      setLoadedProject(immediateData)
      setProjectLoading(false)
      return
    }

    if (!loader) {
      setLoadedProject(null)
      return
    }

    let cancelled: boolean = false
    setProjectLoading(true)
    setLoadedProject(null)

    void loader()
      .then((loaded: VideoExportProjectData): void => {
        if (cancelled) return
        setLoadedProject(loaded)
        setProjectLoading(false)
      })
      .catch((error: unknown): void => {
        if (cancelled) return
        setProjectLoading(false)
        setProjectLoadError(
          tRef.current('videoExport.loadProjectFailed', {
            error: error instanceof Error ? error.message : String(error)
          })
        )
      })

    return (): void => {
      cancelled = true
    }
  }, [open, projectName])

  useEffect((): void => {
    if (!loadedProject?.settings || isExporting) return
    const nextMemoryMb: number = loadedProject.settings.playback.memorySizeMb
    const nextFfmpegPath: string | undefined = loadedProject.settings.export?.ffmpegPath
    setConfig((prev: VideoExportConfig): VideoExportConfig => {
      if (prev.memorySizeMb === nextMemoryMb && prev.ffmpegPath === nextFfmpegPath) {
        return prev
      }
      return {
        ...prev,
        memorySizeMb: nextMemoryMb,
        ffmpegPath: nextFfmpegPath
      }
    })
  }, [loadedProject, isExporting])

  useEffect((): (() => void) | void => {
    if (!open || mobileRuntime) {
      setFfmpegCaps(null)
      return
    }
    let cancelled: boolean = false
    void probeFfmpegCapabilities(config.ffmpegPath)
      .then((caps: FfmpegCapabilities): void => {
        if (!cancelled) setFfmpegCaps(caps)
      })
      .catch((): void => {
        if (!cancelled) {
          setFfmpegCaps({
            available: false,
            executablePath: null,
            version: null,
            customPathInvalid: Boolean(config.ffmpegPath),
            hardwareEncoders: [],
            softwareEncoders: []
          })
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [open, mobileRuntime, config.ffmpegPath])

  useEffect((): (() => void) => {
    if (!open) {
      return (): void => undefined
    }
    let cancelled: boolean = false
    void probeWebCodecsSupport(config, hasAudioTrack)
      .then((support: WebCodecsSupportStatus): void => {
        if (!cancelled) setWebCodecsSupport(support)
      })
      .catch((): void => {
        if (!cancelled) {
          setWebCodecsSupport({
            supported: false,
            hardwareAcceleration: 'no-preference'
          })
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [open, config, hasAudioTrack])

  useEffect((): (() => void) => {
    return (): void => {
      abortControllerRef.current?.abort()
    }
  }, [])

  const applyDimensions = useCallback((rawWidth: number, rawHeight: number): void => {
    const safeWidth: number = normalizeEvenDimension(rawWidth, MIN_EXPORT_WIDTH, MAX_EXPORT_WIDTH)
    const safeHeight: number = normalizeEvenDimension(
      rawHeight,
      MIN_EXPORT_HEIGHT,
      MAX_EXPORT_HEIGHT
    )
    const nextPreset: ResolutionPresetId = findMatchingResolutionPreset(safeWidth, safeHeight)
    setWidthText(String(safeWidth))
    setHeightText(String(safeHeight))

    setConfig(
      (prev: VideoExportConfig): VideoExportConfig => ({
        ...prev,
        presetId: nextPreset,
        width: safeWidth,
        height: safeHeight,
        bitrateMbps: computeRecommendedBitrateMbps(safeWidth, safeHeight, prev.fps, prev.videoCodec)
      })
    )
  }, [])

  const applyFps = useCallback((rawFps: number): void => {
    const safeFps: number = normalizeExportFps(rawFps)
    setFpsText(String(safeFps))
    setConfig(
      (prev: VideoExportConfig): VideoExportConfig => ({
        ...prev,
        fps: safeFps,
        bitrateMbps: computeRecommendedBitrateMbps(
          prev.width,
          prev.height,
          safeFps,
          prev.videoCodec
        )
      })
    )
  }, [])

  const handleSelectResolutionPreset = (presetId: ResolutionPresetId): void => {
    if (presetId === 'custom') {
      setConfig(
        (prev: VideoExportConfig): VideoExportConfig => ({
          ...prev,
          presetId: 'custom'
        })
      )
      return
    }
    const preset: ResolutionPreset | undefined = RESOLUTION_PRESETS.find(
      (item: ResolutionPreset): boolean => item.id === presetId
    )
    if (!preset) return
    setWidthText(String(preset.width))
    setHeightText(String(preset.height))
    setConfig(
      (prev: VideoExportConfig): VideoExportConfig => ({
        ...prev,
        presetId,
        width: preset.width,
        height: preset.height,
        bitrateMbps: computeRecommendedBitrateMbps(
          preset.width,
          preset.height,
          prev.fps,
          prev.videoCodec
        )
      })
    )
  }

  const commitDimensionInputs = (): { width: number; height: number } => {
    const parsedWidth: number = Number(widthText)
    const parsedHeight: number = Number(heightText)
    const safeWidth: number = normalizeEvenDimension(
      Number.isFinite(parsedWidth) ? parsedWidth : config.width,
      MIN_EXPORT_WIDTH,
      MAX_EXPORT_WIDTH
    )
    const safeHeight: number = normalizeEvenDimension(
      Number.isFinite(parsedHeight) ? parsedHeight : config.height,
      MIN_EXPORT_HEIGHT,
      MAX_EXPORT_HEIGHT
    )
    applyDimensions(safeWidth, safeHeight)
    return { width: safeWidth, height: safeHeight }
  }

  const commitFpsInput = (): number => {
    const parsedFps: number = Number(fpsText)
    const safeFps: number = normalizeExportFps(Number.isFinite(parsedFps) ? parsedFps : config.fps)
    applyFps(safeFps)
    return safeFps
  }

  const handleContainerChange = (nextContainer: VideoContainerFormat): void => {
    setConfig((prev: VideoExportConfig): VideoExportConfig => {
      const coerced = coerceCodecsForContainer(
        nextContainer,
        prev.videoCodec,
        prev.audioCodec,
        prev.transparentAlpha
      )
      return {
        ...prev,
        container: nextContainer,
        videoCodec: coerced.videoCodec,
        audioCodec: coerced.audioCodec,
        transparentAlpha: coerced.transparentAlpha,
        bitrateMbps:
          coerced.videoCodec !== prev.videoCodec
            ? computeRecommendedBitrateMbps(prev.width, prev.height, prev.fps, coerced.videoCodec)
            : prev.bitrateMbps
      }
    })
  }

  const handleVideoCodecChange = (nextCodec: ExportVideoCodec): void => {
    setConfig((prev: VideoExportConfig): VideoExportConfig => {
      const coerced = coerceCodecsForContainer(
        prev.container,
        nextCodec,
        prev.audioCodec,
        prev.transparentAlpha
      )
      return {
        ...prev,
        videoCodec: coerced.videoCodec,
        audioCodec: coerced.audioCodec,
        transparentAlpha: coerced.transparentAlpha,
        bitrateMbps: computeRecommendedBitrateMbps(
          prev.width,
          prev.height,
          prev.fps,
          coerced.videoCodec
        )
      }
    })
  }

  const handleEngineChange = (nextEngine: ExportEngineMode): void => {
    setConfig(
      (prev: VideoExportConfig): VideoExportConfig => ({
        ...prev,
        engineMode: mobileRuntime && nextEngine === 'ffmpeg' ? 'auto' : nextEngine
      })
    )
  }

  const handleStartExport = async (): Promise<void> => {
    if (!loadedProject || isExporting) return

    const committedDims: { width: number; height: number } = commitDimensionInputs()
    const committedFps: number = commitFpsInput()
    const finalConfig: VideoExportConfig = {
      ...config,
      presetId: findMatchingResolutionPreset(committedDims.width, committedDims.height),
      width: committedDims.width,
      height: committedDims.height,
      fps: committedFps,
      engineMode: mobileRuntime && config.engineMode === 'ffmpeg' ? 'auto' : config.engineMode,
      memorySizeMb: loadedProject.settings?.playback.memorySizeMb ?? config.memorySizeMb,
      ffmpegPath: loadedProject.settings?.export?.ffmpegPath
    }

    const filter: { name: string; extensions: string[] } = getContainerFileFilter(
      finalConfig.container,
      t
    )
    let destination: string | null = null
    try {
      destination = await save({
        title: t('videoExport.saveTitle'),
        defaultPath: `${loadedProject.projectName}.${finalConfig.container}`,
        filters: mobileRuntime
          ? [filter, { name: t('common.allFiles'), extensions: ['*/*'] }]
          : [filter]
      })
    } catch {
      setErrorMessage(t('videoExport.chooseDestinationFailed'))
      setStatus('failed')
      return
    }

    if (!destination) return

    const controller: AbortController = new AbortController()
    abortControllerRef.current = controller
    setErrorMessage(null)
    setResult(null)
    setProgress(null)
    setStatus('exporting')

    try {
      const exportResult: VideoExportResult = await runVideoExport({
        story: loadedProject.story,
        assets: loadedProject.assets,
        modelRegistry: loadedProject.modelRegistry,
        dataPath: loadedProject.dataPath,
        projectPath: loadedProject.projectPath,
        settings: loadedProject.settings,
        config: finalConfig,
        destinationPath: destination,
        signal: controller.signal,
        onProgress: (nextProgress: VideoExportProgress): void => {
          setProgress(nextProgress)
        }
      })
      setResult(exportResult)
      setStatus('completed')
    } catch (error: unknown) {
      if (error instanceof StoryAbortError || controller.signal.aborted) {
        setStatus('cancelled')
      } else {
        setErrorMessage(formatExportError(error, t))
        setStatus('failed')
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }

  const handleCancelExport = (): void => {
    if (!abortControllerRef.current || status !== 'exporting') return
    setStatus('cancelling')
    abortControllerRef.current.abort()
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && isExporting) return
    onOpenChange(nextOpen)
  }

  const supportsAlpha: boolean = config.container === 'webm' || config.videoCodec === 'prores'
  const allowedVideoCodecs: readonly ExportVideoCodec[] = CONTAINER_VIDEO_CODECS[config.container]
  const allowedAudioCodecs: readonly ExportAudioCodec[] = CONTAINER_AUDIO_CODECS[config.container]

  const progressPercent: number = useMemo((): number => {
    if (!progress) return 0
    if (progress.phase === 'completed') return 100
    if (progress.phase === 'encodingAudio') return 94
    if (progress.phase === 'muxing') return 97
    if (progress.estimatedTotalFrames <= 0) return 0
    return Math.min(
      92,
      Math.max(0, Math.round((progress.renderedFrames / progress.estimatedTotalFrames) * 92))
    )
  }, [progress])

  const showFfmpegFallbackWarning: boolean = Boolean(
    webCodecsSupport &&
      !webCodecsSupport.supported &&
      config.engineMode === 'auto' &&
      !mobileRuntime &&
      ffmpegCaps?.available
  )

  const showWebCodecsUnavailableWarning: boolean = Boolean(
    !mobileRuntime &&
      webCodecsSupport &&
      !webCodecsSupport.supported &&
      config.engineMode === 'webcodecs'
  )

  const showMobileUnavailableWarning: boolean = Boolean(
    mobileRuntime && webCodecsSupport && !webCodecsSupport.supported
  )

  const showBothUnavailableWarning: boolean = Boolean(
    !mobileRuntime &&
      webCodecsSupport &&
      !webCodecsSupport.supported &&
      config.engineMode === 'auto' &&
      ffmpegCaps !== null &&
      !ffmpegCaps.available
  )

  const showCrfInput: boolean =
    !mobileRuntime &&
    config.engineMode !== 'webcodecs' &&
    !config.hardwareAccel &&
    config.videoCodec !== 'prores'

  const resultEngineLabel: string = result
    ? result.engineUsed === 'webcodecs'
      ? 'WebCodecs'
      : result.selectedEncoder
        ? `FFmpeg (${result.selectedEncoder})`
        : 'FFmpeg'
    : ''

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl select-none"
        onInteractOutside={(event: { preventDefault: () => void }): void => {
          if (isExporting) event.preventDefault()
        }}
        onEscapeKeyDown={(event: { preventDefault: () => void }): void => {
          if (isExporting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="size-5 shrink-0" />
            <span>
              {t('videoExport.dialogTitle')} — {projectName}
            </span>
          </DialogTitle>
          <DialogDescription>{t('videoExport.dialogDescription')}</DialogDescription>
        </DialogHeader>

        {projectLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin shrink-0" />
            <span>{t('videoExport.loadingProject')}</span>
          </div>
        ) : projectLoadError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>{projectLoadError}</span>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Resolution Presets */}
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('videoExport.resolution')}</div>
              <div className="flex flex-wrap gap-2">
                {(['720p', '1080p', '2k', '4k', 'custom'] as const).map(
                  (presetId: ResolutionPresetId): JSX.Element => (
                    <Button
                      key={presetId}
                      type="button"
                      size="sm"
                      disabled={isExporting}
                      variant={config.presetId === presetId ? 'default' : 'outline'}
                      onClick={(): void => handleSelectResolutionPreset(presetId)}
                    >
                      {getPresetLabel(presetId, t)}
                    </Button>
                  )
                )}
              </div>

              {config.presetId === 'custom' && (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label htmlFor="video-export-width" className="text-xs text-muted-foreground">
                      {t('videoExport.width')}
                    </label>
                    <Input
                      id="video-export-width"
                      type="number"
                      min={MIN_EXPORT_WIDTH}
                      max={MAX_EXPORT_WIDTH}
                      step={2}
                      disabled={isExporting}
                      value={widthText}
                      onChange={(e: ChangeEvent<HTMLInputElement>): void =>
                        setWidthText(e.target.value)
                      }
                      onBlur={(): void => {
                        commitDimensionInputs()
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="video-export-height" className="text-xs text-muted-foreground">
                      {t('videoExport.height')}
                    </label>
                    <Input
                      id="video-export-height"
                      type="number"
                      min={MIN_EXPORT_HEIGHT}
                      max={MAX_EXPORT_HEIGHT}
                      step={2}
                      disabled={isExporting}
                      value={heightText}
                      onChange={(e: ChangeEvent<HTMLInputElement>): void =>
                        setHeightText(e.target.value)
                      }
                      onBlur={(): void => {
                        commitDimensionInputs()
                      }}
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">{t('videoExport.dimensionHint')}</p>
            </div>

            {/* Frame Rate Presets */}
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('videoExport.frameRate')}</div>
              <div className="flex flex-wrap items-center gap-2">
                {FPS_PRESETS.map(
                  (presetFps: number): JSX.Element => (
                    <Button
                      key={presetFps}
                      type="button"
                      size="sm"
                      disabled={isExporting}
                      variant={config.fps === presetFps ? 'default' : 'outline'}
                      onClick={(): void => {
                        applyFps(presetFps)
                      }}
                    >
                      {presetFps} fps
                    </Button>
                  )
                )}
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="video-export-custom-fps"
                    className="text-xs text-muted-foreground shrink-0"
                  >
                    {t('videoExport.customFps')}
                  </label>
                  <Input
                    id="video-export-custom-fps"
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    disabled={isExporting}
                    className="h-8 w-24"
                    value={fpsText}
                    onChange={(e: ChangeEvent<HTMLInputElement>): void =>
                      setFpsText(e.target.value)
                    }
                    onBlur={(): void => {
                      commitFpsInput()
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Advanced Encoding Options */}
            <div className="rounded-md border">
              <button
                type="button"
                disabled={isExporting}
                aria-expanded={advancedOpen}
                onClick={(): void => setAdvancedOpen((prev: boolean): boolean => !prev)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium hover:bg-muted/40 disabled:opacity-50"
              >
                <span>{t('videoExport.advancedOptions')}</span>
                {advancedOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </button>

              {advancedOpen && (
                <div className="space-y-4 border-t px-3 py-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {/* Container */}
                    <div className="space-y-1">
                      <label htmlFor="video-export-container" className="text-xs font-medium">
                        {t('videoExport.container')}
                      </label>
                      <select
                        id="video-export-container"
                        disabled={isExporting}
                        value={config.container}
                        onChange={(e: ChangeEvent<HTMLSelectElement>): void =>
                          handleContainerChange(e.target.value as VideoContainerFormat)
                        }
                        className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      >
                        {CONTAINER_OPTIONS.map(
                          (container: VideoContainerFormat): JSX.Element => (
                            <option key={container} value={container}>
                              {getContainerLabel(container)}
                            </option>
                          )
                        )}
                      </select>
                    </div>

                    {/* Video Codec */}
                    <div className="space-y-1">
                      <label htmlFor="video-export-video-codec" className="text-xs font-medium">
                        {t('videoExport.videoCodec')}
                      </label>
                      <select
                        id="video-export-video-codec"
                        disabled={isExporting}
                        value={config.videoCodec}
                        onChange={(e: ChangeEvent<HTMLSelectElement>): void =>
                          handleVideoCodecChange(e.target.value as ExportVideoCodec)
                        }
                        className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      >
                        {allowedVideoCodecs.map(
                          (codec: ExportVideoCodec): JSX.Element => (
                            <option key={codec} value={codec}>
                              {getVideoCodecLabel(codec, t)}
                            </option>
                          )
                        )}
                      </select>
                    </div>

                    {/* Audio Codec */}
                    <div className="space-y-1">
                      <label htmlFor="video-export-audio-codec" className="text-xs font-medium">
                        {t('videoExport.audioCodec')}
                      </label>
                      <select
                        id="video-export-audio-codec"
                        disabled={isExporting}
                        value={config.audioCodec}
                        onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
                          const nextAudio: ExportAudioCodec = e.target.value as ExportAudioCodec
                          setConfig(
                            (prev: VideoExportConfig): VideoExportConfig => ({
                              ...prev,
                              audioCodec: nextAudio
                            })
                          )
                        }}
                        className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      >
                        {allowedAudioCodecs.map(
                          (codec: ExportAudioCodec): JSX.Element => (
                            <option key={codec} value={codec}>
                              {getAudioCodecLabel(codec, t)}
                            </option>
                          )
                        )}
                      </select>
                    </div>

                    {/* Engine */}
                    <div className="space-y-1">
                      <label htmlFor="video-export-engine" className="text-xs font-medium">
                        {t('videoExport.engine')}
                      </label>
                      <select
                        id="video-export-engine"
                        disabled={isExporting}
                        value={config.engineMode}
                        onChange={(e: ChangeEvent<HTMLSelectElement>): void =>
                          handleEngineChange(e.target.value as ExportEngineMode)
                        }
                        className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      >
                        <option value="auto">{t('videoExport.engineAuto')}</option>
                        <option value="webcodecs">{t('videoExport.engineWebCodecs')}</option>
                        {!mobileRuntime && (
                          <option value="ffmpeg">{t('videoExport.engineFfmpeg')}</option>
                        )}
                      </select>
                    </div>

                    {/* Bitrate */}
                    <div className="space-y-1">
                      <label htmlFor="video-export-bitrate" className="text-xs font-medium">
                        {t('videoExport.bitrateMbps')}
                      </label>
                      <Input
                        id="video-export-bitrate"
                        type="number"
                        min={1}
                        max={400}
                        step={1}
                        disabled={isExporting}
                        value={config.bitrateMbps}
                        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                          const parsed: number = Number(e.target.value)
                          if (!Number.isFinite(parsed)) return
                          setConfig(
                            (prev: VideoExportConfig): VideoExportConfig => ({
                              ...prev,
                              bitrateMbps: Math.min(400, Math.max(1, Math.round(parsed)))
                            })
                          )
                        }}
                      />
                    </div>

                    {/* CRF for FFmpeg Software Encode */}
                    {showCrfInput && (
                      <div className="space-y-1">
                        <label htmlFor="video-export-crf" className="text-xs font-medium">
                          {t('videoExport.crf')}
                        </label>
                        <Input
                          id="video-export-crf"
                          type="number"
                          min={0}
                          max={51}
                          step={1}
                          disabled={isExporting}
                          value={config.crf}
                          onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                            const parsed: number = Number(e.target.value)
                            if (!Number.isFinite(parsed)) return
                            setConfig(
                              (prev: VideoExportConfig): VideoExportConfig => ({
                                ...prev,
                                crf: Math.min(51, Math.max(0, Math.round(parsed)))
                              })
                            )
                          }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Hardware Acceleration */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium">{t('videoExport.hardwareAccel')}</div>
                      <div className="text-xs text-muted-foreground">
                        {t('videoExport.hardwareAccelHint')}
                      </div>
                    </div>
                    <Switch
                      checked={config.hardwareAccel}
                      disabled={isExporting}
                      aria-label={t('videoExport.hardwareAccel')}
                      onCheckedChange={(checked: boolean): void => {
                        setConfig(
                          (prev: VideoExportConfig): VideoExportConfig => ({
                            ...prev,
                            hardwareAccel: checked
                          })
                        )
                      }}
                    />
                  </div>

                  {/* Transparent Alpha */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium">{t('videoExport.transparentAlpha')}</div>
                      <div className="text-xs text-muted-foreground">
                        {t('videoExport.transparentAlphaHint')}
                      </div>
                    </div>
                    <Switch
                      checked={config.transparentAlpha}
                      disabled={isExporting || !supportsAlpha}
                      aria-label={t('videoExport.transparentAlpha')}
                      onCheckedChange={(checked: boolean): void => {
                        setConfig(
                          (prev: VideoExportConfig): VideoExportConfig => ({
                            ...prev,
                            transparentAlpha: supportsAlpha ? checked : false
                          })
                        )
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Engine Availability / Warnings */}
            {!mobileRuntime && ffmpegCaps && (
              <div
                className={cn(
                  'rounded-md border px-3 py-2 text-xs',
                  ffmpegCaps.available
                    ? 'border-border bg-muted/30 text-muted-foreground'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                )}
              >
                {ffmpegCaps.available
                  ? t('videoExport.ffmpegDetected', { version: ffmpegCaps.version ?? '' })
                  : t('videoExport.ffmpegMissing')}
              </div>
            )}

            {(showFfmpegFallbackWarning ||
              showWebCodecsUnavailableWarning ||
              showMobileUnavailableWarning ||
              showBothUnavailableWarning) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {showMobileUnavailableWarning
                    ? t('videoExport.engineUnavailableMobile')
                    : showBothUnavailableWarning
                      ? t('videoExport.engineUnavailableBoth')
                      : showWebCodecsUnavailableWarning
                        ? t('videoExport.engineUnavailableWebCodecs')
                        : t('videoExport.webCodecsWarning')}
                </span>
              </div>
            )}

            {/* Progress / Result / Failure Banner */}
            {(isExporting || progress) && status !== 'completed' && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between text-sm font-medium">
                  <span className="flex items-center gap-2">
                    {isExporting && (
                      <LoaderCircle
                        className={
                          mobileRuntime ? 'size-4 shrink-0' : 'size-4 animate-spin shrink-0'
                        }
                      />
                    )}
                    <span>
                      {status === 'cancelling'
                        ? t('videoExport.cancelling')
                        : getPhaseText(progress, t)}
                    </span>
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {progressPercent}%
                  </span>
                </div>

                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${progressPercent}%` }} />
                </div>

                {progress && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
                    <span>
                      {t('videoExport.frameCounter', {
                        rendered: progress.renderedFrames,
                        total: progress.estimatedTotalFrames
                      })}
                    </span>
                    <div className="flex flex-wrap items-center gap-3">
                      {progress.fpsSpeed > 0 && (
                        <span>
                          {t('videoExport.renderSpeed', { fps: progress.fpsSpeed.toFixed(1) })}
                        </span>
                      )}
                      <span>
                        {t('videoExport.elapsedTime', {
                          elapsed: formatDurationMs(progress.elapsedMs)
                        })}
                      </span>
                      {progress.etaMs !== null && (
                        <span>
                          {t('videoExport.etaRemaining', {
                            eta: formatDurationMs(progress.etaMs)
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status === 'completed' && result && (
              <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>{t('videoExport.phaseCompleted')}</span>
                </div>
                <div className="text-xs opacity-90">
                  {t('videoExport.resultSummary', {
                    duration: formatDurationMs(result.durationMs),
                    frames: result.totalFrames,
                    size: formatFileSize(result.fileSizeBytes),
                    engine: resultEngineLabel
                  })}
                </div>
                <div className="truncate text-xs opacity-75" title={result.outputPath}>
                  {result.outputPath}
                </div>
              </div>
            )}

            {status === 'cancelled' && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                <AlertCircle className="size-4 shrink-0" />
                <span>{t('videoExport.phaseCancelled')}</span>
              </div>
            )}

            {status === 'failed' && errorMessage && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {isExporting ? (
            <Button
              type="button"
              variant="destructive"
              disabled={status === 'cancelling'}
              onClick={handleCancelExport}
            >
              {status === 'cancelling'
                ? t('videoExport.cancelling')
                : t('videoExport.cancelExport')}
            </Button>
          ) : status === 'completed' && result ? (
            <>
              {!mobileRuntime && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={(): void => {
                    void revealItemInDir(result.outputPath)
                  }}
                >
                  <FolderOpen className="size-4 mr-1.5" />
                  {t('videoExport.revealFile')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={(): void => {
                  setStatus('idle')
                  setResult(null)
                  setProgress(null)
                }}
              >
                {t('videoExport.exportAgain')}
              </Button>
              <Button type="button" onClick={(): void => onOpenChange(false)}>
                {t('videoExport.close')}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={(): void => onOpenChange(false)}>
                {t('videoExport.close')}
              </Button>
              <Button
                type="button"
                disabled={projectLoading || Boolean(projectLoadError) || !loadedProject}
                onClick={(): void => {
                  void handleStartExport()
                }}
              >
                <Film className="size-4 mr-1.5" />
                {t('videoExport.startExport')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
