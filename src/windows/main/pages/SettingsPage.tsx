import type { ChangeEvent, JSX } from 'react'
import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { useSettings } from '@/settings/useSettings'
import type { PlaybackFontSettings } from '@/settings/types'
import {
  DEFAULT_PLAYBACK_FONT_FAMILY,
  defaultPlaybackFont,
  type DataFontInfo
} from '@/settings/fonts'
import { SettingRow } from '@/windows/main/components/SettingRow'
import { getDataFonts } from '@/workspace/api'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'

export default function SettingsPage(): JSX.Element {
  const {
    appearance,
    playback,
    workspaceDir,
    setFollowSystem,
    setManualTheme,
    setMemorySizeMb,
    setRenderPrecision,
    setPlaybackFont,
    setWorkspaceDir
  } = useSettings()
  const [renderPrecisionText, setRenderPrecisionText] = useState<string>(() =>
    renderPrecisionToText(playback.renderPrecision)
  )
  const [dataFonts, setDataFonts] = useState<DataFontInfo[]>([])

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

  const fontValue: string = playbackFontToSelectValue(playback.font)
  const missingDataFont: Extract<PlaybackFontSettings, { source: 'data' }> | null =
    getMissingDataFont(playback.font, dataFonts)

  return (
    <div className="flex flex-col h-screen overflow-y-auto overscroll-none px-8 py-8 select-none scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent">
      <div className="w-full max-w-2xl space-y-1 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">数据存储</h2>
        <p className="text-sm text-muted-foreground">管理项目数据的保存位置。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title="数据保存路径" description={workspaceDir ?? '未设置'}>
          <Button variant="outline" size="sm" onClick={handleChangeWorkspace}>
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            修改
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
    </div>
  )
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
