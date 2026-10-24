/**
 * Stable error codes thrown by `@amethyst/installer`:
 * - `EINSTALL_BAD_METADATA`: a metadata response or local JSON (manifest, version JSON, profile,
 *   maven metadata) failed validation.
 * - `EINSTALL_NOT_FOUND`: the requested Minecraft or loader version does not exist.
 * - `EINSTALL_BAD_INSTALLER`: a Forge/NeoForge installer jar is malformed or of an unknown format.
 * - `EINSTALL_UNVERIFIED`: no checksum could be obtained for a file whose contents get executed
 *   (installer jars). The install fails closed.
 * - `EINSTALL_CHECKSUM`: a file does not match its published checksum.
 * - `EINSTALL_FILE_INVALID`: a file failed validation after download (not a zip, not JSON, no
 *   accepted checksum), or a local-only file is missing.
 * - `EINSTALL_UNKNOWN_VARIABLE`: a processor argument references an unknown `{VARIABLE}`.
 * - `EINSTALL_PROCESSOR_BAD_JAR` / `EINSTALL_PROCESSOR_NO_MAIN_CLASS`: a processor jar cannot be
 *   read, or has no `Main-Class`.
 * - `EINSTALL_PROCESSOR_FAILED`: a processor exited with a non-zero code or was killed.
 * - `EINSTALL_PROCESSOR_OUTPUT`: a processor output is missing or does not match its checksum.
 * - `EINSTALL_NO_JAVA`: a step needs Java (Forge/NeoForge processors) and none was provided.
 * - `EINSTALL_UNSUPPORTED`: the requested combination is not supported.
 *
 * Download failures from `@amethyst/net` (`EDOWNLOAD`, `EHTTP`, `ECHECKSUM`, ...) and
 * cancellation (`CancelledError`, `ECANCELLED`) propagate unchanged.
 */
export type InstallErrorCode =
  | 'EINSTALL_BAD_METADATA'
  | 'EINSTALL_NOT_FOUND'
  | 'EINSTALL_BAD_INSTALLER'
  | 'EINSTALL_UNVERIFIED'
  | 'EINSTALL_CHECKSUM'
  | 'EINSTALL_FILE_INVALID'
  | 'EINSTALL_UNKNOWN_VARIABLE'
  | 'EINSTALL_PROCESSOR_BAD_JAR'
  | 'EINSTALL_PROCESSOR_NO_MAIN_CLASS'
  | 'EINSTALL_PROCESSOR_FAILED'
  | 'EINSTALL_PROCESSOR_OUTPUT'
  | 'EINSTALL_NO_JAVA'
  | 'EINSTALL_UNSUPPORTED'

/** Base class of the typed errors thrown by this package. */
export class InstallError extends Error {
  override name = 'InstallError'

  constructor(
    readonly code: InstallErrorCode,
    message: string,
    options?: ErrorOptions & { path?: string; url?: string },
  ) {
    super(message, options)
    if (options?.path !== undefined) this.path = options.path
    if (options?.url !== undefined) this.url = options.url
  }

  /** The file the error is about, when there is one. */
  path?: string
  /** The (sanitized) URL the error is about, when there is one. */
  url?: string
}

/** A processor exited unsuccessfully. `log` holds the tail of its combined stdout/stderr. */
export class ProcessorError extends InstallError {
  override name = 'ProcessorError'

  constructor(
    message: string,
    /** Main class of the failing processor. */
    readonly mainClass: string,
    readonly exitCode: number | null,
    readonly signal: string | null,
    /** Last bytes of the processor's output (at most 64 KiB), for error reports. */
    readonly log: string,
  ) {
    // The last lines of output usually name the cause (an exception); keep them in the message.
    const tail = log.trimEnd().split('\n').slice(-8).join('\n').slice(-1500)
    super('EINSTALL_PROCESSOR_FAILED', tail ? `${message}:\n${tail}` : message)
  }
}

/** A processor output is missing or has the wrong checksum. */
export class ProcessorOutputError extends InstallError {
  override name = 'ProcessorOutputError'

  constructor(
    readonly file: string,
    readonly expected: string | undefined,
    readonly actual: string | undefined,
  ) {
    super(
      'EINSTALL_PROCESSOR_OUTPUT',
      expected ? `processor output ${file}: expected sha1 ${expected}, got ${actual ?? 'nothing'}` : `processor output ${file} is missing or invalid`,
      { path: file },
    )
  }
}
