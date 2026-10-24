/**
 * Stable error codes:
 * - `EZIP_MALFORMED`: the archive (or one entry's data) is corrupt or unsupported.
 * - `EZIP_NOT_FOUND`: the requested entry does not exist.
 * - `EZIP_UNSAFE_PATH`: an entry would escape the extraction directory (`..`, absolute path,
 *   symlink pointing outside), or a path passed to the writer is not a valid relative zip path.
 * - `EZIP_TOO_LARGE`: an entry exceeds the size limit for in-memory reads.
 * - `EZIP_CLOSED`: the reader or writer was already closed/finished.
 */
export type ZipErrorCode = 'EZIP_MALFORMED' | 'EZIP_NOT_FOUND' | 'EZIP_UNSAFE_PATH' | 'EZIP_TOO_LARGE' | 'EZIP_CLOSED'

/** Error thrown by the zip helpers. Abort-related failures surface as `AbortError` instead. */
export class ZipError extends Error {
  override name = 'ZipError'

  constructor(
    readonly code: ZipErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** Wrap a parsing/inflating error as `EZIP_MALFORMED`; typed, abort and file system errors pass through. */
export function wrapMalformed(e: unknown, context: string): unknown {
  if (e instanceof ZipError || isAbortError(e)) return e
  if (e instanceof Error && 'syscall' in e) return e
  const message = e instanceof Error ? e.message : String(e)
  return new ZipError('EZIP_MALFORMED', `${context}: ${message}`, { cause: e })
}
