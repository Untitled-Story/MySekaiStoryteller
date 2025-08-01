import main from './app/App'

function initialize(): void {
  window.addEventListener('unhandledrejection', (event) => {
    window.electron.ipcRenderer.send('electron:on-error', event.reason)
  })

  window.addEventListener('DOMContentLoaded', async (): Promise<void> => {
    await main().catch((error) => window.electron.ipcRenderer.send('electron:on-error', error))
  })
}

initialize()
