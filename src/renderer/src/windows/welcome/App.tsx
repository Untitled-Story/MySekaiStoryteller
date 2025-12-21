import React, { useEffect } from 'react'
import LeftSidebar from '@windows/welcome/components/LeftSidebar'
import { Route, Routes } from 'react-router'
import HomePage from '@windows/welcome/pages/HomePage'
import SettingsPage from '@windows/welcome/pages/SettingsPage'
import { SettingsProvider } from '@renderer/providers/SettingsProvider'
import { useSettings } from '@renderer/hooks/useSettings'

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <AppContent />
    </SettingsProvider>
  )
}

function AppContent(): React.JSX.Element {
  const { appearance } = useSettings()
  const activeTheme = appearance.activeTheme

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const root = document.documentElement
    root.classList.toggle('dark', activeTheme === 'dark')
    root.style.colorScheme = activeTheme
  }, [activeTheme])

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
