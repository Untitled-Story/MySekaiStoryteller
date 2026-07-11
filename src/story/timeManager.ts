export type TimeMode = 'realtime' | 'manual'

interface PendingTimer {
  targetTime: number
  resolve: () => void
  signal: AbortSignal
}

class TimeManagerImpl {
  private mode: TimeMode = 'realtime'
  private currentTime = 0
  private pendingTimers: PendingTimer[] = []

  setMode(mode: TimeMode) {
    this.mode = mode
  }

  getMode(): TimeMode {
    return this.mode
  }

  getCurrentTime(): number {
    return this.currentTime
  }

  async delay(seconds: number, signal: AbortSignal): Promise<void> {
    if (this.mode === 'realtime') {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          return reject(new Error('Aborted'))
        }
        
        const timeout = window.setTimeout(() => {
          this.currentTime += seconds
          resolve()
        }, seconds * 1000)

        signal.addEventListener('abort', () => {
          window.clearTimeout(timeout)
          reject(new Error('Aborted'))
        }, { once: true })
      })
    }

    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        return reject(new Error('Aborted'))
      }

      const targetTime = this.currentTime + seconds
      const timer: PendingTimer = {
        targetTime,
        resolve,
        signal
      }
      this.pendingTimers.push(timer)

      signal.addEventListener('abort', () => {
        this.pendingTimers = this.pendingTimers.filter(t => t !== timer)
        reject(new Error('Aborted'))
      }, { once: true })
    })
  }

  tick(dt: number) {
    this.currentTime += dt
    
    const firing = this.pendingTimers.filter(t => t.targetTime <= this.currentTime)
    this.pendingTimers = this.pendingTimers.filter(t => t.targetTime > this.currentTime)
    
    for (const timer of firing) {
      timer.resolve()
    }
  }

  reset() {
    this.currentTime = 0
    this.pendingTimers = []
  }
}

export const timeManager = new TimeManagerImpl()
