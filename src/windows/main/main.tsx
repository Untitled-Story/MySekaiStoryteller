import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { HashRouter } from 'react-router'
import { FrontendErrorBoundary } from '@/components/FrontendErrorBoundary'
import { initializeFrontendLogging, logger } from '@/lib/logger'
import '@/i18n'

initializeFrontendLogging('main')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </FrontendErrorBoundary>
  </StrictMode>
)

logger.info('react.render_requested')
