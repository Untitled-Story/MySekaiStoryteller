import React from 'react'
import LeftSidebar from '@windows/welcome/components/LeftSidebar'
import { Route, Routes } from 'react-router'
import HomePage from '@windows/welcome/pages/HomePage'

export default function App(): React.JSX.Element {
  return (
    <>
      <LeftSidebar />
      <main className="fixed top-0 left-65 right-0 bottom-0 overflow-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<text>Projects</text>} />
          <Route path="/settings" element={<text>Settings</text>} />
        </Routes>
      </main>
    </>
  )
}
