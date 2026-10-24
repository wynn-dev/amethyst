/**
 * Xbox Live user authentication and XSTS authorization (steps 2 and 3 of the Minecraft chain).
 *
 * XSTS failures carry an `XErr` number. {@link xstsError} maps every known value to a stable
 * `EXSTS_*` code with a browser-reachable help link; the console-only `Redirect` deep links
 * returned by the service are deliberately not shown.
 */

import { AuthError, type AuthErrorCode } from './errors'
import { asObject, postJson, request, str, type HttpOptions, type HttpResponse } from './http'

export const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate'
export const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
export const XBOX_PROFILE_URL = 'https://profile.xboxlive.com/users'

/** Relying party for the Minecraft services token. */
export const MINECRAFT_RELYING_PARTY = 'rp://api.minecraftservices.com/'
/** Relying party for Xbox profile data (gamertag, gamerpic, XUID). Optional, never required. */
export const XBOX_LIVE_RELYING_PARTY = 'http://xboxlive.com'

export interface XboxToken {
  token: string
  /** User hash (`DisplayClaims.xui[0].uhs`). */
  uhs: string
  /** Xbox user id, present on `http://xboxlive.com` XSTS tokens. */
  xuid?: string
  /** Epoch ms from `NotAfter`, if parseable. */
  notAfter?: number
}

interface XErrInfo {
  code: AuthErrorCode
  message: string
  link?: string
}

/**
 * Known XSTS `XErr` values. Sources: the GDK XErr table (0x8015DCxx) and minecraft.wiki.
 * Note that the GDK lists 0x8015DC0D (2148916237) as "account curfew"; community reports and the
 * accounts spec observe it for South Korean age verification, so both share one code here.
 */
export const XSTS_ERRORS: Readonly<Record<number, XErrInfo>> = {
  2148916227: { code: 'EXSTS_BANNED', message: 'This account is banned from Xbox services.' },
  2148916229: {
    code: 'EXSTS_PARENTAL_CONTROLS',
    message: 'A parent or guardian must allow online play in Microsoft Family settings.',
    link: 'https://account.microsoft.com/family/',
  },
  2148916233: {
    code: 'EXSTS_NO_ACCOUNT',
    message: 'Sign in once at xbox.com to create an Xbox profile, then try again.',
    link: 'https://account.xbox.com/',
  },
  2148916234: {
    code: 'EXSTS_TERMS_NOT_ACCEPTED',
    message: 'Accept the Xbox terms by signing in at xbox.com.',
    link: 'https://account.xbox.com/',
  },
  2148916235: { code: 'EXSTS_REGION_UNAVAILABLE', message: 'Xbox Live is not available in your region.' },
  2148916236: { code: 'EXSTS_AGE_VERIFICATION', message: 'Age verification required.' },
  2148916237: { code: 'EXSTS_AGE_VERIFICATION', message: 'Age verification required.' },
  2148916238: {
    code: 'EXSTS_CHILD_NOT_IN_FAMILY',
    message: 'An adult must add this account to a Microsoft Family group.',
    link: 'https://account.microsoft.com/family/',
  },
  2148916273: { code: 'EXSTS_SERVICE_OUTAGE', message: 'Xbox sign-in is temporarily unavailable. Try again later.' },
  2148916274: { code: 'EXSTS_SERVICE_OUTAGE', message: 'Xbox sign-in is temporarily unavailable. Try again later.' },
}

function httpsLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    // start.ui.xboxlive.com links are console deep links that do not resolve in a browser.
    return url.protocol === 'https:' && url.hostname !== 'start.ui.xboxlive.com' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** Map an XSTS error response to an {@link AuthError}. */
export function xstsError(res: Pick<HttpResponse, 'status' | 'text' | 'json'>): AuthError {
  const body = asObject(res.json)
  const rawXErr = body?.XErr
  const xErr = typeof rawXErr === 'number' ? rawXErr : typeof rawXErr === 'string' && /^\d+$/.test(rawXErr) ? Number(rawXErr) : undefined
  const xErrMessage = str(body, 'Message') || undefined
  const base = { status: res.status, body: res.text, ...(xErrMessage ? { xErrMessage } : {}) }
  if (xErr === undefined) {
    return new AuthError('EXBL_FAILED', `Xbox sign-in failed (HTTP ${res.status})`, {
      ...base,
      retryable: res.status >= 500 || res.status === 429,
    })
  }
  const known = XSTS_ERRORS[xErr]
  if (!known) return new AuthError('EXSTS_UNKNOWN', `Xbox sign-in failed (code ${xErr})`, { ...base, xErr })
  const link = known.code === 'EXSTS_AGE_VERIFICATION' ? httpsLink(str(body, 'Redirect')) : known.link
  return new AuthError(known.code, known.message, {
    ...base,
    xErr,
    retryable: known.code === 'EXSTS_SERVICE_OUTAGE',
    ...(link ? { link } : {}),
  })
}

function parseXboxToken(res: HttpResponse): XboxToken | undefined {
  const body = asObject(res.json)
  const token = str(body, 'Token')
  const claims = asObject(body?.DisplayClaims)
  const xui = Array.isArray(claims?.xui) ? asObject(claims.xui[0]) : undefined
  const uhs = str(xui, 'uhs')
  if (!token || !uhs) return undefined
  const out: XboxToken = { token, uhs }
  const xuid = str(xui, 'xid')
  if (xuid) out.xuid = xuid
  const notAfter = Date.parse(str(body, 'NotAfter') ?? '')
  if (!Number.isNaN(notAfter)) out.notAfter = notAfter
  return out
}

/** Step 2: exchange a Microsoft access token for an Xbox Live user token. */
export async function authenticateXbl(msAccessToken: string, options: HttpOptions = {}): Promise<XboxToken> {
  const res = await postJson(
    XBL_AUTH_URL,
    {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    { 'x-xbl-contract-version': '1' },
    { ...options, stage: 'xboxTokenFailed', retryable: true },
  )
  if (!res.ok) throw xstsError(res)
  const token = parseXboxToken(res)
  if (!token) throw new AuthError('EXBL_FAILED', 'Xbox Live returned a malformed token response', { status: res.status, body: res.text })
  return token
}

/** Step 3: exchange the Xbox Live user token for an XSTS token for `relyingParty`. */
export async function authorizeXsts(
  xblToken: string,
  relyingParty: string = MINECRAFT_RELYING_PARTY,
  options: HttpOptions = {},
): Promise<XboxToken> {
  const res = await postJson(
    XSTS_AUTH_URL,
    { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: relyingParty, TokenType: 'JWT' },
    { 'x-xbl-contract-version': '1' },
    { ...options, stage: 'xboxTokenFailed', retryable: true },
  )
  if (!res.ok) throw xstsError(res)
  const token = parseXboxToken(res)
  if (!token) throw new AuthError('EXSTS_BAD_RESPONSE', 'Xbox returned an XSTS token without user claims', { status: res.status, body: res.text })
  return token
}

/** Gamertag, gamerpic and XUID from the Xbox profile service. */
export interface XboxProfile {
  xuid: string
  gamertag?: string
  avatar?: string
}

/**
 * Fetch the gamertag and gamerpic. Needs a `http://xboxlive.com` XSTS token. Optional: callers
 * must treat any failure as "no avatar" and never block login on it.
 */
export async function getXboxProfile(xsts: XboxToken, options: HttpOptions = {}): Promise<XboxProfile> {
  if (!xsts.xuid) throw new AuthError('EXSTS_BAD_RESPONSE', 'XSTS token has no XUID')
  const res = await request(
    `${XBOX_PROFILE_URL}/xuid(${encodeURIComponent(xsts.xuid)})/profile/settings?settings=PublicGamerpic,Gamertag`,
    {
      headers: { Accept: 'application/json', 'x-xbl-contract-version': '2', Authorization: `XBL3.0 x=${xsts.uhs};${xsts.token}` },
    },
    { ...options, stage: 'xboxTokenFailed' },
  )
  if (!res.ok) throw new AuthError('EXBL_FAILED', `Xbox profile request failed (HTTP ${res.status})`, { status: res.status, body: res.text })
  const users = asObject(res.json)?.profileUsers
  const user = Array.isArray(users) ? asObject(users[0]) : undefined
  const profile: XboxProfile = { xuid: xsts.xuid }
  for (const setting of Array.isArray(user?.settings) ? user.settings : []) {
    const s = asObject(setting)
    const value = str(s, 'value')
    if (!value) continue
    if (str(s, 'id') === 'Gamertag') profile.gamertag = value
    if (str(s, 'id') === 'GameDisplayPicRaw' || str(s, 'id') === 'PublicGamerpic') profile.avatar = value
  }
  return profile
}
