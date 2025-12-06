import main from './app/App'
import { serializeError } from './utils/HelperUtils'

function initialize(): void {
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof Error) {
      window.electron.ipcRenderer.send('electron:on-error', serializeError(event.reason))
    }
  })

  window.addEventListener('DOMContentLoaded', async (): Promise<void> => {
    await main().catch((error: unknown) => {
      if (error instanceof Error) {
        window.electron.ipcRenderer.send('electron:on-error', serializeError(error))
      }
    })
  })
}

initialize()
