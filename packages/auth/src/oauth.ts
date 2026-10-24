/**
 * Microsoft identity platform OAuth 2.0 for a public client on the `consumers` tenant:
 * authorization code + PKCE, the device authorization grant, and refresh-token rotation.
 *
 * The client ID is always supplied by the caller (it comes from build config); nothing here
 * hard-codes one. Start an interactive login with {@link createAuthorizationRequest}, deliver the
 * redirect to {@link parseAuthorizationResponse} (embedded window) or {@link startLoopbackServer}
 * (system browser), then call {@link exchangeCode}. Device code login is
 * {@link startDeviceCode} followed by {@link pollDeviceCode}.
 */

import { createHash, randomBytes } from 'node:crypto'
import { AuthError, sleep, type AuthErrorCode } from './errors'
import { asObject, num, postForm, str, type HttpOptions, type HttpResponse } from './http'
import { decodeJwtPayload } from './jwt'

/** OAuth 2.0 v2 endpoints of the personal-accounts-only authority. */
export const MSA_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
export const MSA_AUTHORIZE_URL = `${MSA_AUTHORITY}/authorize`
export const MSA_TOKEN_URL = `${MSA_AUTHORITY}/token`
export const MSA_DEVICE_CODE_URL = `${MSA_AUTHORITY}/devicecode`

/** Scopes needed for Minecraft: Xbox Live sign-in plus a refresh token. */
export const DEFAULT_SCOPES: readonly string[] = ['XboxLive.signin', 'offline_access']

/** Result of a successful token request. */
export interface MsTokens {
  accessToken: string
  /** Present when `offline_access` was granted. Rotates on every refresh. */
  refreshToken?: string
  /** Epoch ms at which `accessToken` expires. */
  expiresAt: number
  /** Granted scopes, space separated. */
  scope?: string
  /** Present only if `openid` was requested. */
  idToken?: string
  /** Microsoft account id (`oid`, else `sub`) from the id token, if any. */
  accountId?: string
  /** Sign-in name (`preferred_username`) from the id token, if any. Useful as a login hint. */
  loginHint?: string
}

export interface AuthorizationRequestOptions {
  clientId: string
  /** Must be registered on the app (for loopback: `http://localhost`, any port). */
  redirectUri: string
  /** Defaults to {@link DEFAULT_SCOPES}. */
  scopes?: readonly string[]
  /** Pre-fills the account picker when re-authenticating a known account. */
  loginHint?: string
  /** OAuth `prompt` (default `select_account`). Pass `null` to omit it. */
  prompt?: 'select_account' | 'login' | 'consent' | 'none' | null
  /** Use a specific `state` instead of a random one. */
  state?: string
}

export interface AuthorizationRequest {
  /** URL to open in the login window or system browser. */
  url: string
  /** PKCE verifier. Keep it in memory and pass it to {@link exchangeCode}. */
  codeVerifier: string
  /** Anti-CSRF value; the redirect must echo it back. */
  state: string
  redirectUri: string
  scopes: string[]
}

/** Random URL-safe string with `bytes` bytes of entropy. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

/** S256 PKCE challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
}

/** Build an authorize URL with a fresh PKCE verifier and `state`. */
export function createAuthorizationRequest(options: AuthorizationRequestOptions): AuthorizationRequest {
  if (!options.clientId) throw new TypeError('clientId is required')
  const scopes = [...(options.scopes ?? DEFAULT_SCOPES)]
  // 64 random bytes give an 86-character verifier, inside RFC 7636's 43-128 range.
  const codeVerifier = randomToken(64)
  const state = options.state ?? randomToken(24)
  const url = new URL(MSA_AUTHORIZE_URL)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('code_challenge', pkceChallenge(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  const prompt = options.prompt === undefined ? 'select_account' : options.prompt
  if (prompt) url.searchParams.set('prompt', prompt)
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint)
  return { url: url.toString(), codeVerifier, state, redirectUri: options.redirectUri, scopes }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether `url` targets `redirectUri`. Scheme, port and path must match. `localhost`,
 * `127.0.0.1` and `[::1]` are treated as the same host, because Microsoft may rewrite the
 * loopback host. Malformed URLs never match.
 */
export function matchesRedirectUri(url: string, redirectUri: string): boolean {
  let a: URL
  let b: URL
  try {
    a = new URL(url)
    b = new URL(redirectUri)
  } catch {
    return false
  }
  if (a.protocol !== b.protocol || a.port !== b.port || a.pathname !== b.pathname) return false
  if (a.hostname === b.hostname) return true
  return LOOPBACK_HOSTS.has(a.hostname) && LOOPBACK_HOSTS.has(b.hostname)
}

const CANCEL_ERRORS = new Set(['access_denied', 'user_cancelled'])

/**
 * Interpret a navigation to the redirect URI (e.g. from an embedded window's `will-redirect`).
 *
 * Returns `null` if `url` is not the redirect URI, so the caller can let the navigation proceed.
 * Otherwise returns the authorization code, or throws: `EMSA_CANCELLED` if the user declined,
 * `EMSA_TOKEN_FAILED` for other OAuth errors, `EMSA_STATE_MISMATCH` if `state` differs and
 * `EMSA_NO_CODE` if the redirect carries neither a code nor an error.
 */
export function parseAuthorizationResponse(url: string, expected: { redirectUri: string; state: string }): { code: string } | null {
  if (!matchesRedirectUri(url, expected.redirectUri)) return null
  const params = new URL(url).searchParams
  const error = params.get('error')
  if (error) {
    const description = params.get('error_description') ?? error
    if (CANCEL_ERRORS.has(error)) {
      throw new AuthError('EMSA_CANCELLED', 'Sign-in was cancelled', { reason: 'USER_CANCELLED', oauthError: error })
    }
    throw new AuthError('EMSA_TOKEN_FAILED', `Microsoft sign-in failed: ${description}`, { oauthError: error })
  }
  if (params.get('state') !== expected.state) {
    throw new AuthError('EMSA_STATE_MISMATCH', 'Sign-in response did not match this login attempt')
  }
  const code = params.get('code')
  if (!code) throw new AuthError('EMSA_NO_CODE', 'Sign-in response did not contain an authorization code')
  return { code }
}

/** OAuth errors that only an interactive login can fix. */
const INTERACTION_ERRORS = new Set(['interaction_required', 'consent_required', 'login_required'])

function tokenError(res: HttpResponse, grant: 'authorization_code' | 'refresh_token' | 'device_code'): AuthError {
  const body = asObject(res.json)
  const error = str(body, 'error')
  const description = str(body, 'error_description')?.split(/\r?\n/)[0]
  const details = {
    status: res.status,
    body: res.text,
    retryable: res.status >= 500 || res.status === 429,
    ...(error ? { oauthError: error } : {}),
    ...(res.retryAfterMs === undefined ? {} : { retryAfterMs: res.retryAfterMs }),
  }
  if (error === 'invalid_grant' && grant !== 'authorization_code') {
    return new AuthError('EMSA_INVALID_GRANT', 'Your Microsoft sign-in has expired. Log in again.', details)
  }
  if (error && INTERACTION_ERRORS.has(error)) {
    return new AuthError('EMSA_INTERACTION_REQUIRED', 'Microsoft needs you to sign in again.', details)
  }
  if (error && CANCEL_ERRORS.has(error)) {
    return new AuthError('EMSA_CANCELLED', 'Sign-in was cancelled', { ...details, reason: 'USER_CANCELLED' })
  }
  return new AuthError('EMSA_TOKEN_FAILED', `Microsoft sign-in failed: ${description ?? error ?? `HTTP ${res.status}`}`, details)
}

function parseTokens(res: HttpResponse, now: number): MsTokens {
  const body = asObject(res.json)
  const accessToken = str(body, 'access_token')
  const expiresIn = num(body, 'expires_in')
  if (!accessToken || expiresIn === undefined) {
    throw new AuthError('EMSA_TOKEN_FAILED', 'Microsoft returned a malformed token response', { status: res.status, body: res.text })
  }
  const tokens: MsTokens = { accessToken, expiresAt: now + expiresIn * 1000 }
  const refreshToken = str(body, 'refresh_token')
  if (refreshToken) tokens.refreshToken = refreshToken
  const scope = str(body, 'scope')
  if (scope) tokens.scope = scope
  const idToken = str(body, 'id_token')
  if (idToken) {
    tokens.idToken = idToken
    const claims = decodeJwtPayload(idToken)
    const accountId = str(claims, 'oid') ?? str(claims, 'sub')
    if (accountId) tokens.accountId = accountId
    const loginHint = str(claims, 'preferred_username')
    if (loginHint) tokens.loginHint = loginHint
  }
  return tokens
}

export interface ExchangeCodeOptions extends HttpOptions {
  clientId: string
  code: string
  codeVerifier: string
  /** Must be byte-identical to the `redirect_uri` of the authorize request. */
  redirectUri: string
  scopes?: readonly string[]
}

/** Redeem an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(options: ExchangeCodeOptions): Promise<MsTokens> {
  const now = Date.now()
  const res = await postForm(
    MSA_TOKEN_URL,
    {
      client_id: options.clientId,
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      scope: (options.scopes ?? DEFAULT_SCOPES).join(' '),
    },
    { ...options, stage: 'msaTokenFailed' },
  )
  if (!res.ok) throw tokenError(res, 'authorization_code')
  return parseTokens(res, now)
}

export interface RefreshMsTokenOptions extends HttpOptions {
  clientId: string
  refreshToken: string
  scopes?: readonly string[]
}

/**
 * Redeem a refresh token. Microsoft rotates refresh tokens: the result carries a new
 * `refreshToken` that replaces the old one and must be persisted. If the response omits one,
 * the old token is returned unchanged so callers can always store `result.refreshToken`.
 *
 * `invalid_grant` and `interaction_required` reject with `reauth === true` errors; network
 * failures and 5xx reject with `retryable === true` and must not discard stored secrets.
 */
export async function refreshMsToken(options: RefreshMsTokenOptions): Promise<MsTokens & { refreshToken: string }> {
  const now = Date.now()
  const res = await postForm(
    MSA_TOKEN_URL,
    {
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      scope: (options.scopes ?? DEFAULT_SCOPES).join(' '),
    },
    { ...options, stage: 'msaTokenFailed' },
  )
  if (!res.ok) throw tokenError(res, 'refresh_token')
  const tokens = parseTokens(res, now)
  return { ...tokens, refreshToken: tokens.refreshToken ?? options.refreshToken }
}

/** A pending device authorization. Show `userCode` and `verificationUri` to the user. */
export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Epoch ms after which the code is no longer accepted. */
  expiresAt: number
  /** Minimum polling interval in seconds, as sent by the server. */
  interval: number
  /** Human-readable instructions from Microsoft. */
  message?: string
}

export interface StartDeviceCodeOptions extends HttpOptions {
  clientId: string
  scopes?: readonly string[]
}

/** Start a device code login. Requires "Allow public client flows" on the app registration. */
export async function startDeviceCode(options: StartDeviceCodeOptions): Promise<DeviceCode> {
  const now = Date.now()
  const res = await postForm(
    MSA_DEVICE_CODE_URL,
    { client_id: options.clientId, scope: (options.scopes ?? DEFAULT_SCOPES).join(' ') },
    { ...options, stage: 'msaTokenFailed' },
  )
  if (!res.ok) throw tokenError(res, 'device_code')
  const body = asObject(res.json)
  const deviceCode = str(body, 'device_code')
  const userCode = str(body, 'user_code')
  const verificationUri = str(body, 'verification_uri')
  const expiresIn = num(body, 'expires_in')
  if (!deviceCode || !userCode || !verificationUri || expiresIn === undefined) {
    throw new AuthError('EMSA_TOKEN_FAILED', 'Microsoft returned a malformed device code response', { status: res.status, body: res.text })
  }
  const result: DeviceCode = {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now + expiresIn * 1000,
    interval: Math.max(1, num(body, 'interval') ?? 5),
  }
  const message = str(body, 'message')
  if (message) result.message = message
  return result
}

export interface PollDeviceCodeOptions extends HttpOptions {
  clientId: string
  device: DeviceCode
}

const deviceExpired = () => new AuthError('EDEVICE_EXPIRED', 'The sign-in code expired. Start again.')

const DEVICE_ERRORS: Record<string, [AuthErrorCode, string]> = {
  authorization_declined: ['EDEVICE_DECLINED', 'Sign-in was declined'],
  expired_token: ['EDEVICE_EXPIRED', 'The sign-in code expired. Start again.'],
  code_expired: ['EDEVICE_EXPIRED', 'The sign-in code expired. Start again.'],
  bad_verification_code: ['EDEVICE_BAD_CODE', 'The sign-in code was not recognised. Start again.'],
}

/**
 * Poll the token endpoint until the user completes the device login.
 *
 * Waits `interval` seconds between polls, adds 5 s on `slow_down`, and keeps polling through
 * `authorization_pending` and transient failures (network errors, 5xx). Rejects with
 * `EDEVICE_DECLINED`, `EDEVICE_EXPIRED` (server-side or once `expiresAt` passes),
 * `EDEVICE_BAD_CODE`, or `ECANCELLED` when `signal` fires.
 */
export async function pollDeviceCode(options: PollDeviceCodeOptions): Promise<MsTokens> {
  const { device, signal } = options
  let intervalMs = Math.max(1, device.interval) * 1000
  for (;;) {
    const remaining = device.expiresAt - Date.now()
    if (remaining <= 0) throw deviceExpired()
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by design
    await sleep(Math.min(intervalMs, remaining), signal)
    if (Date.now() >= device.expiresAt) throw deviceExpired()
    const now = Date.now()
    let res: HttpResponse
    try {
      // oxlint-disable-next-line no-await-in-loop
      res = await postForm(
        MSA_TOKEN_URL,
        { client_id: options.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.deviceCode },
        { ...options, stage: 'msaTokenFailed' },
      )
    } catch (e) {
      if (e instanceof AuthError && e.retryable) continue
      throw e
    }
    if (res.ok) return parseTokens(res, now)
    const error = str(asObject(res.json), 'error')
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    const known = error ? DEVICE_ERRORS[error] : undefined
    if (known) throw new AuthError(known[0], known[1], { status: res.status, oauthError: error })
    if (res.status >= 500) continue
    throw tokenError(res, 'device_code')
  }
}
