/**
 * Stable error codes:
 * - `EVERSION_MISSING`: a version JSON in the `inheritsFrom` chain does not exist or cannot be read.
 *   `details.version` is the missing id (which may be a parent, not the requested id).
 * - `EVERSION_CORRUPT`: a version JSON is not valid JSON.
 * - `EVERSION_INVALID`: a version JSON parses but has the wrong shape, or the merged chain lacks a
 *   required field such as `mainClass`.
 * - `EVERSION_CYCLE`: the `inheritsFrom` chain loops. `details.chain` lists the ids walked.
 * - `ENATIVES_UNAVAILABLE`: no arm64 build is known for a native library the version needs.
 * - `ENATIVES_EXTRACT`: extracting one or more native jars failed.
 * - `ELIBRARY_PATH`: a library has no usable download path, so it cannot go on the classpath.
 * - `ELOG_CONFIG_MISSING`: the version declares a log4j config that is not on disk.
 * - `EASSET_INDEX`: the asset index is missing or malformed.
 * - `ELAUNCH_JAVA_NOT_FOUND`: the java executable (or wrapper command) does not exist.
 * - `ELAUNCH_JAVA_PERMISSION`: the java executable is not executable.
 * - `ELAUNCH_SPAWN`: the process could not be started for another reason.
 * - `ELAUNCH_OPTIONS`: launch options are invalid (for example `-Xms` larger than `-Xmx`).
 */
export type GameErrorCode =
  | 'EVERSION_MISSING'
  | 'EVERSION_CORRUPT'
  | 'EVERSION_INVALID'
  | 'EVERSION_CYCLE'
  | 'ENATIVES_UNAVAILABLE'
  | 'ENATIVES_EXTRACT'
  | 'ELIBRARY_PATH'
  | 'ELOG_CONFIG_MISSING'
  | 'EASSET_INDEX'
  | 'ELAUNCH_JAVA_NOT_FOUND'
  | 'ELAUNCH_JAVA_PERMISSION'
  | 'ELAUNCH_SPAWN'
  | 'ELAUNCH_OPTIONS'

/** Error thrown by `@amethyst/game`. `details` carries structured, structured-cloneable context for the UI. */
export class GameError extends Error {
  override name = 'GameError'

  constructor(
    readonly code: GameErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function abortError(signal: AbortSignal): Error {
  const err = new Error('The operation was aborted', { cause: signal.reason })
  err.name = 'AbortError'
  return err
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}
