import '@renderer/assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { HashRouter } from 'react-router'
import { DevSupport } from '@react-buddy/ide-toolbox'
import { ComponentPreviews, useInitial } from '@dev'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevSupport ComponentPreviews={ComponentPreviews} useInitialHook={useInitial}>
      <HashRouter>
        <App />
      </HashRouter>
    </DevSupport>
  </StrictMode>
)
