/**
 * Microsoft account orchestration: run the whole chain (XBL → XSTS → `login_with_xbox` →
 * entitlements → profile) from Microsoft tokens and produce an {@link AccountSession}.
 *
 * {@link loginMicrosoft} starts from tokens obtained interactively (auth code or device code).
 * {@link refreshMicrosoft} redeems the stored refresh token silently, never opening a window,
 * and is single-flight per account: concurrent callers share one in-flight refresh, so two
 * token rotations can never race and invalidate each other.
 */

import { AuthError } from './errors'
import type { HttpOptions } from './http'
import { str } from './http'
import { decodeJwtPayload } from './jwt'
import { getEntitlements, getProfile, loginWithXbox, type Entitlements, type MinecraftProfile } from './minecraft'
import { refreshMsToken, type MsTokens } from './oauth'
import type { AccountSession } from './session'
import { authenticateXbl, authorizeXsts, getXboxProfile, MINECRAFT_RELYING_PARTY, XBOX_LIVE_RELYING_PARTY, type XboxProfile } from './xbox'

export interface ChainOptions extends HttpOptions {
  /**
   * Also fetch gamertag, gamerpic and XUID through the `http://xboxlive.com` relying party
   * (default true). Best-effort: failures are reported to `onWarning` and never block login.
   */
  xboxProfile?: boolean
  /** Receives non-fatal problems, e.g. a failed entitlement or Xbox profile lookup. */
  onWarning?: (error: AuthError) => void
}

export interface LoginMicrosoftOptions extends ChainOptions {
  /** Tokens from {@link exchangeCode} or {@link pollDeviceCode}. Must include a refresh token. */
  tokens: MsTokens
  /**
   * When re-authenticating a known account, its session id. Rejects with `EACCOUNT_MISMATCH`
   * if the user signed in with a different account, so A's tokens are never replaced by B's.
   */
  expectedId?: string
}

export interface RefreshMicrosoftOptions extends ChainOptions {
  clientId: string
  scopes?: readonly string[]
  /**
   * Called as soon as Microsoft returns a rotated refresh token, before the rest of the chain
   * runs. Persist it here: the old token may already be invalid if a later step fails.
   */
  onRefreshTokenRotated?: (refreshToken: string) => void | Promise<void>
}

const NOT_OWNED_MESSAGE =
  'This Microsoft account does not own Minecraft: Java Edition. If you bought it recently or play through Game Pass, ' +
  'set your player name at minecraft.net first.'

interface ChainResult {
  accountId: string
  accessToken: string
  expiresAt: number
  profile: MinecraftProfile
  xuid?: string
  xbox?: XboxProfile
}

async function runChain(msAccessToken: string, options: ChainOptions & { expectedId?: string }): Promise<ChainResult> {
  const side = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, side.signal]) : side.signal
  const http: HttpOptions = { ...options, signal }
  const mainHttp: HttpOptions = { ...options }
  const warn = (e: unknown) => {
    if (side.signal.aborted || options.signal?.aborted) return
    options.onWarning?.(e instanceof AuthError ? e : new AuthError('EXBL_FAILED', String(e), { cause: e }))
  }
  const bestEffort = <T>(fn: () => Promise<T>): Promise<T | undefined> =>
    fn().catch((e: unknown) => {
      warn(e)
      return undefined
    })

  try {
    const xbl = await authenticateXbl(msAccessToken, mainHttp)
    const xboxPromise =
      options.xboxProfile === false
        ? Promise.resolve(undefined)
        : bestEffort(async () => getXboxProfile(await authorizeXsts(xbl.token, XBOX_LIVE_RELYING_PARTY, http), http))
    const xsts = await authorizeXsts(xbl.token, MINECRAFT_RELYING_PARTY, mainHttp)
    const mc = await loginWithXbox(xsts.uhs, xsts.token, mainHttp)
    if (options.expectedId !== undefined && mc.accountId !== options.expectedId) {
      throw new AuthError('EACCOUNT_MISMATCH', 'You signed in with a different Microsoft account than the one being refreshed.')
    }
    const entitlementsPromise: Promise<Entitlements | undefined> = bestEffort(() => getEntitlements(mc.accessToken, http))
    let profile: MinecraftProfile
    try {
      profile = await getProfile(mc.accessToken, mainHttp)
    } catch (e) {
      if (e instanceof AuthError && e.code === 'EMC_NO_PROFILE') {
        const entitlements = await entitlementsPromise
        if (entitlements && !entitlements.ownsJava) {
          throw new AuthError('EMC_NOT_OWNED', NOT_OWNED_MESSAGE, { status: e.status ?? 404, cause: e })
        }
      }
      throw e
    }
    const [, xbox] = await Promise.all([entitlementsPromise, xboxPromise])
    const xuid = xbox?.xuid ?? str(decodeJwtPayload(mc.accessToken), 'xuid') ?? xsts.xuid
    const result: ChainResult = { accountId: mc.accountId, accessToken: mc.accessToken, expiresAt: mc.expiresAt, profile }
    if (xuid) result.xuid = xuid
    if (xbox) result.xbox = xbox
    return result
  } finally {
    side.abort()
  }
}

function toSession(id: string, chain: ChainResult, msRefreshToken: string, previous?: AccountSession): AccountSession {
  const session: AccountSession = {
    id,
    kind: 'microsoft',
    username: chain.profile.name,
    uuid: chain.profile.id,
    accessToken: chain.accessToken,
    accessTokenExpiresAt: chain.expiresAt,
    msRefreshToken,
    skins: chain.profile.skins,
    capes: chain.profile.capes,
  }
  const xuid = chain.xuid ?? previous?.xuid
  if (xuid) session.xuid = xuid
  const gamertag = chain.xbox?.gamertag ?? previous?.gamertag
  if (gamertag) session.gamertag = gamertag
  const avatar = chain.xbox?.avatar ?? previous?.avatar
  if (avatar) session.avatar = avatar
  if (previous?.msAccountId) session.msAccountId = previous.msAccountId
  if (previous?.loginHint) session.loginHint = previous.loginHint
  return session
}

/**
 * Turn Microsoft tokens into a Minecraft session by running the full chain.
 *
 * Rejects with an `AuthError`: `EMSA_NO_REFRESH_TOKEN` (request `offline_access`), an
 * `EXSTS_*` code for Xbox account problems, `EMSA_APP_NOT_APPROVED` while the client ID awaits
 * Mojang approval, `EMC_NOT_OWNED` (no profile and no Java entitlement) or `EMC_NO_PROFILE`
 * (no profile yet, e.g. no name chosen), `EACCOUNT_MISMATCH`, or transport errors.
 */
export async function loginMicrosoft(options: LoginMicrosoftOptions): Promise<AccountSession> {
  const { tokens } = options
  if (!tokens.refreshToken) {
    throw new AuthError('EMSA_NO_REFRESH_TOKEN', 'Microsoft did not return a refresh token; the offline_access scope is required.')
  }
  const chain = await runChain(tokens.accessToken, options)
  const session = toSession(chain.accountId, chain, tokens.refreshToken)
  if (tokens.accountId) session.msAccountId = tokens.accountId
  if (tokens.loginHint) session.loginHint = tokens.loginHint
  return session
}

interface Flight {
  promise: Promise<AccountSession>
  controller: AbortController
  waiters: number
}

const inflight = new Map<string, Flight>()

async function doRefresh(session: AccountSession, options: RefreshMicrosoftOptions): Promise<AccountSession> {
  const ms = await refreshMsToken({ ...options, refreshToken: session.msRefreshToken })
  const rotated = ms.refreshToken !== session.msRefreshToken
  try {
    if (rotated) await options.onRefreshTokenRotated?.(ms.refreshToken)
    // The refreshed tokens must belong to this account: never relabel another account's tokens.
    const chain = await runChain(ms.accessToken, { ...options, expectedId: session.id })
    return toSession(session.id, chain, ms.refreshToken, session)
  } catch (e) {
    if (rotated && e instanceof AuthError) throw e.withRotatedRefreshToken(ms.refreshToken)
    throw e
  }
}

/**
 * Silently refresh a Microsoft session: redeem (and rotate) the refresh token, then re-run the
 * chain. Never interactive. Check {@link needsRefresh} first if you only want to refresh stale
 * sessions.
 *
 * Single-flight per `session.id`: callers that arrive while a refresh is running share its
 * result (and the first caller's `fetch`, callbacks and timeouts). Each caller's own `signal`
 * only detaches that caller; the shared refresh is aborted once every waiter has gone.
 *
 * Failures with `reauth === true` (`EMSA_INVALID_GRANT`, `EMSA_INTERACTION_REQUIRED`) mean the
 * user must log in again. `retryable` failures are transient: keep the stored secrets. If the
 * error has `rotatedRefreshToken`, persist that token in place of the old one.
 * `EACCOUNT_MISMATCH` means the stored tokens resolved to a different Minecraft account than
 * `session.id`: they are never returned under this account's id.
 */
export function refreshMicrosoft(session: AccountSession, options: RefreshMicrosoftOptions): Promise<AccountSession> {
  if (options.signal?.aborted) {
    return Promise.reject(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: options.signal.reason }))
  }
  let flight = inflight.get(session.id)
  // A flight whose waiters all left is being torn down; start a fresh one instead of joining it.
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController()
    const promise = doRefresh(session, { ...options, signal: controller.signal })
    const created: Flight = { promise, controller, waiters: 0 }
    flight = created
    inflight.set(session.id, created)
    promise.then(
      () => inflight.get(session.id) === created && inflight.delete(session.id),
      () => inflight.get(session.id) === created && inflight.delete(session.id),
    )
  }
  const shared = flight
  shared.waiters++
  const signal = options.signal
  return new Promise<AccountSession>((resolve, reject) => {
    const detach = () => {
      signal?.removeEventListener('abort', onAbort)
      shared.waiters--
    }
    const onAbort = () => {
      detach()
      if (shared.waiters === 0) shared.controller.abort(signal?.reason)
      reject(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: signal?.reason }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(
      (value) => {
        if (signal?.aborted) return
        detach()
        resolve(value)
      },
      (error: unknown) => {
        if (signal?.aborted) return
        detach()
        reject(error)
      },
    )
  })
}
