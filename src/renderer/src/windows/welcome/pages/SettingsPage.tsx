import type { JSX, ReactNode } from 'react'
import { Input } from '@renderer/components/ui/Input'
import { Switch } from '@renderer/components/ui/Switch'
import { useSettings } from '@renderer/hooks/useSettings'

export default function SettingsPage(): JSX.Element {
  const {
    appearance,
    playback,
    setFollowSystem,
    setManualTheme,
    setMemorySizeMb,
    setRenderPrecision
  } = useSettings()

  return (
    <div className="flex flex-col h-screen overflow-y-auto px-8 py-8 select-none scrollbar-thin scrollbar-thumb-gray-400 dark:scrollbar-thumb-[#2C2C2C] scrollbar-track-transparent">
      <div className="w-full max-w-2xl space-y-1 mb-2">
        <h2 className="text-2xl font-semibold leading-tight">外观主题</h2>
        <p className="text-sm text-muted-foreground">选择应用的外观主题。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow title="深浅模式" description="在跟随系统关闭时，手动切换深色或浅色。">
          <Switch
            checked={appearance.manualTheme === 'dark'}
            disabled={appearance.followSystem}
            aria-label="切换深浅模式"
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

      <div className="w-full max-w-2xl space-y-1 mt-5 mb-6">
        <h2 className="text-2xl font-semibold leading-tight">播放设定</h2>
        <p className="text-sm text-muted-foreground">调整放映内存与渲染精度以获得更稳定的表现。</p>
      </div>

      <div className="w-full max-w-2xl divide-y divide-border">
        <SettingRow
          title="内存大小 (MB)"
          description="放映时使用的内存大小，越大支持的模型数越多，也会越流畅。"
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

        <SettingRow title="渲染精度" description="放映时的分辨率，数值越大越清晰，资源消耗越大。">
          <Input
            type="number"
            step={0.1}
            value={playback.renderPrecision.toString()}
            onChange={(event) => {
              const nextValue = Number(event.target.value)
              if (!Number.isNaN(nextValue)) {
                setRenderPrecision(nextValue)
              }
            }}
            className="w-36"
          />
        </SettingRow>
      </div>
    </div>
  )
}

function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-5 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="md:pl-6">{children}</div>
    </div>
  )
}
