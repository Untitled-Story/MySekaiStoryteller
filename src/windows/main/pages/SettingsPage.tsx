import type { ChangeEvent, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { useSettings } from '@/settings/useSettings'
import type {
  AppLanguage,
  PlaybackFontSettings,
  ShortcutBinding,
  ShortcutSettings
} from '@/settings/types'
import {
  DEFAULT_PLAYBACK_FONT_FAMILY,
  defaultPlaybackFont,
  type DataFontInfo
} from '@/settings/fonts'
import {
  DEFAULT_SHORTCUTS,
  shortcutBindingFromEvent,
  shortcutBindingLabels,
  shortcutBindingsConflict,
  shortcutBindingsEqual
} from '@/settings/shortcuts'
import { SettingRow } from '@/windows/main/components/SettingRow'
import { getDataFonts, getLogPath } from '@/workspace/api'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { FolderOpen, RotateCcw } from 'lucide-react'
import { describeError, logger } from '@/lib/logger'
import { getRuntimePlatform, isMobileRuntime } from '@/lib/platform'
import { EDITOR_TOUR_VERSION, MAIN_TOUR_VERSION } from '@/onboarding/types'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/style'

export default function SettingsPage(): JSX.Element {
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()
  const androidRuntime: boolean = getRuntimePlatform() === 'android'
  const {
    language,
    appearance,
    playback,
    shortcuts,
    onboarding,
    interaction,
    workspaceDir,
    setLanguage,
    setFollowSystem,
    setManualTheme,
    setMemorySizeMb,
    setRenderPrecision,
    setPlaybackFont,
    setShortcuts,
    setOnboarding,
    setTouchMode,
    setWorkspaceDir
  } = useSettings()
  const navigate = useNavigate()
  const [renderPrecisionText, setRenderPrecisionText] = useState<string>(() =>
    renderPrecisionToText(playback.renderPrecision)
  )
  const [dataFonts, setDataFonts] = useState<DataFontInfo[]>([])
  const [logPath, setLogPath] = useState<string>(() => t('settings.logDefault'))
  const [shortcutConflict, setShortcutConflict] = useState<ShortcutConflict | null>(null)
  const [recordingShortcutId, setRecordingShortcutId] = useState<ShortcutCommandId | null>(null)

  useEffect(() => {
    setRenderPrecisionText(renderPrecisionToText(playback.renderPrecision))
  }, [playback.renderPrecision])

  useEffect(() => {
    let cancelled: boolean = false

    if (!workspaceDir) {
      setDataFonts([])
      return
    }

    getDataFonts()
      .then((fonts: DataFontInfo[]): void => {
        if (cancelled) return
        setDataFonts(fonts)
      })
      .catch((): void => {
        if (cancelled) return
        setDataFonts([])
      })

    return (): void => {
      cancelled = true
    }
  }, [workspaceDir])

  useEffect((): void => {
    void getLogPath()
      .then((path: string): void => setLogPath(path))
      .catch((error: unknown): void => {
        logger.warn('settings.log_path_failed', { error: describeError(error) })
      })
  }, [])

  const handleChangeWorkspace = async (): Promise<void> => {
    const selected: string | string[] | null = await open({
      title: t('workspace.choose'),
      directory: true,
      multiple: false
    })

    if (typeof selected === 'string') {
      setWorkspaceDir(selected)
    }
  }

  const handleFontChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setPlaybackFont(selectValueToPlaybackFont(event.target.value, dataFonts, playback.font))
  }

  const handleOpenLogDirectory = async (): Promise<void> => {
    try {
      const path: string = await getLogPath()
      await revealItemInDir(path)
      logger.info('settings.log_directory_opened')
    } catch (error: unknown) {
      logger.error('settings.log_directory_open_failed', { error: describeError(error) })
    }
  }

  const handleRestartMainTour = (): void => {
    setOnboarding({ ...onboarding, mainTourVersion: 0 })
    navigate('/')
  }

  const handleRestartEditorTour = (): void => {
    setOnboarding({ ...onboarding, editorTourVersion: 0 })
  }

  const fontValue: string = playbackFontToSelectValue(playback.font)
  const missingDataFont: Extract<PlaybackFontSettings, { source: 'data' }> | null =
    getMissingDataFont(playback.font, dataFonts)

  const handleShortcutChange = useCallback(
    (id: ShortcutCommandId, binding: ShortcutBinding): boolean => {
      const conflict: ShortcutCommandDefinition | undefined = SHORTCUT_COMMANDS.find(
        (command: ShortcutCommandDefinition): boolean =>
          command.scope === shortcutScope(id) &&
          command.id !== id &&
          shortcutBindingsConflict(getShortcutBinding(shortcuts, command.id), binding)
      )

      if (conflict) {
        setShortcutConflict({
          id,
          message: t('settings.conflict', { title: t(conflict.titleKey) })
        })
        return false
      }

      setShortcutConflict(null)
      setShortcuts(updateShortcutBinding(shortcuts, id, binding))
      return true
    },
    [setShortcuts, shortcuts, t]
  )

  function handleShortcutReset(id: ShortcutCommandId): void {
    setRecordingShortcutId(null)
    handleShortcutChange(id, getShortcutBinding(DEFAULT_SHORTCUTS, id))
  }

  function handleRecordingShortcutIdChange(id: ShortcutCommandId | null): void {
    setShortcutConflict(null)
    setRecordingShortcutId(id)
  }

  useEffect((): (() => void) | undefined => {
    const activeShortcutId: ShortcutCommandId | null = recordingShortcutId
    if (!activeShortcutId) return undefined
    const capturedShortcutId: ShortcutCommandId = activeShortcutId

    function captureShortcut(event: KeyboardEvent): void {
      event.preventDefault()
      event.stopImmediatePropagation()

      const binding: ShortcutBinding | null = shortcutBindingFromEvent(event)
      if (!binding) return
      if (handleShortcutChange(capturedShortcutId, binding)) {
        setRecordingShortcutId(null)
      }
    }

    window.addEventListener('keydown', captureShortcut, true)
    return (): void => window.removeEventListener('keydown', captureShortcut, true)
  }, [handleShortcutChange, recordingShortcutId])

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-y-auto overscroll-none px-5 py-6 pb-8 select-none scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent sm:px-8 sm:py-8',
        mobileRuntime && 'mobile-page-scrollbar'
      )}
    >
      {!androidRuntime ? (
        <>
          <div className="mb-2 w-full max-w-2xl space-y-1">
            <h2 className="text-2xl font-semibold leading-tight">{t('settings.storage')}</h2>
            <p className="text-sm text-muted-foreground">{t('settings.storageDescription')}</p>
          </div>

          <div className="w-full max-w-2xl divide-y divide-border">
            <SettingRow
              title={t('settings.workspace')}
              description={workspaceDir ?? t('common.missing')}
            >
              <Button variant="outline" size="sm" onClick={handleChangeWorkspace}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('common.change')}
              </Button>
            </SettingRow>
            <SettingRow title={t('settings.logs')} description={logPath}>
              <Button variant="outline" size="sm" onClick={handleOpenLogDirectory}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('common.open')}
              </Button>
            </SettingRow>
          </div>
        </>
      ) : null}

      <div className="mt-8 mb-2 w-full max-w-2xl space-y-1">
        <h2 className="text-2xl leading-tight font-semibold">{t('settings.interaction')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.interactionDescription')}</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow
          title={t('settings.touchMode')}
          description={t('settings.touchModeDescription')}
        >
          <Switch
            checked={interaction.touchMode}
            aria-label={t('settings.touchModeAria')}
            onCheckedChange={setTouchMode}
          />
        </SettingRow>
      </div>

      <div className="mt-8 mb-2 w-full max-w-2xl space-y-1">
        <h2 className="text-2xl font-semibold leading-tight">{t('settings.appearance')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.appearanceDescription')}</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title={t('language.label')} description={t('language.description')}>
          <select
            value={language}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              setLanguage(event.target.value as AppLanguage)
            }
            className="border-input bg-background h-9 w-44 rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <option value="system">{t('language.system')}</option>
            <option value="zh-CN">{t('language.zhCN')}</option>
            <option value="zh-HK">{t('language.zhHK')}</option>
            <option value="en">{t('language.en')}</option>
            <option value="ja">{t('language.ja')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('settings.darkMode')} description={t('settings.darkModeDescription')}>
          <Switch
            checked={appearance.manualTheme === 'dark'}
            disabled={appearance.followSystem}
            aria-label={t('settings.darkModeAria')}
            onCheckedChange={(checked) => setManualTheme(checked ? 'dark' : 'light')}
          />
        </SettingRow>

        <SettingRow
          title={t('settings.followSystem')}
          description={t('settings.followSystemDescription')}
        >
          <Switch
            checked={appearance.followSystem}
            aria-label={t('settings.followSystemAria')}
            onCheckedChange={setFollowSystem}
          />
        </SettingRow>
      </div>

      <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">{t('settings.playback')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.playbackDescription')}</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title={t('settings.memory')} description={t('settings.memoryDescription')}>
          <Input
            type="number"
            min={64}
            step={16}
            value={playback.memorySizeMb.toString()}
            onChange={(event) => {
              const nextValue = Number(event.target.value)
              if (!Number.isNaN(nextValue)) {
                setMemorySizeMb(nextValue)
              }
            }}
            className="w-36"
          />
        </SettingRow>

        <SettingRow
          title={t('settings.precision')}
          description={t('settings.precisionDescription')}
        >
          <Input
            type="text"
            inputMode="decimal"
            placeholder="Auto"
            value={renderPrecisionText}
            onChange={(event) => {
              const nextText = event.target.value.trim()
              setRenderPrecisionText(nextText)

              if (!nextText) {
                setRenderPrecision('Auto')
                return
              }

              const nextValue = Number(nextText)
              if (Number.isFinite(nextValue) && nextValue > 0) {
                setRenderPrecision(nextValue)
              }
            }}
            className="w-36"
          />
        </SettingRow>

        <SettingRow title={t('settings.font')} description={t('settings.fontDescription')}>
          <select
            value={fontValue}
            onChange={handleFontChange}
            className="border-input bg-background h-9 w-56 rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <optgroup label={t('settings.defaultFont')}>
              <option value="default">
                {t('settings.defaultFont')} ({DEFAULT_PLAYBACK_FONT_FAMILY})
              </option>
            </optgroup>
            <optgroup label={t('settings.dataFonts')}>
              {missingDataFont ? (
                <option value={playbackFontToSelectValue(missingDataFont)}>
                  {t('settings.fontMissing', { family: missingDataFont.family })}
                </option>
              ) : null}
              {dataFonts.map(
                (font: DataFontInfo): JSX.Element => (
                  <option key={font.path} value={dataFontToSelectValue(font)}>
                    {font.family}
                  </option>
                )
              )}
            </optgroup>
          </select>
        </SettingRow>
      </div>

      {!mobileRuntime ? (
        <>
          <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
            <h2 className="text-2xl font-semibold leading-tight">{t('settings.shortcuts')}</h2>
            <p className="text-sm text-muted-foreground">{t('settings.shortcutsDescription')}</p>
          </div>

          <ShortcutGroup
            title={t('settings.editor')}
            commands={EDITOR_SHORTCUT_COMMANDS}
            shortcuts={shortcuts}
            conflict={shortcutConflict}
            recordingShortcutId={recordingShortcutId}
            onRecordingShortcutIdChange={handleRecordingShortcutIdChange}
            onReset={handleShortcutReset}
          />
          <ShortcutGroup
            title={t('settings.player')}
            commands={PLAYER_SHORTCUT_COMMANDS}
            shortcuts={shortcuts}
            conflict={shortcutConflict}
            recordingShortcutId={recordingShortcutId}
            onRecordingShortcutIdChange={handleRecordingShortcutIdChange}
            onReset={handleShortcutReset}
          />
        </>
      ) : null}

      <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">{t('settings.onboarding')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.onboardingDescription')}</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border pb-4">
        <SettingRow
          title={t('settings.mainTour')}
          description={
            onboarding.mainTourVersion >= MAIN_TOUR_VERSION
              ? t('settings.completed')
              : t('settings.mainTourPending')
          }
        >
          <Button variant="outline" size="sm" onClick={handleRestartMainTour}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            {t('settings.restart')}
          </Button>
        </SettingRow>
        <SettingRow
          title={t('settings.editorTour')}
          description={
            onboarding.editorTourVersion >= EDITOR_TOUR_VERSION
              ? t('settings.editorTourComplete')
              : t('settings.editorTourPending')
          }
        >
          <Button variant="outline" size="sm" onClick={handleRestartEditorTour}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            {t('settings.restart')}
          </Button>
        </SettingRow>
      </div>
    </div>
  )
}

type ShortcutCommandId =
  | 'editor.save'
  | 'player.reload'
  | 'player.enterFullscreen'
  | 'player.exitFullscreen'
  | 'player.close'

type ShortcutCommandDefinition = {
  id: ShortcutCommandId
  scope: 'editor' | 'player'
  titleKey: string
  descriptionKey: string
}

type ShortcutConflict = {
  id: ShortcutCommandId
  message: string
}

const EDITOR_SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  {
    id: 'editor.save',
    scope: 'editor',
    titleKey: 'settings.saveProject',
    descriptionKey: 'settings.saveProjectDescription'
  }
]

const PLAYER_SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  {
    id: 'player.reload',
    scope: 'player',
    titleKey: 'settings.reloadPlayer',
    descriptionKey: 'settings.reloadPlayerDescription'
  },
  {
    id: 'player.enterFullscreen',
    scope: 'player',
    titleKey: 'settings.enterFullscreen',
    descriptionKey: 'settings.enterFullscreenDescription'
  },
  {
    id: 'player.exitFullscreen',
    scope: 'player',
    titleKey: 'settings.exitFullscreen',
    descriptionKey: 'settings.exitFullscreenDescription'
  },
  {
    id: 'player.close',
    scope: 'player',
    titleKey: 'settings.closePlayer',
    descriptionKey: 'settings.closePlayerDescription'
  }
]

const SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  ...EDITOR_SHORTCUT_COMMANDS,
  ...PLAYER_SHORTCUT_COMMANDS
]

function ShortcutGroup({
  title,
  commands,
  shortcuts,
  conflict,
  recordingShortcutId,
  onRecordingShortcutIdChange,
  onReset
}: {
  title: string
  commands: readonly ShortcutCommandDefinition[]
  shortcuts: ShortcutSettings
  conflict: ShortcutConflict | null
  recordingShortcutId: ShortcutCommandId | null
  onRecordingShortcutIdChange: (id: ShortcutCommandId | null) => void
  onReset: (id: ShortcutCommandId) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mt-2 w-full max-w-2xl [&+&]:mt-5">
      <div className="border-b border-border pb-2 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        {title}
      </div>
      <div className="divide-y divide-border">
        {commands.map((command: ShortcutCommandDefinition): JSX.Element => {
          const binding: ShortcutBinding = getShortcutBinding(shortcuts, command.id)
          const defaultBinding: ShortcutBinding = getShortcutBinding(DEFAULT_SHORTCUTS, command.id)
          return (
            <SettingRow
              key={command.id}
              title={t(command.titleKey)}
              description={t(command.descriptionKey)}
            >
              <ShortcutBindingEditor
                binding={binding}
                isDefault={shortcutBindingsEqual(binding, defaultBinding)}
                error={conflict?.id === command.id ? conflict.message : null}
                recording={recordingShortcutId === command.id}
                onRecordingChange={(recording: boolean): void =>
                  onRecordingShortcutIdChange(recording ? command.id : null)
                }
                onReset={(): void => onReset(command.id)}
              />
            </SettingRow>
          )
        })}
      </div>
    </div>
  )
}

function ShortcutBindingEditor({
  binding,
  isDefault,
  error,
  recording,
  onRecordingChange,
  onReset
}: {
  binding: ShortcutBinding
  isDefault: boolean
  error: string | null
  recording: boolean
  onRecordingChange: (recording: boolean) => void
  onReset: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant={recording ? 'secondary' : 'outline'}
          size="sm"
          className="min-w-30 justify-center px-2.5"
          aria-pressed={recording}
          onClick={(): void => onRecordingChange(!recording)}
        >
          {recording ? (
            <span className="text-xs text-muted-foreground">{t('settings.recording')}</span>
          ) : (
            <ShortcutKeys binding={binding} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={isDefault}
          aria-label={t('settings.resetShortcut')}
          title={t('settings.resetShortcut')}
          onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault()}
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function ShortcutKeys({ binding }: { binding: ShortcutBinding }): JSX.Element {
  return (
    <span
      className="flex items-center gap-1"
      aria-label={shortcutBindingLabels(binding).join(' + ')}
    >
      {shortcutBindingLabels(binding).map(
        (key: string): JSX.Element => (
          <kbd
            key={key}
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted/55 px-1 font-mono text-[10px] font-medium text-foreground shadow-[0_1px_0_0_var(--border)]"
          >
            {key}
          </kbd>
        )
      )}
    </span>
  )
}

function shortcutScope(id: ShortcutCommandId): 'editor' | 'player' {
  return id.startsWith('editor.') ? 'editor' : 'player'
}

function getShortcutBinding(settings: ShortcutSettings, id: ShortcutCommandId): ShortcutBinding {
  switch (id) {
    case 'editor.save':
      return settings.editor.save
    case 'player.reload':
      return settings.player.reload
    case 'player.enterFullscreen':
      return settings.player.enterFullscreen
    case 'player.exitFullscreen':
      return settings.player.exitFullscreen
    case 'player.close':
      return settings.player.close
  }
}

function updateShortcutBinding(
  settings: ShortcutSettings,
  id: ShortcutCommandId,
  binding: ShortcutBinding
): ShortcutSettings {
  switch (id) {
    case 'editor.save':
      return { ...settings, editor: { ...settings.editor, save: binding } }
    case 'player.reload':
      return { ...settings, player: { ...settings.player, reload: binding } }
    case 'player.enterFullscreen':
      return { ...settings, player: { ...settings.player, enterFullscreen: binding } }
    case 'player.exitFullscreen':
      return { ...settings, player: { ...settings.player, exitFullscreen: binding } }
    case 'player.close':
      return { ...settings, player: { ...settings.player, close: binding } }
  }
}

function renderPrecisionToText(value: number | 'Auto'): string {
  return value === 'Auto' ? '' : value.toString()
}

function getMissingDataFont(
  font: PlaybackFontSettings,
  dataFonts: readonly DataFontInfo[]
): Extract<PlaybackFontSettings, { source: 'data' }> | null {
  if (font.source !== 'data') return null

  const exists: boolean = dataFonts.some(
    (candidate: DataFontInfo): boolean => candidate.path === font.path
  )
  return exists ? null : font
}

function playbackFontToSelectValue(font: PlaybackFontSettings): string {
  if (font.source === 'data') return dataPathToSelectValue(font.path)
  return 'default'
}

function selectValueToPlaybackFont(
  value: string,
  dataFonts: readonly DataFontInfo[],
  currentFont: PlaybackFontSettings
): PlaybackFontSettings {
  if (value === 'default') return defaultPlaybackFont()

  if (value.startsWith('data:')) {
    const path: string = decodeURIComponent(value.slice('data:'.length))
    const font: DataFontInfo | undefined = dataFonts.find(
      (candidate: DataFontInfo): boolean => candidate.path === path
    )

    if (font) {
      return {
        source: 'data',
        family: font.family,
        path: font.path
      }
    }

    if (currentFont.source === 'data' && currentFont.path === path) return currentFont
    return defaultPlaybackFont()
  }

  return defaultPlaybackFont()
}

function dataFontToSelectValue(font: DataFontInfo): string {
  return dataPathToSelectValue(font.path)
}

function dataPathToSelectValue(path: string): string {
  return `data:${encodeURIComponent(path)}`
}
