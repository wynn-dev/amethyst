/**
 * Stable error codes:
 * - `ENBT_MALFORMED`: input bytes are not valid NBT (truncated, bad tag id, bad lengths,
 *   too deep, invalid modified UTF-8, corrupt or oversized compressed stream).
 * - `ENBT_INVALID`: a value passed to the writer cannot be encoded (out-of-range number,
 *   heterogeneous list, string too long, ...).
 */
export type NbtErrorCode = 'ENBT_MALFORMED' | 'ENBT_INVALID'

/** Error thrown by every NBT read/write function. */
export class NbtError extends Error {
  override name = 'NbtError'

  constructor(
    readonly code: NbtErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export const malformed = (message: string, options?: ErrorOptions) => new NbtError('ENBT_MALFORMED', message, options)
export const invalid = (message: string) => new NbtError('ENBT_INVALID', message)
