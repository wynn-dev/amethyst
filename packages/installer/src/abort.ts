import { CancelledError } from '@amethyst/task'

/** The error to throw for an aborted signal: its reason if that is an `Error`, otherwise a `CancelledError`. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new CancelledError(String(reason ?? 'Cancelled'))
}
