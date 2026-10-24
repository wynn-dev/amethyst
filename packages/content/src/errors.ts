/**
 * Stable error codes thrown by `@amethyst/content`:
 * - `EINVALID_ZIP`: an archive (jar, pack, world zip, backup) cannot be opened or read.
 * - `ENOT_FOUND`: the file or folder does not exist (or vanished while being read).
 * - `EPERMISSION`: the file system refused access (`EACCES` / `EPERM`).
 * - `EEXIST`: the destination already exists and the operation does not overwrite.
 * - `ECHECKSUM`: content did not match the expected hash or size.
 * - `ENOT_A_WORLD`: a folder or archive does not contain a `level.dat` where one is required.
 * - `EINVALID_ARGUMENT`: the caller passed a value the function cannot act on (bad hash, path
 *   outside the expected folder, unsupported file name).
 */
export type ContentErrorCode =
  | 'EINVALID_ZIP'
  | 'ENOT_FOUND'
  | 'EPERMISSION'
  | 'EEXIST'
  | 'ECHECKSUM'
  | 'ENOT_A_WORLD'
  | 'EINVALID_ARGUMENT'

/** Error thrown by the content helpers. Cancellation surfaces as an `AbortError` instead. */
export class ContentError extends Error {
  override name = 'ContentError'

  constructor(
    readonly code: ContentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Classification of a per-file problem found while scanning a content folder (spec §7.11).
 * These are expected user-file problems, recorded on the entry instead of thrown.
 */
export type FileProblemCode =
  | 'invalid-zip'
  | 'multi-disk-zip'
  | 'bad-central-directory'
  | 'size-mismatch'
  | 'not-found'
  | 'permission-denied'
  | 'unknown'

/** A per-file problem: a stable code plus a human-readable message. */
export interface FileProblem {
  code: FileProblemCode
  message: string
}

/** Map any error raised while reading a file to a {@link FileProblem}. */
export function classifyError(e: unknown): FileProblem {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown } | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENOT_FOUND') return { code: 'not-found', message }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EPERMISSION') return { code: 'permission-denied', message }
  if (code === 'EZIP_MALFORMED' || code === 'EINVALID_ZIP' || code === 'EZIP_TOO_LARGE') {
    if (/multi-?disk|spanned/i.test(message)) return { code: 'multi-disk-zip', message }
    if (/central directory (file )?header|invalid central/i.test(message)) return { code: 'bad-central-directory', message }
    if (/size mismatch|compressed size|uncompressed size|too (many|few) bytes/i.test(message)) return { code: 'size-mismatch', message }
    return { code: 'invalid-zip', message }
  }
  return { code: 'unknown', message }
}

/** True for `AbortError`s and other cancellation errors. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'CancelledError')
}

/** Translate file system errors into {@link ContentError}s; other errors pass through. */
export function wrapFsError(e: unknown, context: string): unknown {
  if (e instanceof ContentError || isAbortError(e)) return e
  const code = (e as { code?: unknown } | undefined)?.code
  const message = `${context}: ${e instanceof Error ? e.message : String(e)}`
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ContentError('ENOT_FOUND', message, { cause: e })
  if (code === 'EACCES' || code === 'EPERM') return new ContentError('EPERMISSION', message, { cause: e })
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return new ContentError('EEXIST', message, { cause: e })
  if (code === 'EZIP_MALFORMED' || code === 'EZIP_TOO_LARGE') return new ContentError('EINVALID_ZIP', message, { cause: e })
  return e
}

/** Create a standard `AbortError` for `signal`. */
export function abortError(signal: AbortSignal): Error {
  const err = new Error('The operation was aborted', { cause: signal.reason })
  err.name = 'AbortError'
  return err
}

/** Throw an `AbortError` if `signal` has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}
