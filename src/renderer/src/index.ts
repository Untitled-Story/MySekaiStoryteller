import main from './app/App'

function initialize(): void {
  window.addEventListener('DOMContentLoaded', async (): Promise<void> => {
    await main().catch((error) => {
      window.electron.ipcRenderer.send('electron:on-error', error)
    })
  })
}

initialize()
