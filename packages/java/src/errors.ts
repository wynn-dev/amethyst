import { CancelledError } from '@amethyst/task'

/**
 * Stable error codes thrown by `@amethyst/java`:
 * - `EJAVA_PROBE`: a JVM could not be probed (missing, not executable, unparseable output).
 * - `EJAVA_TIMEOUT`: a spawned probe did not finish in time and was killed.
 * - `EBADARCH`: the binary is for a CPU this Mac cannot run (x86_64 without Rosetta), or an
 *   install produced a runtime whose architecture is not the expected one.
 * - `ENORUNTIME`: no source offers a runtime for the requested major on macOS arm64.
 * - `EBADMANIFEST`: a Mojang runtime index/manifest or Azul API response has an unexpected shape.
 * - `EUNSAFEPATH`: an archive or manifest entry tries to escape its destination.
 * - `EBADARCHIVE`: an archive is truncated or malformed.
 * - `ELZMA`: an LZMA stream failed to decode or did not match its expected size/hash.
 * - `EVERIFY`: a managed runtime failed verification and could not be repaired.
 * - `EINSTALL`: every install candidate failed; `attempts` lists why.
 *
 * Network and checksum failures from `@amethyst/net` propagate with their own codes
 * (`EHTTP`, `ECHECKSUM`, `ESIZE`, ...). Cancellation surfaces as the signal's abort reason.
 */
export type JavaErrorCode =
  | 'EJAVA_PROBE'
  | 'EJAVA_TIMEOUT'
  | 'EBADARCH'
  | 'ENORUNTIME'
  | 'EBADMANIFEST'
  | 'EUNSAFEPATH'
  | 'EBADARCHIVE'
  | 'ELZMA'
  | 'EVERIFY'
  | 'EINSTALL'

/** Base class of the typed errors thrown by this package. */
export class JavaError extends Error {
  override name = 'JavaError'

  constructor(
    readonly code: JavaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** One failed install candidate, kept so the UI can explain what was tried. */
export interface InstallAttempt {
  source: 'mojang' | 'zulu'
  /** Mojang component or `zulu-<major>`. */
  target: string
  error: Error
}

/** Every install candidate failed. The install never ends silently. */
export class InstallError extends JavaError {
  override name = 'InstallError'
  declare readonly code: 'EINSTALL'

  constructor(readonly attempts: InstallAttempt[]) {
    super('EINSTALL', `Java install failed: ${attempts.map((a) => `${a.source} ${a.target}: ${a.error.message}`).join('; ') || 'no candidates'}`, {
      cause: attempts.at(-1)?.error,
    })
  }
}

/** `true` for errors that should stop all work instead of trying another candidate. */
export function isFatal(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!(e instanceof Error)) return false
  const code = (e as { code?: unknown }).code
  return e.name === 'AbortError' || code === 'ECANCELLED' || code === 'ENOSPC' || code === 'EROFS' || code === 'EACCES' || code === 'EPERM'
}

/** The error to throw for an aborted signal. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new CancelledError(String(reason ?? 'Cancelled'))
}
