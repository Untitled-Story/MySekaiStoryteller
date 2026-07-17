import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { Plus, Edit3, Play, Clock, Folder, Settings } from 'lucide-react'
import { CreateProjectDialog } from '@/windows/main/components/CreateProjectDialog'
import { useProjectsMetadata } from '@/windows/main/hooks/useProjectsMetadata'
import type { ProjectMetadata } from '@/project/metadata'
import { timeAgo } from '@/windows/main/utils/time'
import { useNavigate } from 'react-router'
import { openEditorWindow, openPlayerWindow } from '@/windows/api'
import { useSettings } from '@/settings/useSettings'
import { MAIN_TOUR_VERSION } from '@/onboarding/types'
import { MainProductTour } from '@/onboarding/MainProductTour'
import { useTranslation } from 'react-i18next'
import { useViewportMode } from '@/hooks/useViewportMode'
import { cn } from '@/lib/style'
import { detectPreferTouchMode } from '@/lib/touchMode'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'


export default function HomePage(): JSX.Element {
  const { t } = useTranslation()
  const { projects, fetchProjects } = useProjectsMetadata()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [touchPromptOpen, setTouchPromptOpen] = useState(false)
  const [touchPromptValue, setTouchPromptValue] = useState(false)
  const navigate = useNavigate()
  const { onboarding, interaction, setOnboarding, setInteraction } = useSettings()
  const viewportMode = useViewportMode()
  const stackSections: boolean = viewportMode === 'phone'

  const completeMainTour = useCallback((): void => {
    setOnboarding({ ...onboarding, mainTourVersion: MAIN_TOUR_VERSION })
    if (!interaction.touchModePromptSeen) {
      setTouchPromptValue(detectPreferTouchMode())
      setTouchPromptOpen(true)
    }
  }, [interaction.touchModePromptSeen, onboarding, setOnboarding])

  const finishTouchPrompt = useCallback(
    (enabled: boolean): void => {
      setInteraction({
        touchMode: enabled,
        touchModePromptSeen: true
      })
      setTouchPromptOpen(false)
    },
    [setInteraction]
  )

  const latest: ProjectMetadata | null =
    projects.length > 0 ? [...projects].sort((a, b) => b.lastModified - a.lastModified)[0] : null

  const handleOpenEditor = async (title: string): Promise<void> => {
    try {
      await openEditorWindow(title)
    } catch (error) {
      alert(
        t('project.openEditorFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    }
  }

  const handleOpenPlayer = async (title: string): Promise<void> => {
    try {
      await openPlayerWindow(title)
    } catch (error) {
      alert(
        t('project.openPlayerFailed', {
          error: error instanceof Error ? error.message : t('common.unknownError')
        })
      )
    }
  }

  const handleProjectCreated = (projectName: string): void => {
    void fetchProjects()
    void handleOpenEditor(projectName)
  }

  return (
    <div className="flex h-full select-none flex-col overflow-auto px-5 py-6 pb-8 sm:px-8 sm:py-8">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold">{t('home.welcome')}</h2>
      </div>

      <div className={cn('flex gap-8', stackSections ? 'flex-col' : 'flex-row')}>
        <div className="min-w-0 flex-1">
          <h3 className="mb-4 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {t('home.recent')}

          </h3>
          {latest ? (
            <div className="space-y-4">
              <div>
                <h4 className="truncate text-lg font-medium">{latest.title}</h4>
                <div className="mt-1 flex items-center text-xs text-muted-foreground">
                  <Clock className="mr-1 h-3 w-3" />
                  <span>{timeAgo(latest.lastModified)}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleOpenEditor(latest.title)}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {t('home.continueEditing')}

                </button>
                <button
                  onClick={() => handleOpenPlayer(latest.title)}
                  className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
                >
                  <Play className="h-3.5 w-3.5" />
                  {t('common.play')}

                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('home.noRecent')}</p>
          )}
        </div>

        <div className={cn(stackSections ? 'w-full' : 'w-48 shrink-0')}>
          <h3 className="mb-4 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {t('home.quickActions')}

          </h3>
          <nav className="space-y-1">
            <button
              data-tour="main-create-project"
              onClick={() => setCreateDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <Plus className="h-4 w-4 text-muted-foreground" />
              {t('project.new')}

            </button>
            <button
              onClick={() => navigate('/projects')}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <Folder className="h-4 w-4 text-muted-foreground" />
              {t('home.allProjects')}

            </button>
            <button
              onClick={() => navigate('/settings')}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
              {t('nav.settings')}

            </button>
          </nav>
        </div>
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={handleProjectCreated}
      />
      <MainProductTour
        active={onboarding.mainTourVersion < MAIN_TOUR_VERSION}
        onComplete={completeMainTour}
      />

      <Dialog
        open={touchPromptOpen}
        onOpenChange={(open: boolean): void => {
          if (!open) finishTouchPrompt(touchPromptValue)
        }}
      >
        <DialogContent className="max-w-md select-none">
          <DialogHeader>
            <DialogTitle>开启触控模式？</DialogTitle>
            <DialogDescription>
              触控模式下会减少对鼠标悬停的依赖，例如项目列表的操作按钮会始终显示，更适合手指操作。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between rounded-lg border px-3 py-3">
            <div className="pr-4">
              <p className="text-sm font-medium">触控模式</p>
              <p className="text-xs text-muted-foreground">可随时在设置里修改</p>
            </div>
            <Switch
              checked={touchPromptValue}
              aria-label="切换触控模式"
              onCheckedChange={setTouchPromptValue}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => finishTouchPrompt(false)}>
              暂不开启
            </Button>
            <Button type="button" onClick={(): void => finishTouchPrompt(touchPromptValue)}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
