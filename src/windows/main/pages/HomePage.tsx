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
import { isMobileRuntime } from '@/lib/platform'

export default function HomePage(): JSX.Element {
  const { t } = useTranslation()
  const { projects, fetchProjects } = useProjectsMetadata()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const navigate = useNavigate()
  const { onboarding, setOnboarding } = useSettings()
  const viewportMode = useViewportMode()
  const stackSections: boolean = viewportMode === 'phone'
  const mobileRuntime: boolean = isMobileRuntime()

  const completeMainTour = useCallback((): void => {
    setOnboarding({ ...onboarding, mainTourVersion: MAIN_TOUR_VERSION })
  }, [onboarding, setOnboarding])

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
    <div
      className={cn(
        'flex h-full select-none flex-col overflow-auto px-8 py-8 pb-8 scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent',
        mobileRuntime && 'mobile-page-scrollbar',
        stackSections && 'px-4 py-5 pb-6'
      )}
    >
      <div className={cn('mb-8', stackSections && 'mb-5')}>
        <h2 className={cn('text-2xl font-semibold', stackSections && 'text-xl')}>
          {t('home.welcome')}
        </h2>
      </div>

      <div className={cn('flex gap-8', stackSections ? 'flex-col gap-5' : 'flex-row')}>
        <div
          className={cn(
            'min-w-0 flex-1',
            stackSections && 'rounded-2xl border bg-card p-4 shadow-xs'
          )}
        >
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
              <div
                className={cn(
                  'flex gap-2',
                  stackSections && '[&>button]:h-11 [&>button]:flex-1 [&>button]:justify-center'
                )}
              >
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
          <nav className={cn('space-y-1', stackSections && 'space-y-2')}>
            <button
              data-tour="main-create-project"
              onClick={() => setCreateDialogOpen(true)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent',
                stackSections && 'h-12 rounded-xl border bg-card shadow-xs active:bg-accent'
              )}
            >
              <Plus className="h-4 w-4 text-muted-foreground" />
              {t('project.new')}
            </button>
            <button
              onClick={() => navigate('/projects')}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent',
                stackSections && 'h-12 rounded-xl border bg-card shadow-xs active:bg-accent'
              )}
            >
              <Folder className="h-4 w-4 text-muted-foreground" />
              {t('home.allProjects')}
            </button>
            <button
              onClick={() => navigate('/settings')}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent',
                stackSections && 'h-12 rounded-xl border bg-card shadow-xs active:bg-accent'
              )}
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
    </div>
  )
}
