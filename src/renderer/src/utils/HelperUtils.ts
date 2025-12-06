export function getRandomNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function serializeError(err: unknown):
  | {
      name: string
      message: string
      stack?: string
      cause?: unknown
    }
  | unknown {
  if (!(err instanceof Error)) return err

  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    cause: serializeError(err.cause)
  }
}
