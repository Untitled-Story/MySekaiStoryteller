import '@/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FrontendErrorBoundary } from '@/components/FrontendErrorBoundary'
import { initializeFrontendLogging, logger } from '@/lib/logger'
import { EditorRoot } from './EditorRoot'
import '@/i18n'

initializeFrontendLogging('editor')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FrontendErrorBoundary>
      <EditorRoot />
    </FrontendErrorBoundary>
  </StrictMode>
)

logger.info('react.render_requested')
