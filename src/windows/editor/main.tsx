import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Agentation } from 'agentation'
import App from './App'
import { HashRouter } from 'react-router'
import { FrontendErrorBoundary } from '@/components/FrontendErrorBoundary'
import { initializeFrontendLogging, logger } from '@/lib/logger'

initializeFrontendLogging('editor')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <HashRouter>
        <App />
        {import.meta.env.DEV && <Agentation />}
      </HashRouter>
    </FrontendErrorBoundary>
  </StrictMode>
)

logger.info('react.render_requested')
