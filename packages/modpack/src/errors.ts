/**
 * Stable error codes thrown by `@amethyst/modpack` (`modpacks.md` §9 names in brackets):
 * - `ENOT_A_FILE` [notAFile]: the pack path is missing or is not a regular file.
 * - `ENOT_A_ZIP` [notAZip]: the file is not a zip archive (a `.rar`, `.7z`, half download...).
 * - `EUNKNOWN_FORMAT` [unknownFormat]: the zip has neither `modrinth.index.json` nor a
 *   CurseForge `manifest.json`.
 * - `EINVALID_MANIFEST` [invalidManifest]: the manifest failed validation. `field` names the
 *   offending JSON path.
 * - `EUNSUPPORTED_FORMAT` [unsupportedFormat]: Modrinth `formatVersion` is not 1 or `game` is
 *   not `minecraft`.
 * - `EMARKET_UNAVAILABLE` [marketUnavailable]: the CurseForge or Modrinth API failed while
 *   resolving files (offline, missing or rejected API key, server errors).
 * - `EINSTALL_INCOMPLETE` [installIncomplete]: some files could not be staged. Nothing was
 *   committed; the staging workspace is kept so the operation can be resumed.
 * - `ECHECKSUM`: a file's content did not match the expected hash.
 * - `EINSTANCE_GONE`: the instance directory vanished or was replaced during the operation.
 * - `EBUSY`: another modpack operation holds this instance.
 * - `EINVALID_ARGUMENT`: the caller passed something the function cannot act on.
 * - `ECOMMIT`: moving staged files into the instance failed; every change was rolled back.
 * - `EUNSAFE_PATH`: a folder on the way to a target is a symlink that leads out of the instance,
 *   so writing there would change files elsewhere. Nothing was written through it.
 * - `EALREADY_ROLLED_BACK`: the backup was already restored once; restoring it again would
 *   throw away what the user changed since.
 *
 * These are expected, user-facing conditions; do not report them as crashes. Cancellation
 * surfaces as an `AbortError` / `CancelledError` instead.
 */
export type ModpackErrorCode =
  | 'ENOT_A_FILE'
  | 'ENOT_A_ZIP'
  | 'EUNKNOWN_FORMAT'
  | 'EINVALID_MANIFEST'
  | 'EUNSUPPORTED_FORMAT'
  | 'EMARKET_UNAVAILABLE'
  | 'EINSTALL_INCOMPLETE'
  | 'ECHECKSUM'
  | 'EINSTANCE_GONE'
  | 'EBUSY'
  | 'EINVALID_ARGUMENT'
  | 'ECOMMIT'
  | 'EUNSAFE_PATH'
  | 'EALREADY_ROLLED_BACK'

/** Extra details attached to a {@link ModpackError}. */
export interface ModpackErrorDetails {
  /** JSON path of the invalid manifest field, e.g. `files[3].hashes.sha1`. */
  field?: string
  /** Paths (relative to the instance) of the files that failed, for `EINSTALL_INCOMPLETE`. */
  failed?: { path: string; reason: string }[]
  cause?: unknown
}

/** Error thrown by the modpack functions. */
export class ModpackError extends Error {
  override name = 'ModpackError'
  readonly field: string | undefined
  readonly failed: { path: string; reason: string }[] | undefined

  constructor(
    readonly code: ModpackErrorCode,
    message: string,
    details: ModpackErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.field = details.field
    this.failed = details.failed
  }
}

/** Type guard that also narrows on `code` when given. */
export function isModpackError(e: unknown, code?: ModpackErrorCode): e is ModpackError {
  return e instanceof ModpackError && (code === undefined || e.code === code)
}

/** True for `AbortError`s and `CancelledError`s. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'CancelledError')
}

/** Create a standard `AbortError` for `signal`. */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && isAbortError(signal.reason)) return signal.reason
  const err = new Error('The operation was aborted', { cause: signal.reason })
  err.name = 'AbortError'
  return err
}

/** Throw an `AbortError` if `signal` has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

/** Message of any thrown value. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
