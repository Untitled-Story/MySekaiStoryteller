import main from './app/app'

function initialize(): void {
  window.addEventListener('DOMContentLoaded', async (): Promise<void> => {
    await main().catch((error) => {
      throw error
    })
  })
}

initialize()
