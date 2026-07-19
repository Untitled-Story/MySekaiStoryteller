import {
  debug as writeDebug,
  error as writeError,
  info as writeInfo,
  warn as writeWarn
} from '@tauri-apps/plugin-log'
import { captureFatalDiagnostic } from '@/lib/diagnostics'

export type FrontendWindowName = 'main' | 'editor' | 'player'
export type LogDetails = Readonly<Record<string, unknown>>

type FrontendLogLevel = 'debug' | 'info' | 'warn' | 'error'
type PluginLogWriter = (message: string) => Promise<void>

const pluginWriters: Readonly<Record<FrontendLogLevel, PluginLogWriter>> = {
  debug: writeDebug,
  info: writeInfo,
  warn: writeWarn,
  error: writeError
}

let activeWindow: FrontendWindowName | 'unknown' = 'unknown'
let initialized = false
let pluginAvailable = true
let pluginFailureReported = false
const sessionId: string = createSessionId()
let operationSequence = 0

export const logger = {
  debug(event: string, details?: LogDetails): void {
    writeLog('debug', event, details)
  },
  info(event: string, details?: LogDetails): void {
    writeLog('info', event, details)
  },
  warn(event: string, details?: LogDetails): void {
    writeLog('warn', event, details)
  },
  error(event: string, details?: LogDetails): void {
    writeLog('error', event, details)
  }
}

export function initializeFrontendLogging(windowName: FrontendWindowName): void {
  activeWindow = windowName
  if (initialized) return
  initialized = true

  window.addEventListener('error', handleWindowError)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  logger.info('app.bootstrap', {
    path: window.location.pathname,
    userAgent: window.navigator.userAgent,
    language: window.navigator.language
  })
}

export function describeError(error: unknown): LogDetails {
  return describeErrorValue(error, new Set<Error>())
}

export async function runLoggedOperation<T>(
  event: string,
  details: LogDetails,
  operation: () => Promise<T>
): Promise<T> {
  operationSequence += 1
  const operationId: string = `${sessionId}-${operationSequence}`
  const startedAt: number = performance.now()
  logger.info(`${event}.started`, { ...details, operationId })

  try {
    const result: T = await operation()
    logger.info(`${event}.completed`, {
      ...details,
      operationId,
      durationMs: Math.round(performance.now() - startedAt)
    })
    return result
  } catch (error: unknown) {
    logger.error(`${event}.failed`, {
      ...details,
      operationId,
      durationMs: Math.round(performance.now() - startedAt),
      error: describeError(error)
    })
    throw error
  }
}

function describeErrorValue(error: unknown, seen: Set<Error>): LogDetails {
  if (error instanceof Error) {
    if (seen.has(error)) {
      return { name: error.name, message: error.message, circular: true }
    }
    seen.add(error)

    const details: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
    if ('cause' in error && error.cause !== undefined) {
      details.cause = describeErrorValue(error.cause, seen)
    }
    return details
  }
  return { value: stringifyUnknown(error) }
}

function handleWindowError(event: ErrorEvent): void {
  const details: LogDetails = {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: describeError(event.error)
  }
  logger.error('window.error', details)
  captureFatalDiagnostic({
    event: 'window.error',
    window: activeWindow,
    session: sessionId,
    details
  })
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const details: LogDetails = {
    reason: describeError(event.reason)
  }
  logger.error('window.unhandledrejection', details)
  captureFatalDiagnostic({
    event: 'window.unhandledrejection',
    window: activeWindow,
    session: sessionId,
    details
  })
}

function writeLog(level: FrontendLogLevel, event: string, details?: LogDetails): void {
  const message: string = serializeRecord(level, event, details)
  if (!pluginAvailable) {
    writeConsole(level, message)
    return
  }

  void pluginWriters[level](message).catch((error: unknown): void => {
    pluginAvailable = false
    writeConsole(level, message)
    if (!pluginFailureReported) {
      pluginFailureReported = true
      console.error('Frontend file logging is unavailable', error)
    }
  })
}

function serializeRecord(level: FrontendLogLevel, event: string, details?: LogDetails): string {
  const record: Record<string, unknown> = {
    source: 'frontend',
    window: activeWindow,
    session: sessionId,
    level,
    event
  }
  if (details && Object.keys(details).length > 0) {
    record.details = details
  }

  try {
    return JSON.stringify(record, errorReplacer)
  } catch (error: unknown) {
    return JSON.stringify({
      source: 'frontend',
      window: activeWindow,
      session: sessionId,
      level: 'error',
      event: 'logger.serialization_failed',
      details: describeError(error)
    })
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return describeError(value)
  if (typeof value === 'bigint') return value.toString()
  return value
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, errorReplacer) ?? String(value)
  } catch {
    return String(value)
  }
}

function writeConsole(level: FrontendLogLevel, message: string): void {
  if (level === 'error') {
    console.error(message)
    return
  }
  if (level === 'warn') {
    console.warn(message)
    return
  }
  if (level === 'debug') {
    console.debug(message)
    return
  }
  console.info(message)
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
