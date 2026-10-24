/**
 * Offline accounts: name validation and the UUID a vanilla server in `online-mode=false`
 * assigns, i.e. Java's `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)`.
 */

import { createHash, randomBytes } from 'node:crypto'
import { AuthError } from './errors'
import type { OfflineSession } from './session'

/**
 * Offline UUID for `name`: MD5 of `OfflinePlayer:<name>` (UTF-8) with the version nibble set
 * to 3 and the RFC 4122 variant bits. This is a name-based v3 UUID *without* a namespace, so a
 * generic `uuidv3(name, namespace)` gives different results. Names are case-sensitive.
 *
 * @returns a lowercase dashed UUID, e.g. `5627dd98-e6be-3c21-b8a8-e92344183641` for `Steve`.
 */
export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x30
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return formatUuid(bytes.toString('hex'))
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Normalise a UUID with or without dashes to lowercase dashed form, or `undefined` if invalid. */
export function normalizeUuid(value: string): string | undefined {
  const v = value.trim().toLowerCase()
  const hex = /^[0-9a-f]{32}$/.test(v) ? v : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v.replaceAll('-', '') : undefined
  return hex ? formatUuid(hex) : undefined
}

/**
 * Check an offline player name: required, 3–16 characters, `[A-Za-z0-9_]` only. Vanilla
 * tolerates other names in places, but servers and mods often break on them.
 *
 * @returns `undefined` if valid, otherwise an error with code `EOFFLINE_NAME_REQUIRED`,
 * `EOFFLINE_NAME_LENGTH`, `EOFFLINE_NAME_CYRILLIC` or `EOFFLINE_NAME_CHARS`.
 */
export function validateOfflineName(name: string): AuthError | undefined {
  if (!name) return new AuthError('EOFFLINE_NAME_REQUIRED', 'Enter a player name.')
  if (/[Ѐ-ӿ]/.test(name)) {
    return new AuthError('EOFFLINE_NAME_CYRILLIC', 'Player names cannot contain Cyrillic letters. Use Latin letters, digits and _.')
  }
  if (!/^[A-Za-z0-9_]*$/.test(name)) return new AuthError('EOFFLINE_NAME_CHARS', 'Player names may only contain letters, digits and _.')
  if (name.length < 3 || name.length > 16) return new AuthError('EOFFLINE_NAME_LENGTH', 'Player names must be 3 to 16 characters long.')
  return undefined
}

export interface OfflineSessionOptions {
  /**
   * Custom UUID (with or without dashes), used *instead of* the derived one and kept as the
   * profile key. It is never re-derived later.
   */
  uuid?: string
}

/**
 * Create an offline session for `name`. Throws the {@link validateOfflineName} error for bad
 * names and `EOFFLINE_UUID_INVALID` for a malformed custom UUID. The access token is a random
 * 32-hex string; offline sessions never expire.
 */
export function createOfflineSession(name: string, options: OfflineSessionOptions = {}): OfflineSession {
  const invalid = validateOfflineName(name)
  if (invalid) throw invalid
  let uuid = offlineUuid(name)
  if (options.uuid !== undefined && options.uuid !== '') {
    const custom = normalizeUuid(options.uuid)
    if (!custom) throw new AuthError('EOFFLINE_UUID_INVALID', 'The custom UUID is not valid.')
    uuid = custom
  }
  return {
    id: `offline:${uuid}`,
    kind: 'offline',
    username: name,
    uuid,
    accessToken: randomBytes(16).toString('hex'),
    accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
    skins: [],
    capes: [],
  }
}
