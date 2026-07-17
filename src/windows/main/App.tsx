import React, { useEffect } from 'react'
import LeftSidebar from '@/windows/main/components/LeftSidebar'
import { Route, Routes } from 'react-router'
import HomePage from '@/windows/main/pages/HomePage'
import ProjectsPage from '@/windows/main/pages/ProjectsPage'
import SettingsPage from '@/windows/main/pages/SettingsPage'
import AboutPage from '@/windows/main/pages/AboutPage'
import { SettingsProvider } from '@/settings/SettingsProvider'
import { useSettings } from '@/settings/useSettings'
import { WorkspaceSetup } from '@/windows/main/components/WorkspaceSetup'
import { Agentation } from 'agentation'
import { ProjectImportCoordinator } from '@/windows/main/components/ProjectImportCoordinator'

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <AppContent />
      {import.meta.env.DEV && <Agentation />}
    </SettingsProvider>
  )
}

function AppContent(): React.JSX.Element {
  const { appearance, loaded, workspaceDir, setWorkspaceDir } = useSettings()
  const activeTheme = appearance.activeTheme

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

  return (
    <>
      <LeftSidebar />
      <main className="fixed top-0 left-65 right-0 bottom-0 overflow-hidden overscroll-none">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </main>
      <ProjectImportCoordinator />
    </>
  )
}
