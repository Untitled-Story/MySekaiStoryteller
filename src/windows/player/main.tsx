import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FrontendErrorBoundary } from '@/components/FrontendErrorBoundary'
import { initializeFrontendLogging, logger } from '@/lib/logger'
import '@/i18n'
import { SettingsProvider } from '@/settings/SettingsProvider'

initializeFrontendLogging('player')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      {/* Export coordinator/workers must not rewrite config.json (workspace wipe race). */}
      <SettingsProvider persist={false}>
        <App />
      </SettingsProvider>
    </FrontendErrorBoundary>
  </StrictMode>
)

logger.info('react.render_requested')
