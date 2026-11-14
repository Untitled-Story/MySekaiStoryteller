import { Ticker, type Application } from 'pixi.js'

const registeredApps: Set<Application> = new Set<Application>()

/**
 * Registers an interactive PixiJS `Application` so background render loops can be
 * temporarily suspended during headless video export.
 */
export function registerInteractivePixiApp(app: Application): () => void {
  registeredApps.add(app)
  return (): void => {
    registeredApps.delete(app)
  }
}

/**
 * Suspends all registered interactive PixiJS application tickers and `Ticker.shared`,
 * returning a restore callback that restarts only tickers that were actively running.
 */
export function suspendInteractivePixiTickers(): () => void {
  const pausedAppTickers: Ticker[] = []
  for (const app of registeredApps) {
    const ticker: Ticker | undefined = app.ticker
    if (ticker && ticker.started) {
      ticker.stop()
      pausedAppTickers.push(ticker)
    }
  }

  const sharedWasStarted: boolean = Ticker.shared.started
  if (sharedWasStarted) {
    Ticker.shared.stop()
  }

  return (): void => {
    for (const ticker of pausedAppTickers) {
      try {
        ticker.start()
      } catch {
        // Ignore tickers belonging to destroyed apps
      }
    }
    if (sharedWasStarted) {
      Ticker.shared.start()
    }
  }
}
