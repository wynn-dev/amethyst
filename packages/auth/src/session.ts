/**
 * Session model shared by Microsoft and offline accounts.
 *
 * Sessions are plain JSON-safe objects. Secrets (`accessToken`, `msRefreshToken`) are kept in
 * top-level fields so they can be split off for encrypted storage with {@link splitSession} and
 * stripped for the renderer with {@link toPublicAccount}. Token storage itself lives in the app
 * (Electron `safeStorage`); this package never persists anything.
 */

import { AuthError } from './errors'
import { asObject, num, str } from './http'
import type { Cape, Skin } from './minecraft'
import { parseProfile } from './minecraft'

/** A signed-in Microsoft account with its Java Edition profile. */
export interface AccountSession {
  /** Stable local id: the Minecraft services account id from `login_with_xbox` (not the UUID). */
  id: string
  kind: 'microsoft'
  /** Player name. */
  username: string
  /** Profile UUID, undashed as returned by Minecraft services. */
  uuid: string
  /** Minecraft access token (secret). */
  accessToken: string
  /** Epoch ms at which `accessToken` expires. */
  accessTokenExpiresAt: number
  /** Microsoft refresh token (secret). Rotates on every refresh. */
  msRefreshToken: string
  /** Xbox user id, passed to the game as `${auth_xuid}`. */
  xuid?: string
  skins: Skin[]
  capes: Cape[]
  /** Xbox gamertag, if the optional Xbox profile lookup succeeded. */
  gamertag?: string
  /** Xbox gamerpic URL, if the optional Xbox profile lookup succeeded. */
  avatar?: string
  /** Microsoft account id (`oid`/`sub`), only when `openid` was requested. */
  msAccountId?: string
  /** Microsoft sign-in name, only when `openid` was requested. Use as `login_hint`. */
  loginHint?: string
}

/** An offline profile. The access token is a random placeholder and never expires. */
export interface OfflineSession {
  /** `offline:<uuid>`. */
  id: string
  kind: 'offline'
  username: string
  /** Dashed lowercase UUID (derived or custom). */
  uuid: string
  accessToken: string
  accessTokenExpiresAt: number
  skins: Skin[]
  capes: Cape[]
}

export type Session = AccountSession | OfflineSession

/** The secret part of a session, for the encrypted store. */
export interface SessionSecrets {
  accessToken: string
  /** Microsoft accounts only. */
  msRefreshToken?: string
}

/** A session without secrets, safe to send to the renderer and to write to `accounts.json`. */
export type PublicAccount = Omit<AccountSession, 'accessToken' | 'msRefreshToken'> | Omit<OfflineSession, 'accessToken'>

/** Refresh this long before the Minecraft token actually expires. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * Whether the session's Minecraft token is missing, expired, or expires within `marginMs`.
 * Offline sessions never need a refresh.
 */
export function needsRefresh(session: Session, now: number = Date.now(), marginMs: number = REFRESH_MARGIN_MS): boolean {
  if (session.kind === 'offline') return false
  if (!session.accessToken || !Number.isFinite(session.accessTokenExpiresAt) || session.accessTokenExpiresAt <= 0) return true
  return session.accessTokenExpiresAt - marginMs <= now
}

/**
 * Strip secrets from a session. Fields are copied explicitly, so unknown extra properties
 * (which might hold secrets) are never passed through.
 */
export function toPublicAccount(session: Session): PublicAccount {
  const base = {
    id: session.id,
    username: session.username,
    uuid: session.uuid,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    skins: session.skins.map((s) => ({ ...s })),
    capes: session.capes.map((c) => ({ ...c })),
  }
  if (session.kind === 'offline') return { ...base, kind: 'offline' }
  const out: Omit<AccountSession, 'accessToken' | 'msRefreshToken'> = { ...base, kind: 'microsoft' }
  for (const key of ['xuid', 'gamertag', 'avatar', 'msAccountId', 'loginHint'] as const) {
    if (session[key] !== undefined) out[key] = session[key]
  }
  return out
}

/** Split a session into its public record and the secrets to encrypt. */
export function splitSession(session: Session): { account: PublicAccount; secrets: SessionSecrets } {
  const secrets: SessionSecrets = { accessToken: session.accessToken }
  if (session.kind === 'microsoft') secrets.msRefreshToken = session.msRefreshToken
  return { account: toPublicAccount(session), secrets }
}

/** Recombine a stored record with its decrypted secrets. Throws `ESESSION_INVALID` if they do not fit. */
export function joinSession(account: PublicAccount, secrets: SessionSecrets): Session {
  return parseSession({ ...account, ...secrets })
}

function invalid(why: string): AuthError {
  return new AuthError('ESESSION_INVALID', `Stored account data is unreadable (${why}). Log in again.`)
}

/**
 * Validate an untrusted value (e.g. decrypted from disk) as a {@link Session}. Throws
 * `ESESSION_INVALID`, which has `reauth === true`: treat it as "log in again", never as a crash.
 */
export function parseSession(value: unknown): Session {
  const o = asObject(value)
  if (!o) throw invalid('not an object')
  const id = str(o, 'id')
  const username = str(o, 'username')
  const uuid = str(o, 'uuid')
  const accessToken = str(o, 'accessToken')
  const accessTokenExpiresAt = num(o, 'accessTokenExpiresAt')
  if (!id || !username || !uuid || !accessToken || accessTokenExpiresAt === undefined) throw invalid('missing fields')
  const textures = parseProfile({ id: uuid, name: username, skins: o.skins, capes: o.capes })
  const skins = textures?.skins ?? []
  const capes = textures?.capes ?? []
  if (o.kind === 'offline') return { id, kind: 'offline', username, uuid, accessToken, accessTokenExpiresAt, skins, capes }
  if (o.kind !== 'microsoft') throw invalid('unknown kind')
  const msRefreshToken = str(o, 'msRefreshToken')
  if (!msRefreshToken) throw invalid('missing refresh token')
  const session: AccountSession = { id, kind: 'microsoft', username, uuid, accessToken, accessTokenExpiresAt, msRefreshToken, skins, capes }
  for (const key of ['xuid', 'gamertag', 'avatar', 'msAccountId', 'loginHint'] as const) {
    const v = str(o, key)
    if (v) session[key] = v
  }
  return session
}
