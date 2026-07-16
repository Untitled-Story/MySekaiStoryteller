import type { ChangeEvent, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { useSettings } from '@/settings/useSettings'
import type { PlaybackFontSettings, ShortcutBinding, ShortcutSettings } from '@/settings/types'
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

export default function SettingsPage(): JSX.Element {
  const {
    appearance,
    playback,
    shortcuts,
    workspaceDir,
    setFollowSystem,
    setManualTheme,
    setMemorySizeMb,
    setRenderPrecision,
    setPlaybackFont,
    setShortcuts,
    setWorkspaceDir
  } = useSettings()
  const [renderPrecisionText, setRenderPrecisionText] = useState<string>(() =>
    renderPrecisionToText(playback.renderPrecision)
  )
  const [dataFonts, setDataFonts] = useState<DataFontInfo[]>([])
  const [logPath, setLogPath] = useState<string>('系统应用日志目录')
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
      title: '选择数据保存路径',
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
        setShortcutConflict({ id, message: `与“${conflict.title}”的快捷键冲突` })
        return false
      }

      setShortcutConflict(null)
      setShortcuts(updateShortcutBinding(shortcuts, id, binding))
      return true
    },
    [setShortcuts, shortcuts]
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
    <div className="flex flex-col h-screen overflow-y-auto overscroll-none px-8 py-8 select-none scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent">
      <div className="w-full max-w-2xl space-y-1 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">数据存储</h2>
        <p className="text-sm text-muted-foreground">管理项目数据与运行日志的保存位置。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title="数据保存路径" description={workspaceDir ?? '未设置'}>
          <Button variant="outline" size="sm" onClick={handleChangeWorkspace}>
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            修改
          </Button>
        </SettingRow>
        <SettingRow title="运行日志" description={logPath}>
          <Button variant="outline" size="sm" onClick={handleOpenLogDirectory}>
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            打开
          </Button>
        </SettingRow>
      </div>

      <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">外观主题</h2>
        <p className="text-sm text-muted-foreground">选择应用的外观主题。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title="深色模式" description="在跟随系统关闭时，手动切换深色或浅色。">
          <Switch
            checked={appearance.manualTheme === 'dark'}
            disabled={appearance.followSystem}
            aria-label="切换深色模式"
            onCheckedChange={(checked) => setManualTheme(checked ? 'dark' : 'light')}
          />
        </SettingRow>

        <SettingRow title="跟随系统" description="打开后将自动根据系统外观切换深色模式。">
          <Switch
            checked={appearance.followSystem}
            aria-label="切换是否跟随系统"
            onCheckedChange={setFollowSystem}
          />
        </SettingRow>
      </div>

      <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">播放设定</h2>
        <p className="text-sm text-muted-foreground">调整放映内存与渲染精度以获得更稳定的表现。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow
          title="内存大小 (MB)"
          description="放映时使用的内存大小，越大支持的模型数越多，也会越流畅。最小 64 MB。"
        >
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
          title="渲染精度"
          description="放映时的分辨率，数值越大越清晰，资源消耗越大。推荐 0.5 ~ 2.0。"
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

        <SettingRow
          title="字体"
          description="放映文本使用的字体。自定义字体放在数据路径的 fonts 目录下。"
        >
          <select
            value={fontValue}
            onChange={handleFontChange}
            className="border-input bg-background h-9 w-56 rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <optgroup label="默认字体">
              <option value="default">默认字体 ({DEFAULT_PLAYBACK_FONT_FAMILY})</option>
            </optgroup>
            <optgroup label="数据路径 / fonts">
              {missingDataFont ? (
                <option value={playbackFontToSelectValue(missingDataFont)}>
                  {missingDataFont.family} (未找到)
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

      <div className="w-full max-w-2xl space-y-1 mt-8 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">快捷键</h2>
        <p className="text-sm text-muted-foreground">自定义编辑器与播放器的键盘操作。</p>
      </div>

      <ShortcutGroup
        title="编辑器"
        commands={EDITOR_SHORTCUT_COMMANDS}
        shortcuts={shortcuts}
        conflict={shortcutConflict}
        recordingShortcutId={recordingShortcutId}
        onRecordingShortcutIdChange={handleRecordingShortcutIdChange}
        onReset={handleShortcutReset}
      />
      <ShortcutGroup
        title="播放器"
        commands={PLAYER_SHORTCUT_COMMANDS}
        shortcuts={shortcuts}
        conflict={shortcutConflict}
        recordingShortcutId={recordingShortcutId}
        onRecordingShortcutIdChange={handleRecordingShortcutIdChange}
        onReset={handleShortcutReset}
      />
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
  title: string
  description: string
}

type ShortcutConflict = {
  id: ShortcutCommandId
  message: string
}

const EDITOR_SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  {
    id: 'editor.save',
    scope: 'editor',
    title: '保存项目',
    description: '立即保存当前项目'
  }
]

const PLAYER_SHORTCUT_COMMANDS: readonly ShortcutCommandDefinition[] = [
  {
    id: 'player.reload',
    scope: 'player',
    title: '重新播放',
    description: '重新读取已保存项目并从头播放'
  },
  {
    id: 'player.enterFullscreen',
    scope: 'player',
    title: '进入全屏',
    description: '进入全屏放映'
  },
  {
    id: 'player.exitFullscreen',
    scope: 'player',
    title: '退出全屏',
    description: '返回窗口模式'
  },
  {
    id: 'player.close',
    scope: 'player',
    title: '关闭播放器',
    description: '关闭当前播放器窗口'
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
            <SettingRow key={command.id} title={command.title} description={command.description}>
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
            <span className="text-xs text-muted-foreground">录入中…</span>
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
          aria-label="恢复默认快捷键"
          title="恢复默认快捷键"
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
