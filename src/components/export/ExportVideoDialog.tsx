import type { ChangeEvent, JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  ChevronDown,
  ChevronUp,
  Film,
  LoaderCircle,
  RotateCcw,
  Shuffle,
  SlidersHorizontal
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
import type { ToastVariant } from '@/components/ui/Toast'
import {
  AUDIO_BITRATE_OPTIONS,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_VIDEO_EXPORT_CONFIG,
  DEFAULT_VIDEO_SEED,
  MAX_AUDIO_VOLUME_PERCENT,
  MAX_EXPORT_FPS,
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WIDTH,
  MAX_GOP_FRAMES,
  MAX_TRAILING_HOLD_MS,
  MAX_VIDEO_BITRATE_KBPS,
  MAX_VIDEO_QP,
  MIN_EXPORT_FPS,
  MIN_EXPORT_HEIGHT,
  MIN_EXPORT_WIDTH,
  MIN_GOP_FRAMES,
  MIN_VIDEO_BITRATE_KBPS,
  VIDEO_FPS_OPTIONS,
  VIDEO_RESOLUTION_PRESETS,
  cancelVideoExport,
  exportProjectVideo,
  generateRandomExportSeed,
  getAvailableRenderBackends,
  isValidExportHexColor,
  isVideoExportCancelledError,
  listenVideoExportProgress,
  sanitizeVideoFileName,
  validateExportFps,
  validateVideoDimensions,
  type GpuBackendInfo,
  type RenderBackend,
  type VideoExportConfig,
  type VideoExportProgress,
  type VideoExportResult,
  type VideoExportStage,
  type VideoQualityPreset,
  type VideoRateControlMode,
  type VideoResolutionPreset,
  type VideoResolutionPresetId
} from '@/project/videoExport'

export interface ExportVideoDialogProps {
  open: boolean
  projectName: string | null
  onOpenChange: (open: boolean) => void
  onPrepareExport?: () => Promise<boolean>
  onNotice?: (message: string, variant: ToastVariant) => void
}

const SELECT_CLASS: string =
  'border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units: readonly string[] = ['B', 'KB', 'MB', 'GB']
  let value: number = bytes
  let unitIndex: number = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const decimals: number = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const rounded: number = Math.ceil(seconds)
  const mins: number = Math.floor(rounded / 60)
  const secs: number = rounded % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function formatEta(progress: VideoExportProgress): string {
  if (
    progress.stage !== 'rendering' ||
    progress.fpsActual <= 0.05 ||
    progress.estimatedTotalFrames <= progress.renderedFrames
  ) {
    return '--:--'
  }
  const remainingFrames: number = progress.estimatedTotalFrames - progress.renderedFrames
  return formatDurationSeconds(remainingFrames / progress.fpsActual)
}

function computeProgressPercent(progress: VideoExportProgress | null): number {
  if (!progress) return 0
  if (progress.stage === 'completed') return 100
  if (progress.stage === 'encodingAudio') return 94
  if (progress.stage === 'muxing') return 98
  if (progress.stage === 'preparing') return 4
  const total: number = Math.max(progress.estimatedTotalFrames, 1)
  const ratio: number = Math.min(Math.max(progress.renderedFrames / total, 0), 1)
  return Math.round(5 + ratio * 88)
}

function stageLabelKey(stage: VideoExportStage): string {
  switch (stage) {
    case 'preparing':
      return 'videoExport.stagePreparing'
    case 'rendering':
      return 'videoExport.stageRendering'
    case 'encodingAudio':
      return 'videoExport.stageEncodingAudio'
    case 'muxing':
      return 'videoExport.stageMuxing'
    case 'completed':
      return 'videoExport.stageCompleted'
  }
}

function parseStrictInt(text: string): number {
  const trimmed: string = text.trim()
  if (!/^-?\d+$/.test(trimmed)) return Number.NaN
  return Number(trimmed)
}

export function ExportVideoDialog({
  open,
  projectName,
  onOpenChange,
  onPrepareExport,
  onNotice
}: ExportVideoDialogProps): JSX.Element {
  const { t } = useTranslation()

  const [resolutionPreset, setResolutionPreset] = useState<VideoResolutionPresetId>('1080p')
  const [customWidthText, setCustomWidthText] = useState<string>(
    String(DEFAULT_VIDEO_EXPORT_CONFIG.width)
  )
  const [customHeightText, setCustomHeightText] = useState<string>(
    String(DEFAULT_VIDEO_EXPORT_CONFIG.height)
  )
  const [fpsPreset, setFpsPreset] = useState<string>(String(DEFAULT_VIDEO_EXPORT_CONFIG.fps))
  const [customFpsText, setCustomFpsText] = useState<string>(
    String(DEFAULT_VIDEO_EXPORT_CONFIG.fps)
  )
  const [quality, setQuality] = useState<VideoQualityPreset>(DEFAULT_VIDEO_EXPORT_CONFIG.quality)
  const [renderBackend, setRenderBackend] = useState<RenderBackend>(
    DEFAULT_VIDEO_EXPORT_CONFIG.renderBackend
  )
  const [availableBackends, setAvailableBackends] = useState<GpuBackendInfo[]>([])

  const [showAdvanced, setShowAdvanced] = useState<boolean>(false)
  const [rateMode, setRateMode] = useState<VideoRateControlMode>('preset')
  const [videoQpText, setVideoQpText] = useState<string>('19')
  const [videoBitrateText, setVideoBitrateText] = useState<string>('8000')
  const [gopMode, setGopMode] = useState<'auto' | 'custom'>('auto')
  const [gopFramesText, setGopFramesText] = useState<string>('120')

  const [includeAudio, setIncludeAudio] = useState<boolean>(true)
  const [hybridHardwareEncoder, setHybridHardwareEncoder] = useState<boolean>(false)
  const [audioBitrateOption, setAudioBitrateOption] = useState<string>('auto')
  const [audioVolumeText, setAudioVolumeText] = useState<string>('100')

  const [seedModeKind, setSeedModeKind] = useState<'fixed' | 'random'>('fixed')
  const [seedText, setSeedText] = useState<string>(String(DEFAULT_VIDEO_SEED))
  const [trailingHoldText, setTrailingHoldText] = useState<string>(
    String(DEFAULT_VIDEO_EXPORT_CONFIG.trailingHoldMs)
  )
  const [backgroundColor, setBackgroundColor] = useState<string>(DEFAULT_BACKGROUND_COLOR)

  const [exporting, setExporting] = useState<boolean>(false)
  const [cancelling, setCancelling] = useState<boolean>(false)
  const [progress, setProgress] = useState<VideoExportProgress | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<boolean>(false)

  const mountedRef = useRef<boolean>(true)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  useEffect((): (() => void) => {
    mountedRef.current = true
    return (): void => {
      mountedRef.current = false
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [])

  useEffect((): void => {
    if (!open) return
    setStatusMessage(null)
    setStatusError(false)
    if (!exporting) {
      setProgress(null)
      setCancelling(false)
    }
  }, [open, projectName, exporting])

  useEffect((): (() => void) | void => {
    if (!open) return
    let cancelled: boolean = false
    void getAvailableRenderBackends()
      .then((list: GpuBackendInfo[]): void => {
        if (!cancelled && mountedRef.current) {
          setAvailableBackends(list)
        }
      })
      .catch((): void => {
        if (!cancelled && mountedRef.current) {
          setAvailableBackends([])
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [open])

  const resetDefaults = (): void => {
    if (exporting) return
    setResolutionPreset('1080p')
    setCustomWidthText(String(DEFAULT_VIDEO_EXPORT_CONFIG.width))
    setCustomHeightText(String(DEFAULT_VIDEO_EXPORT_CONFIG.height))
    setFpsPreset(String(DEFAULT_VIDEO_EXPORT_CONFIG.fps))
    setCustomFpsText(String(DEFAULT_VIDEO_EXPORT_CONFIG.fps))
    setQuality(DEFAULT_VIDEO_EXPORT_CONFIG.quality)
    setRenderBackend(DEFAULT_VIDEO_EXPORT_CONFIG.renderBackend)
    setRateMode('preset')
    setVideoQpText('19')
    setVideoBitrateText('8000')
    setGopMode('auto')
    setGopFramesText('120')
    setIncludeAudio(true)
    setAudioBitrateOption('auto')
    setAudioVolumeText('100')
    setSeedModeKind('fixed')
    setSeedText(String(DEFAULT_VIDEO_SEED))
    setTrailingHoldText(String(DEFAULT_VIDEO_EXPORT_CONFIG.trailingHoldMs))
    setBackgroundColor(DEFAULT_BACKGROUND_COLOR)
    setStatusMessage(null)
    setStatusError(false)
  }

  const selectedDimensions: { width: number; height: number } = useMemo((): {
    width: number
    height: number
  } => {
    if (resolutionPreset === 'custom') {
      return {
        width: parseStrictInt(customWidthText),
        height: parseStrictInt(customHeightText)
      }
    }
    const found: VideoResolutionPreset | undefined = VIDEO_RESOLUTION_PRESETS.find(
      (preset: VideoResolutionPreset): boolean => preset.id === resolutionPreset
    )
    return found
      ? { width: found.width, height: found.height }
      : { width: DEFAULT_VIDEO_EXPORT_CONFIG.width, height: DEFAULT_VIDEO_EXPORT_CONFIG.height }
  }, [resolutionPreset, customWidthText, customHeightText])

  const resolvedFps: number = useMemo((): number => {
    if (fpsPreset === 'custom') {
      return parseStrictInt(customFpsText)
    }
    return parseStrictInt(fpsPreset)
  }, [fpsPreset, customFpsText])

  const validationError: string | null = useMemo((): string | null => {
    if (validateVideoDimensions(selectedDimensions.width, selectedDimensions.height) !== 'ok') {
      return t('videoExport.evenDimensionError')
    }
    if (!validateExportFps(resolvedFps)) {
      return t('videoExport.invalidFpsError')
    }
    if (rateMode === 'cqp') {
      const parsedQp: number = parseStrictInt(videoQpText)
      if (!Number.isInteger(parsedQp) || parsedQp < 0 || parsedQp > MAX_VIDEO_QP) {
        return t('videoExport.invalidVideoQpError')
      }
    }
    if (rateMode === 'abr') {
      const parsedBitrate: number = parseStrictInt(videoBitrateText)
      if (
        !Number.isInteger(parsedBitrate) ||
        parsedBitrate < MIN_VIDEO_BITRATE_KBPS ||
        parsedBitrate > MAX_VIDEO_BITRATE_KBPS
      ) {
        return t('videoExport.invalidVideoBitrateError')
      }
    }
    if (gopMode === 'custom') {
      const parsedGop: number = parseStrictInt(gopFramesText)
      if (
        !Number.isInteger(parsedGop) ||
        parsedGop < MIN_GOP_FRAMES ||
        parsedGop > MAX_GOP_FRAMES
      ) {
        return t('videoExport.invalidGopError')
      }
    }
    if (includeAudio) {
      const parsedVolume: number = parseStrictInt(audioVolumeText)
      if (
        !Number.isInteger(parsedVolume) ||
        parsedVolume < 0 ||
        parsedVolume > MAX_AUDIO_VOLUME_PERCENT
      ) {
        return t('videoExport.invalidAudioVolumeError')
      }
    }
    if (seedModeKind === 'fixed') {
      const parsedSeed: number = parseStrictInt(seedText)
      if (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0) {
        return t('videoExport.invalidSeedError')
      }
    }
    const parsedHold: number = parseStrictInt(trailingHoldText)
    if (!Number.isInteger(parsedHold) || parsedHold < 0 || parsedHold > MAX_TRAILING_HOLD_MS) {
      return t('videoExport.invalidTrailingHoldError')
    }
    if (!isValidExportHexColor(backgroundColor)) {
      return t('videoExport.invalidBackgroundColorError')
    }
    return null
  }, [
    selectedDimensions,
    resolvedFps,
    rateMode,
    videoQpText,
    videoBitrateText,
    gopMode,
    gopFramesText,
    includeAudio,
    audioVolumeText,
    seedModeKind,
    seedText,
    trailingHoldText,
    backgroundColor,
    t
  ])

  const handleResolutionPresetChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const nextPreset: VideoResolutionPresetId = event.target.value as VideoResolutionPresetId
    setResolutionPreset(nextPreset)
    if (nextPreset !== 'custom') {
      const found: VideoResolutionPreset | undefined = VIDEO_RESOLUTION_PRESETS.find(
        (preset: VideoResolutionPreset): boolean => preset.id === nextPreset
      )
      if (found) {
        setCustomWidthText(String(found.width))
        setCustomHeightText(String(found.height))
      }
    }
  }

  const handleFpsPresetChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const nextValue: string = event.target.value
    setFpsPreset(nextValue)
    if (nextValue !== 'custom') {
      setCustomFpsText(nextValue)
    }
  }

  const handleDialogOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && exporting) return
    onOpenChange(nextOpen)
  }

  const handleStartExport = async (): Promise<void> => {
    if (!projectName || exporting || validationError) return

    setStatusMessage(null)
    setStatusError(false)

    const defaultFileName: string = `${sanitizeVideoFileName(projectName)}.mp4`
    const destination: string | null = await saveFileDialog({
      title: t('videoExport.chooseDestination'),
      defaultPath: defaultFileName,
      filters: [{ name: t('videoExport.fileType'), extensions: ['mp4'] }]
    })
    if (!destination) return

    if (onPrepareExport) {
      const ready: boolean = await onPrepareExport()
      if (!ready) return
    }

    const config: VideoExportConfig = {
      width: selectedDimensions.width,
      height: selectedDimensions.height,
      fps: resolvedFps,
      quality,
      hybridHardwareEncoder,
      renderBackend,
      seedMode:
        seedModeKind === 'fixed'
          ? { mode: 'fixed', seed: parseStrictInt(seedText) }
          : { mode: 'random' },
      trailingHoldMs: parseStrictInt(trailingHoldText),
      videoQp: rateMode === 'cqp' ? parseStrictInt(videoQpText) : null,
      videoBitrateKbps: rateMode === 'abr' ? parseStrictInt(videoBitrateText) : null,
      gopFrames: gopMode === 'custom' ? parseStrictInt(gopFramesText) : null,
      includeAudio,
      audioBitrateKbps:
        includeAudio && audioBitrateOption !== 'auto' ? parseStrictInt(audioBitrateOption) : null,
      audioVolumePercent: includeAudio ? parseStrictInt(audioVolumeText) : 100,
      backgroundColor: backgroundColor.trim()
    }

    setExporting(true)
    setCancelling(false)
    setProgress({
      stage: 'preparing',
      renderedFrames: 0,
      estimatedTotalFrames: 1,
      elapsedMs: 0,
      durationMs: 0,
      fpsActual: 0
    })

    let unlisten: UnlistenFn | null = null
    try {
      unlisten = await listenVideoExportProgress((nextProgress: VideoExportProgress): void => {
        if (mountedRef.current) {
          setProgress(nextProgress)
        }
      })
      unlistenRef.current = unlisten

      const result: VideoExportResult = await exportProjectVideo({
        projectName,
        destinationPath: destination,
        config
      })
      if (!mountedRef.current) return
      setExporting(false)
      setProgress(null)
      onOpenChange(false)
      onNotice?.(
        t('videoExport.exportComplete', {
          frames: result.videoFrames,
          size: formatBytes(result.bytesWritten)
        }),
        'success'
      )
    } catch (error: unknown) {
      if (!mountedRef.current) return
      setExporting(false)
      setCancelling(false)
      setProgress(null)
      if (isVideoExportCancelledError(error)) {
        setStatusError(false)
        setStatusMessage(t('videoExport.exportCancelled'))
      } else {
        const message: string = error instanceof Error ? error.message : String(error)
        const formattedError: string = t('videoExport.exportFailed', { error: message })
        setStatusError(true)
        setStatusMessage(formattedError)
        onNotice?.(formattedError, 'error')
      }
    } finally {
      if (unlisten) {
        unlisten()
        if (unlistenRef.current === unlisten) {
          unlistenRef.current = null
        }
      }
    }
  }

  const handleCancelExport = async (): Promise<void> => {
    if (!exporting || cancelling) return
    setCancelling(true)
    try {
      await cancelVideoExport()
    } catch {
      if (mountedRef.current) {
        setCancelling(false)
      }
    }
  }

  const progressPercent: number = computeProgressPercent(progress)
  const presetSelectLabel = (presetId: Exclude<VideoResolutionPresetId, 'custom'>): string => {
    switch (presetId) {
      case '2160p':
        return t('videoExport.preset2160p')
      case '1440p':
        return t('videoExport.preset1440p')
      case '1080p':
        return t('videoExport.preset1080p')
      case '720p':
        return t('videoExport.preset720p')
      case '480p':
        return t('videoExport.preset480p')
      case 'portrait1080':
        return t('videoExport.presetPortrait1080')
    }
  }

  const swatchColor: string = /^#[0-9a-fA-F]{6}$/.test(backgroundColor.trim())
    ? backgroundColor.trim()
    : DEFAULT_BACKGROUND_COLOR

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="select-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="size-4 shrink-0" />
            <span>{t('videoExport.dialogTitle')}</span>
          </DialogTitle>
          <DialogDescription>{t('videoExport.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto py-1 pr-1">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('videoExport.resolution')}
            </label>
            <select
              aria-label={t('videoExport.resolution')}
              value={resolutionPreset}
              disabled={exporting}
              onChange={handleResolutionPresetChange}
              className={SELECT_CLASS}
            >
              {VIDEO_RESOLUTION_PRESETS.map(
                (preset: VideoResolutionPreset): JSX.Element => (
                  <option key={preset.id} value={preset.id}>
                    {presetSelectLabel(preset.id)}
                  </option>
                )
              )}
              <option value="custom">{t('videoExport.presetCustom')}</option>
            </select>

            {resolutionPreset === 'custom' && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('videoExport.width')}</label>
                  <Input
                    type="number"
                    min={MIN_EXPORT_WIDTH}
                    max={MAX_EXPORT_WIDTH}
                    step={2}
                    disabled={exporting}
                    aria-label={t('videoExport.width')}
                    value={customWidthText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setCustomWidthText(event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('videoExport.height')}</label>
                  <Input
                    type="number"
                    min={MIN_EXPORT_HEIGHT}
                    max={MAX_EXPORT_HEIGHT}
                    step={2}
                    disabled={exporting}
                    aria-label={t('videoExport.height')}
                    value={customHeightText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setCustomHeightText(event.target.value)
                    }
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('videoExport.fps')}
              </label>
              <select
                aria-label={t('videoExport.fps')}
                value={fpsPreset}
                disabled={exporting}
                onChange={handleFpsPresetChange}
                className={SELECT_CLASS}
              >
                {VIDEO_FPS_OPTIONS.map(
                  (fpsOption: number): JSX.Element => (
                    <option key={fpsOption} value={String(fpsOption)}>
                      {t('videoExport.fpsUnit', { fps: fpsOption })}
                    </option>
                  )
                )}
                <option value="custom">{t('videoExport.fpsCustomOption')}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('videoExport.quality')}
              </label>
              <select
                aria-label={t('videoExport.quality')}
                value={quality}
                disabled={exporting}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                  setQuality(event.target.value as VideoQualityPreset)
                }
                className={SELECT_CLASS}
              >
                <option value="speed">{t('videoExport.qualitySpeed')}</option>
                <option value="fast">{t('videoExport.qualityFast')}</option>
                <option value="balanced">{t('videoExport.qualityBalanced')}</option>
                <option value="high">{t('videoExport.qualityHigh')}</option>
                <option value="quality">{t('videoExport.qualityQuality')}</option>
                <option value="nearlossless">{t('videoExport.qualityNearLossless')}</option>
                <option value="archive">{t('videoExport.qualityArchive')}</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('videoExport.renderBackend')}
            </label>
            <select
              aria-label={t('videoExport.renderBackend')}
              value={renderBackend}
              disabled={exporting}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                setRenderBackend(event.target.value as RenderBackend)
              }
              className={SELECT_CLASS}
            >
              {(
                [
                  ['auto', t('videoExport.backendAuto')],
                  ['metal', t('videoExport.backendMetal')],
                  ['vulkan', t('videoExport.backendVulkan')],
                  ['cuda', t('videoExport.backendCuda')],
                  ['dx12', t('videoExport.backendDx12')],
                  ['gl', t('videoExport.backendGl')],
                  ['cpu', t('videoExport.backendCpu')]
                ] as readonly [RenderBackend, string][]
              ).map(([backendKey, label]: readonly [RenderBackend, string]): JSX.Element => {
                const detected: GpuBackendInfo | undefined = availableBackends.find(
                  (item: GpuBackendInfo): boolean => item.backend === backendKey
                )
                const optionText: string =
                  detected && backendKey !== 'auto' ? `${label} (${detected.adapterName})` : label
                return (
                  <option key={backendKey} value={backendKey}>
                    {optionText}
                  </option>
                )
              })}
            </select>
          </div>

          {fpsPreset === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('videoExport.customFps')}
              </label>
              <Input
                type="number"
                min={MIN_EXPORT_FPS}
                max={MAX_EXPORT_FPS}
                step={1}
                disabled={exporting}
                aria-label={t('videoExport.customFps')}
                value={customFpsText}
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  setCustomFpsText(event.target.value)
                }
              />
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={(): void => setShowAdvanced((prev: boolean): boolean => !prev)}
            >
              <SlidersHorizontal className="mr-1.5 size-3.5" />
              <span>{t('videoExport.advancedOptions')}</span>
              {showAdvanced ? (
                <ChevronUp className="ml-1 size-3.5" />
              ) : (
                <ChevronDown className="ml-1 size-3.5" />
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={exporting}
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={resetDefaults}
            >
              <RotateCcw className="mr-1 size-3.5" />
              <span>{t('videoExport.resetDefaults')}</span>
            </Button>
          </div>

          {showAdvanced && (
            <div className="space-y-3 rounded-md border bg-muted/25 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.videoRateControl')}
                  </label>
                  <select
                    aria-label={t('videoExport.videoRateControl')}
                    value={rateMode}
                    disabled={exporting}
                    onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                      setRateMode(event.target.value as VideoRateControlMode)
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="preset">{t('videoExport.rateModePreset')}</option>
                    <option value="cqp">{t('videoExport.rateModeCqp')}</option>
                    <option value="abr">{t('videoExport.rateModeAbr')}</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.keyframeInterval')}
                  </label>
                  <select
                    aria-label={t('videoExport.keyframeInterval')}
                    value={gopMode}
                    disabled={exporting}
                    onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                      setGopMode(event.target.value as 'auto' | 'custom')
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="auto">{t('videoExport.gopAuto')}</option>
                    <option value="custom">{t('videoExport.gopCustom')}</option>
                  </select>
                </div>
              </div>

              {rateMode === 'cqp' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.videoQp')}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={MAX_VIDEO_QP}
                    step={1}
                    disabled={exporting}
                    aria-label={t('videoExport.videoQp')}
                    value={videoQpText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setVideoQpText(event.target.value)
                    }
                  />
                </div>
              )}

              {rateMode === 'abr' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.videoBitrateKbps')}
                  </label>
                  <Input
                    type="number"
                    min={MIN_VIDEO_BITRATE_KBPS}
                    max={MAX_VIDEO_BITRATE_KBPS}
                    step={100}
                    disabled={exporting}
                    aria-label={t('videoExport.videoBitrateKbps')}
                    value={videoBitrateText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setVideoBitrateText(event.target.value)
                    }
                  />
                </div>
              )}

              {gopMode === 'custom' && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.gopFrames')}
                  </label>
                  <Input
                    type="number"
                    min={MIN_GOP_FRAMES}
                    max={MAX_GOP_FRAMES}
                    step={1}
                    disabled={exporting}
                    aria-label={t('videoExport.gopFrames')}
                    value={gopFramesText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setGopFramesText(event.target.value)
                    }
                  />
                </div>
              )}

              <div className="space-y-1 border-t pt-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.hybridHardwareEncoder')}
                  </span>
                  <Switch
                    checked={hybridHardwareEncoder}
                    disabled={exporting}
                    aria-label={t('videoExport.hybridHardwareEncoder')}
                    onCheckedChange={setHybridHardwareEncoder}
                  />
                </div>
                <p className="text-[11px] leading-tight text-muted-foreground/70">
                  {t('videoExport.hybridHardwareEncoderHint')}
                </p>
              </div>

              <div className="flex items-center justify-between border-t pt-2.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('videoExport.includeAudio')}
                </span>
                <Switch
                  checked={includeAudio}
                  disabled={exporting}
                  aria-label={t('videoExport.includeAudio')}
                  onCheckedChange={setIncludeAudio}
                />
              </div>

              {includeAudio && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('videoExport.audioBitrate')}
                    </label>
                    <select
                      aria-label={t('videoExport.audioBitrate')}
                      value={audioBitrateOption}
                      disabled={exporting}
                      onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                        setAudioBitrateOption(event.target.value)
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="auto">{t('videoExport.audioBitrateAuto')}</option>
                      {AUDIO_BITRATE_OPTIONS.map(
                        (kbps: number): JSX.Element => (
                          <option key={kbps} value={String(kbps)}>
                            {t('videoExport.audioBitrateUnit', { kbps })}
                          </option>
                        )
                      )}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('videoExport.audioVolume')}
                    </label>
                    <Input
                      type="number"
                      min={0}
                      max={MAX_AUDIO_VOLUME_PERCENT}
                      step={5}
                      disabled={exporting}
                      aria-label={t('videoExport.audioVolume')}
                      value={audioVolumeText}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        setAudioVolumeText(event.target.value)
                      }
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 border-t pt-2.5">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.trailingHoldMs')}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={MAX_TRAILING_HOLD_MS}
                    step={100}
                    disabled={exporting}
                    aria-label={t('videoExport.trailingHoldMs')}
                    value={trailingHoldText}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setTrailingHoldText(event.target.value)
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.backgroundColor')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('videoExport.backgroundColor')}
                      disabled={exporting}
                      value={swatchColor}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        setBackgroundColor(event.target.value)
                      }
                      className="border-input bg-background h-9 w-10 shrink-0 cursor-pointer rounded-md border p-1 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <Input
                      type="text"
                      disabled={exporting}
                      aria-label={t('videoExport.backgroundColor')}
                      value={backgroundColor}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        setBackgroundColor(event.target.value)
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('videoExport.seedMode')}
                  </label>
                  <select
                    aria-label={t('videoExport.seedMode')}
                    value={seedModeKind}
                    disabled={exporting}
                    onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                      setSeedModeKind(event.target.value as 'fixed' | 'random')
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="fixed">{t('videoExport.seedFixed')}</option>
                    <option value="random">{t('videoExport.seedRandom')}</option>
                  </select>
                </div>

                {seedModeKind === 'fixed' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('videoExport.seedValue')}
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        disabled={exporting}
                        aria-label={t('videoExport.seedValue')}
                        value={seedText}
                        onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                          setSeedText(event.target.value)
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={exporting}
                        aria-label={t('videoExport.randomizeSeed')}
                        title={t('videoExport.randomizeSeed')}
                        onClick={(): void => setSeedText(String(generateRandomExportSeed()))}
                      >
                        <Shuffle className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {validationError && <p className="text-xs text-destructive">{validationError}</p>}

          {statusMessage && (
            <p
              className={statusError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {statusMessage}
            </p>
          )}

          {exporting && progress && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  <span>{t(stageLabelKey(progress.stage))}</span>
                </span>
                <span className="tabular-nums text-muted-foreground">{progressPercent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                <span>
                  {t('videoExport.frameProgress', {
                    current: progress.renderedFrames,
                    total: progress.estimatedTotalFrames
                  })}
                </span>
                <span>
                  {t('videoExport.metricsSummary', {
                    fps: progress.fpsActual.toFixed(1),
                    eta: formatEta(progress)
                  })}
                </span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {exporting ? (
            <Button
              type="button"
              variant="destructive"
              disabled={cancelling}
              onClick={(): void => void handleCancelExport()}
            >
              {cancelling ? t('videoExport.cancelling') : t('videoExport.cancelExport')}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={(): void => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={!projectName || Boolean(validationError)}
                onClick={(): void => void handleStartExport()}
              >
                {t('videoExport.startExport')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
