/**
 * Minecraft services API: `login_with_xbox`, entitlements, the player profile, and skin and
 * cape management.
 *
 * All profile endpoints take the Minecraft access token. Responses are validated before use and
 * error bodies are read exactly once.
 */

import { AuthError } from './errors'
import { asObject, num, postJson, request, str, type HttpOptions, type HttpResponse } from './http'
import { validateSkinPng } from './png'

export const MC_SERVICES_URL = 'https://api.minecraftservices.com'
export const MC_LOGIN_URL = `${MC_SERVICES_URL}/authentication/login_with_xbox`
export const MC_ENTITLEMENTS_URL = `${MC_SERVICES_URL}/entitlements/mcstore`
export const MC_PROFILE_URL = `${MC_SERVICES_URL}/minecraft/profile`

export type TextureState = 'ACTIVE' | 'INACTIVE'
export type SkinVariant = 'CLASSIC' | 'SLIM'

export interface Skin {
  id: string
  state: TextureState
  url: string
  variant: SkinVariant
  alias?: string
}

export interface Cape {
  id: string
  state: TextureState
  url: string
  alias?: string
}

/** A Minecraft: Java Edition profile. `id` is the undashed UUID as returned by the service. */
export interface MinecraftProfile {
  id: string
  name: string
  skins: Skin[]
  capes: Cape[]
}

/** Result of `login_with_xbox`. */
export interface MinecraftToken {
  /** Services account id (`username` field). Not the profile UUID. */
  accountId: string
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
}

/** Step 4: exchange the XSTS token for a Minecraft access token. */
export async function loginWithXbox(uhs: string, xstsToken: string, options: HttpOptions = {}): Promise<MinecraftToken> {
  const now = Date.now()
  const res = await postJson(
    MC_LOGIN_URL,
    { identityToken: `XBL3.0 x=${uhs};${xstsToken}` },
    {},
    { ...options, stage: 'minecraftLoginFailed', retryable: true },
  )
  if (!res.ok) throw minecraftLoginError(res)
  const body = asObject(res.json)
  const accountId = str(body, 'username')
  const accessToken = str(body, 'access_token')
  const expiresIn = num(body, 'expires_in')
  if (!accountId || !accessToken || expiresIn === undefined) {
    throw new AuthError('EMC_LOGIN_FAILED', 'Minecraft services returned a malformed login response', { status: res.status, body: res.text })
  }
  return { accountId, accessToken, expiresAt: now + expiresIn * 1000 }
}

function messageOf(body: Record<string, unknown> | undefined): string | undefined {
  return str(body, 'errorMessage') ?? str(body, 'error_description') ?? str(body, 'message') ?? str(body, 'error')
}

/** Map a failed `login_with_xbox` response to an {@link AuthError}. */
export function minecraftLoginError(res: HttpResponse): AuthError {
  const body = asObject(res.json)
  const message = messageOf(body) ?? ''
  const base = {
    status: res.status,
    body: res.text,
    ...(res.retryAfterMs === undefined ? {} : { retryAfterMs: res.retryAfterMs }),
  }
  if (res.status === 403 && /invalid app registration/i.test(`${message} ${res.text}`)) {
    return new AuthError(
      'EMSA_APP_NOT_APPROVED',
      "This build's Azure app is not approved for the Minecraft API yet. Mojang must allow-list the client ID (see https://aka.ms/AppRegInfo).",
      { ...base, link: 'https://aka.ms/AppRegInfo' },
    )
  }
  if (res.status === 403 && str(asObject(body?.details), 'reason') === 'ACCOUNT_SUSPENDED') {
    return new AuthError('EMC_ACCOUNT_SUSPENDED', 'This account is suspended.', { ...base, reason: 'ACCOUNT_SUSPENDED' })
  }
  if (res.status === 429) {
    const seconds = res.retryAfterMs === undefined ? undefined : Math.ceil(res.retryAfterMs / 1000)
    return new AuthError('EMC_RATE_LIMITED', seconds ? `Too many requests, try again in ${seconds} seconds.` : 'Too many requests, try again later.', {
      ...base,
      retryable: true,
    })
  }
  if (res.status >= 500) {
    return new AuthError('EMC_SERVICE_ERROR', `Minecraft services error (HTTP ${res.status})`, { ...base, retryable: true })
  }
  return new AuthError('EMC_LOGIN_FAILED', `Minecraft login failed (HTTP ${res.status})`, { ...base, retryable: res.status === 408 || res.status === 425 })
}

const authHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json' })

/** Entitlement names relevant to Java Edition ownership. */
const JAVA_ENTITLEMENTS = new Set(['product_minecraft', 'game_minecraft', 'product_game_pass_pc', 'product_game_pass_ultimate'])

export interface Entitlements {
  /** Item names, e.g. `product_minecraft`, `game_minecraft`, `product_game_pass_pc`. */
  items: string[]
  /** Whether any item grants Java Edition (purchase or Game Pass). Advisory only. */
  ownsJava: boolean
}

/**
 * Fetch store entitlements. **Advisory only**: Game Pass and fresh purchases can show empty or
 * late lists, so never gate login on this; the profile lookup is authoritative.
 */
export async function getEntitlements(accessToken: string, options: HttpOptions = {}): Promise<Entitlements> {
  const res = await request(MC_ENTITLEMENTS_URL, { headers: authHeaders(accessToken) }, { ...options, stage: 'profileFetchFailed', retryable: true })
  if (!res.ok) throw profileError(res)
  const raw = asObject(res.json)?.items
  const items = (Array.isArray(raw) ? raw : []).map((i) => str(asObject(i), 'name')).filter((n): n is string => !!n)
  return { items, ownsJava: items.some((n) => JAVA_ENTITLEMENTS.has(n)) }
}

function parseState(v: unknown): TextureState {
  return v === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'
}

/** Validate a profile response. Malformed texture entries are dropped rather than trusted. */
export function parseProfile(value: unknown): MinecraftProfile | undefined {
  const body = asObject(value)
  const id = str(body, 'id')
  const name = str(body, 'name')
  if (!id || !name) return undefined
  const skins: Skin[] = []
  for (const s of Array.isArray(body?.skins) ? body.skins : []) {
    const o = asObject(s)
    const sid = str(o, 'id')
    const url = str(o, 'url')
    if (!sid || !url) continue
    const skin: Skin = { id: sid, state: parseState(o?.state), url, variant: str(o, 'variant')?.toUpperCase() === 'SLIM' ? 'SLIM' : 'CLASSIC' }
    const alias = str(o, 'alias')
    if (alias) skin.alias = alias
    skins.push(skin)
  }
  const capes: Cape[] = []
  for (const c of Array.isArray(body?.capes) ? body.capes : []) {
    const o = asObject(c)
    const cid = str(o, 'id')
    const url = str(o, 'url')
    if (!cid || !url) continue
    const cape: Cape = { id: cid, state: parseState(o?.state), url }
    const alias = str(o, 'alias')
    if (alias) cape.alias = alias
    capes.push(cape)
  }
  return { id, name, skins, capes }
}

/** Map a failed profile-API response to an {@link AuthError}. */
export function profileError(res: HttpResponse): AuthError {
  const body = asObject(res.json)
  const errorType = str(body, 'errorType') ?? str(body, 'error')
  const developerMessage = str(body, 'developerMessage')
  const details = {
    status: res.status,
    body: res.text,
    retryable: res.status >= 500 || res.status === 429 || res.status === 408,
    ...(errorType ? { errorType } : {}),
    ...(developerMessage ? { developerMessage } : {}),
    ...(res.retryAfterMs === undefined ? {} : { retryAfterMs: res.retryAfterMs }),
  }
  if (res.status === 401) return new AuthError('EMC_UNAUTHORIZED', 'The Minecraft session is no longer valid.', details)
  if (res.status === 404 && (errorType === 'NOT_FOUND' || errorType === undefined)) {
    return new AuthError(
      'EMC_NO_PROFILE',
      'This Microsoft account does not have a Minecraft: Java Edition profile. If you just bought the game, set your player name at minecraft.net first.',
      details,
    )
  }
  if (res.json === undefined && res.text) {
    return new AuthError('EMC_PROFILE_FAILED', `Minecraft services returned an unexpected response (HTTP ${res.status})`, details)
  }
  return new AuthError('EMC_PROFILE_FAILED', `Minecraft profile request failed: ${messageOf(body) ?? `HTTP ${res.status}`}`, details)
}

function expectProfile(res: HttpResponse): MinecraftProfile {
  const profile = parseProfile(res.json)
  if (!profile) throw new AuthError('EMC_PROFILE_FAILED', 'Minecraft services returned a malformed profile', { status: res.status, body: res.text })
  return profile
}

/**
 * Step 5: fetch the Java Edition profile. Rejects with `EMC_NO_PROFILE` on 404 (game not owned,
 * or bought but no name chosen yet) and `EMC_UNAUTHORIZED` on 401.
 */
export async function getProfile(accessToken: string, options: HttpOptions = {}): Promise<MinecraftProfile> {
  const res = await request(MC_PROFILE_URL, { headers: authHeaders(accessToken) }, { ...options, stage: 'profileFetchFailed', retryable: true })
  if (!res.ok) throw profileError(res)
  return expectProfile(res)
}

/** The current skin (the `ACTIVE` one, else the first) and cape, normalised for viewers. */
export interface CurrentTextures {
  SKIN?: { url: string; metadata?: { model: 'slim' | 'default' } }
  CAPE?: { url: string }
}

/** Derive the current textures from a profile. */
export function currentTextures(profile: Pick<MinecraftProfile, 'skins' | 'capes'>): CurrentTextures {
  const out: CurrentTextures = {}
  const skin = profile.skins.find((s) => s.state === 'ACTIVE') ?? profile.skins[0]
  if (skin) out.SKIN = { url: skin.url, metadata: { model: skin.variant === 'SLIM' ? 'slim' : 'default' } }
  const cape = profile.capes.find((c) => c.state === 'ACTIVE')
  if (cape) out.CAPE = { url: cape.url }
  return out
}

/** Skin model for uploads. `slim` is the 3-pixel-arm "Alex" model. */
export type SkinModel = 'classic' | 'slim'

function skinError(res: HttpResponse): AuthError {
  if (res.status === 401 || res.status === 429 || res.status >= 500) return profileError(res)
  const body = asObject(res.json)
  const message = messageOf(body) ?? res.text.slice(0, 200)
  if (/invalid|banned|not allowed/i.test(message) && /image|skin|texture/i.test(message)) {
    return new AuthError('ESKIN_REJECTED_IMAGE', 'Minecraft rejected this image (invalid or not allowed).', { status: res.status, body: res.text })
  }
  return new AuthError('ESKIN_REJECTED', `Upload rejected: ${message || `HTTP ${res.status}`}`, { status: res.status, body: res.text })
}

/** Use the response as the updated profile if it is one, otherwise re-fetch it. */
async function profileAfterChange(res: HttpResponse, accessToken: string, options: HttpOptions): Promise<MinecraftProfile> {
  return parseProfile(res.json) ?? getProfile(accessToken, options)
}

export interface UploadSkinOptions extends HttpOptions {
  accessToken: string
  /** PNG bytes. Validated with {@link validateSkinPng} before upload. */
  png: Uint8Array
  variant: SkinModel
}

/** Upload a skin as multipart PNG. Returns the updated profile. */
export async function uploadSkin(options: UploadSkinOptions): Promise<MinecraftProfile> {
  validateSkinPng(options.png)
  const form = new FormData()
  form.set('variant', options.variant)
  form.set('file', new Blob([new Uint8Array(options.png)], { type: 'image/png' }), 'skin.png')
  const res = await request(
    `${MC_PROFILE_URL}/skins`,
    { method: 'POST', headers: authHeaders(options.accessToken), body: form },
    { ...options, stage: 'skinFailed' },
  )
  if (!res.ok) throw skinError(res)
  return profileAfterChange(res, options.accessToken, options)
}

export interface SetSkinUrlOptions extends HttpOptions {
  accessToken: string
  /** Public http(s) URL that Mojang fetches. */
  url: string
  variant: SkinModel
}

/** Set the skin from a public URL (Mojang downloads it). Returns the updated profile. */
export async function setSkinUrl(options: SetSkinUrlOptions): Promise<MinecraftProfile> {
  let parsed: URL
  try {
    parsed = new URL(options.url)
  } catch {
    throw new AuthError('ESKIN_REJECTED', 'Skin URL is not valid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AuthError('ESKIN_REJECTED', 'Skin URL must be http(s)')
  const res = await postJson(
    `${MC_PROFILE_URL}/skins`,
    { variant: options.variant, url: parsed.toString() },
    { Authorization: `Bearer ${options.accessToken}` },
    { ...options, stage: 'skinFailed' },
  )
  if (!res.ok) throw skinError(res)
  return profileAfterChange(res, options.accessToken, options)
}

/** Revert to the default skin. Re-fetches the profile, since the default URL is assigned server-side. */
export async function resetSkin(accessToken: string, options: HttpOptions = {}): Promise<MinecraftProfile> {
  const res = await request(`${MC_PROFILE_URL}/skins/active`, { method: 'DELETE', headers: authHeaders(accessToken) }, { ...options, stage: 'skinFailed' })
  if (!res.ok) throw skinError(res)
  return getProfile(accessToken, options)
}

/** Equip an owned cape. Returns the updated profile. */
export async function showCape(accessToken: string, capeId: string, options: HttpOptions = {}): Promise<MinecraftProfile> {
  const res = await request(
    `${MC_PROFILE_URL}/capes/active`,
    { method: 'PUT', headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ capeId }) },
    { ...options, stage: 'skinFailed' },
  )
  if (res.status === 400) throw new AuthError('ECAPE_INVALID', 'That cape is not owned by this profile.', { status: 400, body: res.text })
  if (!res.ok) throw skinError(res)
  return profileAfterChange(res, accessToken, options)
}

/** Hide the cape. Returns the updated profile. */
export async function hideCape(accessToken: string, options: HttpOptions = {}): Promise<MinecraftProfile> {
  const res = await request(`${MC_PROFILE_URL}/capes/active`, { method: 'DELETE', headers: authHeaders(accessToken) }, { ...options, stage: 'skinFailed' })
  if (!res.ok) throw skinError(res)
  return profileAfterChange(res, accessToken, options)
}
