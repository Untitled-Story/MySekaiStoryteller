import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Agentation } from 'agentation'
import App from './App'
import { HashRouter } from 'react-router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
      {import.meta.env.DEV && <Agentation />}
    </HashRouter>
  </StrictMode>
)
