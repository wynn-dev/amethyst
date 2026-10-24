/**
 * Errors thrown by runtime services. `code` is the stable, UI-mappable identifier; `details`
 * is plain JSON that crosses the RPC boundary (see `toRpcError`).
 */
export class AppError extends Error {
  override name = 'AppError'

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** True for cancellation errors from any of the packages (`AbortError`, `CancelledError`, `ECANCELLED`). */
export function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.name === 'AbortError' || e.name === 'CancelledError' || (e as { code?: unknown }).code === 'ECANCELLED'
}

/** The `code` of an error, if it has a string one. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const notFound = (what: string): AppError => new AppError('ENOT_FOUND', `${what} not found`)
export const invalid = (message: string, details?: Record<string, unknown>): AppError => new AppError('EINVALID_ARGUMENT', message, details)
export const cancelled = (): AppError => new AppError('ECANCELLED', 'Cancelled')
