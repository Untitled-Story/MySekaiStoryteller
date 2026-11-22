/** Tauri commands reject with a plain string, so both strings and `Error`s carry a message. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
