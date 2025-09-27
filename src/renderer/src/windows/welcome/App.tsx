import React from 'react'
import LeftSidebar from '@windows/welcome/components/LeftSidebar'
import { Route, Routes } from 'react-router'

function App(): React.JSX.Element {
  return (
    <>
      <LeftSidebar />
      <main className="fixed left-65 p-6 w-full">
        <Routes>
          <Route path="/" element={<text>Home</text>} />
          <Route path="/projects" element={<text>Projects</text>} />
          <Route path="/settings" element={<text>Settings</text>} />
        </Routes>
      </main>
    </>
  )
}

export default App
