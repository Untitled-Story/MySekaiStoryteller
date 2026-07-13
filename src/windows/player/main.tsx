import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FrontendErrorBoundary } from '@/components/FrontendErrorBoundary'
import { initializeFrontendLogging, logger } from '@/lib/logger'

initializeFrontendLogging('player')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <App />
    </FrontendErrorBoundary>
  </StrictMode>
)

logger.info('react.render_requested')
