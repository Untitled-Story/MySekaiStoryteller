import React, { lazy, Suspense, useEffect } from 'react'
import LeftSidebar from '@/windows/main/components/LeftSidebar'
import { Route, Routes, useLocation } from 'react-router'
import HomePage from '@/windows/main/pages/HomePage'
import ProjectsPage from '@/windows/main/pages/ProjectsPage'
import SettingsPage from '@/windows/main/pages/SettingsPage'
import AboutPage from '@/windows/main/pages/AboutPage'
import { SettingsProvider } from '@/settings/SettingsProvider'
import { useSettings } from '@/settings/useSettings'
import { ExportProgressHost } from '@/windows/main/components/ExportProgressHost'
import { WorkspaceSetup } from '@/windows/main/components/WorkspaceSetup'
import { Agentation } from 'agentation'
import { ProjectImportCoordinator } from '@/windows/main/components/ProjectImportCoordinator'
import { ProjectsMetadataProvider } from '@/windows/main/providers/ProjectsMetadataProvider'
import { AppNavigator } from '@/windows/shell/AppNavigator'
import { prefersInAppNavigation } from '@/lib/platform'
import { useViewportMode, type ViewportMode } from '@/hooks/useViewportMode'
import { cn } from '@/lib/style'
import { useTranslation } from 'react-i18next'

const MobileEditorPage = lazy(async () => {
  const module = await import('@/windows/shell/MobileEditorPage')
  return { default: module.MobileEditorPage }
})

const MobilePlayerPage = lazy(async () => {
  const module = await import('@/windows/shell/MobilePlayerPage')
  return { default: module.MobilePlayerPage }
})

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <AppNavigator />
      <AppContent />
      <ExportProgressHost />
      {import.meta.env.DEV && <Agentation />}
    </SettingsProvider>
  )
}

function AppContent(): React.JSX.Element {
  const { t } = useTranslation()
  const { appearance, loaded, workspaceDir, setWorkspaceDir } = useSettings()
  const activeTheme = appearance.activeTheme
  const location = useLocation()
  const viewportMode: ViewportMode = useViewportMode()
  const inAppNavigation: boolean = prefersInAppNavigation()
  const isImmersiveRoute: boolean =
    location.pathname.startsWith('/editor/') || location.pathname.startsWith('/player/')

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const root = document.documentElement
    root.classList.toggle('dark', activeTheme === 'dark')
    root.style.colorScheme = activeTheme
  }, [activeTheme])

  if (!loaded) {
    return <></>
  }

  if (!workspaceDir) {
    return <WorkspaceSetup onConfirm={setWorkspaceDir} />
  }

  if (inAppNavigation && isImmersiveRoute) {
    return (
      <Suspense
        fallback={
          <main className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
            {t('mobile.loading')}
          </main>
        }
      >
        <Routes>
          <Route path="/editor/:projectName" element={<MobileEditorPage />} />
          <Route path="/player/:projectName" element={<MobilePlayerPage />} />
        </Routes>
      </Suspense>
    )
  }

  const showSidebarRail: boolean = viewportMode === 'desktop'
  const showBottomNav: boolean = viewportMode === 'phone'
  const showCollapsedSidebar: boolean = viewportMode === 'tablet'

  return (
    <ProjectsMetadataProvider key={workspaceDir}>
      <LeftSidebar mode={showSidebarRail ? 'rail' : showCollapsedSidebar ? 'drawer' : 'bottom'} />
      <main
        className={cn(
          'fixed overflow-hidden overscroll-none',
          showSidebarRail && 'top-0 right-0 bottom-0 left-65',
          showCollapsedSidebar &&
            'left-0 right-0 bottom-0 top-[calc(3rem+env(safe-area-inset-top))]',
          showBottomNav &&
            'left-0 right-0 top-0 pt-[env(safe-area-inset-top)] bottom-[calc(4.25rem+env(safe-area-inset-bottom))]'
        )}
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
          {inAppNavigation ? (
            <>
              <Route
                path="/editor/:projectName"
                element={
                  <Suspense fallback={<RouteFallback label={t('mobile.editor')} />}>
                    <MobileEditorPage />
                  </Suspense>
                }
              />
              <Route
                path="/player/:projectName"
                element={
                  <Suspense fallback={<RouteFallback label={t('mobile.player')} />}>
                    <MobilePlayerPage />
                  </Suspense>
                }
              />
            </>
          ) : null}
        </Routes>
      </main>
      <ProjectImportCoordinator />
    </ProjectsMetadataProvider>
  )
}

function RouteFallback({ label }: { label: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <main className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
      {t('mobile.opening', { label })}
    </main>
  )
}
