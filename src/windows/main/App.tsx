import React, { useEffect } from 'react'
import LeftSidebar from '@/windows/main/components/LeftSidebar'
import { Route, Routes } from 'react-router'
import HomePage from '@/windows/main/pages/HomePage'
import SettingsPage from '@/windows/main/pages/SettingsPage'
import { SettingsProvider } from '@/providers/SettingsProvider'
import { useSettings } from '@/hooks/useSettings'
import { WorkspaceSetup } from '@/windows/main/components/WorkspaceSetup'
import { Agentation } from 'agentation'

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
      <main className="fixed top-0 left-65 right-0 bottom-0 overflow-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<text>Projects</text>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </>
  )
}
