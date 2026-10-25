import { describe, expect, it, vi } from 'vitest'
import {
  chainFetch,
  emptyEntitlementsResponse,
  MC_ACCESS_TOKEN,
  MC_ENTITLEMENTS_URL,
  MC_LOGIN_URL,
  MC_PROFILE_URL,
  msTokenResponse,
  profileNotFound,
  TOKEN_URL,
  XBL_URL,
  XBOX_PROFILE_URL,
  XSTS_URL,
  xstsErrorBody,
  xstsMinecraftResponse,
  xstsRoute,
} from './__fixtures__/chain'
import { json } from './__fixtures__/fake-fetch'
import { AuthError } from './errors'
import { loginMicrosoft, refreshMicrosoft } from './microsoft'
import type { MsTokens } from './oauth'
import type { AccountSession } from './session'
import { XSTS_ERRORS } from './xbox'

const tokens: MsTokens = { accessToken: 'ms-access', refreshToken: 'ms-refresh-1', expiresAt: Date.now() + 3_600_000 }
const fastRetry = { attempts: 4, baseMs: 1, capMs: 50 }

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  const e = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(e).toBeInstanceOf(AuthError)
  return e as AuthError
}

const existing = (overrides: Partial<AccountSession> = {}): AccountSession => ({
  id: 'mc-account-1',
  kind: 'microsoft',
  username: 'Notch',
  uuid: '069a79f444e94726a5befca90e38aaf5',
  accessToken: 'old-mc-token',
  accessTokenExpiresAt: 0,
  msRefreshToken: 'ms-refresh-1',
  skins: [],
  capes: [],
  ...overrides,
})

describe('loginMicrosoft', () => {
  it('runs the whole chain and builds a session', async () => {
    const f = chainFetch()
    const before = Date.now()
    const session = await loginMicrosoft({ tokens, fetch: f.fetch })
    expect(session).toMatchObject({
      id: 'mc-account-1',
      kind: 'microsoft',
      username: 'Notch',
      uuid: '069a79f444e94726a5befca90e38aaf5',
      accessToken: MC_ACCESS_TOKEN,
      msRefreshToken: 'ms-refresh-1',
      xuid: '2535412345678901',
      gamertag: 'Tester',
      avatar: 'https://images-eds-ssl.xboxlive.com/image?url=abc',
    })
    expect(session.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
    expect(session.skins[0]).toMatchObject({ id: 'skin-1', state: 'ACTIVE', variant: 'CLASSIC' })
    expect(session.capes).toHaveLength(1)

    const xbl = f.callsTo(XBL_URL)[0]!
    expect(JSON.parse(xbl.text!)).toMatchObject({ Properties: { RpsTicket: 'd=ms-access' }, RelyingParty: 'http://auth.xboxlive.com' })
    expect(xbl.headers.get('x-xbl-contract-version')).toBe('1')
    const relyingParties = f.callsTo(XSTS_URL).map((c) => (JSON.parse(c.text!) as { RelyingParty: string }).RelyingParty)
    expect(relyingParties).toContain('rp://api.minecraftservices.com/')
    expect(JSON.parse(f.callsTo(MC_LOGIN_URL)[0]!.text!)).toEqual({ identityToken: 'XBL3.0 x=uhs-1234;xsts-mc-token' })
    expect(f.callsTo(MC_PROFILE_URL)[0]!.headers.get('authorization')).toBe(`Bearer ${MC_ACCESS_TOKEN}`)
    expect(f.callsTo(MC_ENTITLEMENTS_URL)).toHaveLength(1)
  })

  it('does not block on the optional Xbox profile and takes the XUID from the Minecraft token', async () => {
    const onWarning = vi.fn<(error: AuthError) => void>()
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json(xstsMinecraftResponse), json(xstsErrorBody(2148916233), 401)) })
    const session = await loginMicrosoft({ tokens, fetch: f.fetch, onWarning })
    expect(session.xuid).toBe('2535499999999999')
    expect(session.avatar).toBeUndefined()
    expect(onWarning).toHaveBeenCalledOnce()
    expect(f.callsTo(XBOX_PROFILE_URL)).toHaveLength(0)
  })

  it('skips the Xbox profile when disabled', async () => {
    const f = chainFetch()
    await loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false })
    expect(f.callsTo(XSTS_URL)).toHaveLength(1)
  })

  it('requires a refresh token', async () => {
    const e = await authError(loginMicrosoft({ tokens: { accessToken: 'a', expiresAt: 0 }, fetch: chainFetch().fetch }))
    expect(e.code).toBe('EMSA_NO_REFRESH_TOKEN')
  })

  it.each(Object.entries(XSTS_ERRORS))('maps XErr %s', async (xErr, info) => {
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json(xstsErrorBody(Number(xErr)), 401)) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe(info.code)
    expect(e.type).toBe('xboxTokenFailed')
    expect(e.xErr).toBe(Number(xErr))
    expect(e.message).toBe(info.message)
    // Console-only deep links are never surfaced.
    expect(e.link ?? '').not.toContain('start.ui.xboxlive.com')
    expect(e.link).toBe(info.link)
    expect(f.callsTo(MC_LOGIN_URL)).toHaveLength(0)
  })

  it('maps unknown XErr codes with the raw number', async () => {
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json(xstsErrorBody(2148916262), 401)) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe('EXSTS_UNKNOWN')
    expect(e.message).toContain('2148916262')
    expect(e.expected).toBe(false)
  })

  it('links age verification to an https Redirect', async () => {
    const body = { ...xstsErrorBody(2148916236), Redirect: 'https://account.xbox.com/verify' }
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json(body, 401)) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe('EXSTS_AGE_VERIFICATION')
    expect(e.link).toBe('https://account.xbox.com/verify')
  })

  it('rejects an XSTS response without claims as badXsts', async () => {
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json({ Token: 'x', DisplayClaims: {} })) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe('EXSTS_BAD_RESPONSE')
    expect(e.type).toBe('badXsts')
  })

  it('surfaces XBL failures with status and body', async () => {
    const f = chainFetch({ [`POST ${XBL_URL}`]: { status: 400, text: 'bad ticket' } })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch }))
    expect(e).toMatchObject({ code: 'EXBL_FAILED', status: 400, body: 'bad ticket' })
  })

  it('maps "Invalid app registration" to EMSA_APP_NOT_APPROVED', async () => {
    const f = chainFetch({
      [`POST ${MC_LOGIN_URL}`]: json(
        { path: '/authentication/login_with_xbox', errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information' },
        403,
      ),
    })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe('EMSA_APP_NOT_APPROVED')
    expect(e.type).toBe('minecraftLoginFailed')
    expect(e.status).toBe(403)
    expect(e.link).toBe('https://aka.ms/AppRegInfo')
  })

  it('maps suspended accounts', async () => {
    const f = chainFetch({ [`POST ${MC_LOGIN_URL}`]: json({ details: { reason: 'ACCOUNT_SUSPENDED' } }, 403) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e).toMatchObject({ code: 'EMC_ACCOUNT_SUSPENDED', reason: 'ACCOUNT_SUSPENDED' })
  })

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const f = chainFetch({
      [`POST ${MC_LOGIN_URL}`]: [{ status: 429, text: 'slow down', headers: { 'retry-after': '0' } }, json(chainLogin())],
    })
    const session = await loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false, retry: fastRetry })
    expect(session.id).toBe('mc-account-1')
    expect(f.callsTo(MC_LOGIN_URL)).toHaveLength(2)
  })

  it('gives up after the retry budget with a structured error', async () => {
    const f = chainFetch({ [`POST ${MC_LOGIN_URL}`]: { status: 429, text: 'slow down', headers: { 'retry-after': '0' } } })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false, retry: fastRetry }))
    expect(e).toMatchObject({ code: 'EMC_RATE_LIMITED', status: 429, retryable: true, retryAfterMs: 0, body: 'slow down' })
    expect(f.callsTo(MC_LOGIN_URL)).toHaveLength(4)
  })

  it('stops retrying when Retry-After exceeds the cap', async () => {
    const f = chainFetch({ [`POST ${MC_LOGIN_URL}`]: { status: 503, text: 'down', headers: { 'retry-after': '3600' } } })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false, retry: fastRetry }))
    expect(e).toMatchObject({ code: 'EMC_SERVICE_ERROR', retryAfterMs: 3_600_000 })
    expect(f.callsTo(MC_LOGIN_URL)).toHaveLength(1)
  })

  it('reports "owns no game" when the profile is missing and entitlements are empty', async () => {
    const f = chainFetch({
      [`GET ${MC_PROFILE_URL}`]: json(profileNotFound, 404),
      [`GET ${MC_ENTITLEMENTS_URL}`]: json(emptyEntitlementsResponse),
    })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e).toMatchObject({ code: 'EMC_NOT_OWNED', type: 'noJavaProfile' })
  })

  it('reports "no profile yet" when the game is owned but has no profile', async () => {
    const f = chainFetch({ [`GET ${MC_PROFILE_URL}`]: json(profileNotFound, 404) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(e).toMatchObject({ code: 'EMC_NO_PROFILE', type: 'noJavaProfile', errorType: 'NOT_FOUND' })
  })

  it('treats entitlements as advisory', async () => {
    // Empty entitlements (e.g. Game Pass) never block a login with a profile.
    const onWarning = vi.fn<(error: AuthError) => void>()
    const empty = chainFetch({ [`GET ${MC_ENTITLEMENTS_URL}`]: json(emptyEntitlementsResponse) })
    await expect(loginMicrosoft({ tokens, fetch: empty.fetch, xboxProfile: false })).resolves.toMatchObject({ username: 'Notch' })
    // A failed entitlement lookup is a warning, and a later 404 stays "no profile".
    const failing = chainFetch({ [`GET ${MC_ENTITLEMENTS_URL}`]: { status: 400, text: 'nope' }, [`GET ${MC_PROFILE_URL}`]: json(profileNotFound, 404) })
    const e = await authError(loginMicrosoft({ tokens, fetch: failing.fetch, xboxProfile: false, onWarning }))
    expect(e.code).toBe('EMC_NO_PROFILE')
    expect(onWarning).toHaveBeenCalledOnce()
  })

  it('rejects a different account when re-authenticating', async () => {
    const e = await authError(loginMicrosoft({ tokens, fetch: chainFetch().fetch, xboxProfile: false, expectedId: 'someone-else' }))
    expect(e.code).toBe('EACCOUNT_MISMATCH')
  })

  it('maps network failures and cancellation', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const e = await authError(loginMicrosoft({ tokens, fetch: offline }))
    expect(e).toMatchObject({ code: 'ENETWORK', type: 'xboxTokenFailed', reason: 'NETWORK', retryable: true })

    const controller = new AbortController()
    controller.abort()
    const cancelled = await authError(loginMicrosoft({ tokens, fetch: chainFetch().fetch, signal: controller.signal }))
    expect(cancelled).toMatchObject({ code: 'ECANCELLED', type: 'aborted' })
  })

  it('serializes errors without secrets', async () => {
    const f = chainFetch({ [`POST ${XSTS_URL}`]: xstsRoute(json(xstsErrorBody(2148916238), 401)) })
    const e = await authError(loginMicrosoft({ tokens, fetch: f.fetch, xboxProfile: false }))
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      name: 'AuthError',
      code: 'EXSTS_CHILD_NOT_IN_FAMILY',
      type: 'xboxTokenFailed',
      message: 'An adult must add this account to a Microsoft Family group.',
      expected: true,
      reauth: false,
      retryable: false,
      status: 401,
      body: JSON.stringify(xstsErrorBody(2148916238)),
      xErr: 2148916238,
      link: 'https://account.microsoft.com/family/',
    })
  })
})

function chainLogin() {
  return { username: 'mc-account-1', roles: [], access_token: MC_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 86400 }
}

describe('refreshMicrosoft', () => {
  it('rotates the refresh token and re-runs the chain', async () => {
    const f = chainFetch({ [`POST ${TOKEN_URL}`]: json(msTokenResponse('ms-refresh-2')) })
    const onRefreshTokenRotated = vi.fn<(token: string) => void>()
    const session = await refreshMicrosoft(existing({ avatar: 'https://old/avatar' }), {
      clientId: 'client-id',
      fetch: f.fetch,
      onRefreshTokenRotated,
      xboxProfile: false,
    })
    expect(session.msRefreshToken).toBe('ms-refresh-2')
    expect(session.accessToken).toBe(MC_ACCESS_TOKEN)
    expect(session.avatar).toBe('https://old/avatar')
    expect(onRefreshTokenRotated).toHaveBeenCalledWith('ms-refresh-2')
    const form = new URLSearchParams(f.callsTo(TOKEN_URL)[0]!.text)
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'client-id',
      grant_type: 'refresh_token',
      refresh_token: 'ms-refresh-1',
      scope: 'XboxLive.signin offline_access',
    })
  })

  it('keeps the old refresh token if none is returned', async () => {
    const { refresh_token: _, ...noRotation } = msTokenResponse()
    const f = chainFetch({ [`POST ${TOKEN_URL}`]: json(noRotation) })
    const session = await refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, xboxProfile: false })
    expect(session.msRefreshToken).toBe('ms-refresh-1')
  })

  it('flags invalid_grant as needing a re-login', async () => {
    const f = chainFetch({ [`POST ${TOKEN_URL}`]: json({ error: 'invalid_grant', error_description: 'AADSTS70000: expired' }, 400) })
    const e = await authError(refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch }))
    expect(e).toMatchObject({ code: 'EMSA_INVALID_GRANT', type: 'tokenExpired', reauth: true, retryable: false })
  })

  it('flags 5xx from the token endpoint as transient', async () => {
    const f = chainFetch({ [`POST ${TOKEN_URL}`]: { status: 503, text: 'unavailable' } })
    const e = await authError(refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, retry: fastRetry }))
    expect(e).toMatchObject({ code: 'EMSA_TOKEN_FAILED', reauth: false, retryable: true })
    expect(f.callsTo(TOKEN_URL)).toHaveLength(4)
  })

  it('retries a rate-limited refresh honouring Retry-After, then succeeds', async () => {
    const f = chainFetch({
      [`POST ${TOKEN_URL}`]: [{ status: 429, json: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '0' } }, json(msTokenResponse('ms-refresh-2'))],
    })
    const session = await refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, xboxProfile: false, retry: fastRetry })
    expect(session.msRefreshToken).toBe('ms-refresh-2')
    expect(f.callsTo(TOKEN_URL)).toHaveLength(2)
  })

  it('rejects refreshed tokens that resolve to a different Minecraft account', async () => {
    const f = chainFetch()
    const e = await authError(refreshMicrosoft(existing({ id: 'mc-account-2' }), { clientId: 'c', fetch: f.fetch, xboxProfile: false }))
    expect(e.code).toBe('EACCOUNT_MISMATCH')
    // The rotated token still belongs to the stored lineage; the caller decides what to do with it.
    expect(e.rotatedRefreshToken).toBe('ms-refresh-2')
    expect(f.callsTo(MC_PROFILE_URL)).toHaveLength(0)
  })

  it('attaches the rotated token when a later step fails', async () => {
    const f = chainFetch({ [`POST ${MC_LOGIN_URL}`]: { status: 500, text: 'boom' } })
    const e = await authError(refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, xboxProfile: false, retry: { attempts: 1 } }))
    expect(e.code).toBe('EMC_SERVICE_ERROR')
    expect(e.rotatedRefreshToken).toBe('ms-refresh-2')
    expect(JSON.stringify(e)).not.toContain('ms-refresh-2')
  })

  it('is single-flight per account', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let n = 0
    const f = chainFetch({
      [`POST ${TOKEN_URL}`]: async () => {
        n++
        await gate
        return json(msTokenResponse(`ms-refresh-${n + 1}`))
      },
    })
    const options = { clientId: 'c', fetch: f.fetch, xboxProfile: false }
    const a = refreshMicrosoft(existing(), options)
    const b = refreshMicrosoft(existing(), options)
    const other = refreshMicrosoft(existing({ id: 'mc-account-2' }), options)
    release()
    const [ra, rb] = await Promise.all([a, b])
    // Its own flight; the fixture chain answers for mc-account-1, so it must not be relabelled.
    await expect(other).rejects.toMatchObject({ code: 'EACCOUNT_MISMATCH' })
    expect(ra).toBe(rb)
    expect(f.callsTo(TOKEN_URL)).toHaveLength(2)

    // After settling, a new call starts a new flight.
    await refreshMicrosoft(existing(), options)
    expect(f.callsTo(TOKEN_URL)).toHaveLength(3)
  })

  it('lets one waiter cancel without aborting the shared refresh', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const f = chainFetch({
      [`POST ${TOKEN_URL}`]: async () => {
        await gate
        return json(msTokenResponse())
      },
    })
    const controller = new AbortController()
    const a = refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, xboxProfile: false, signal: controller.signal })
    const b = refreshMicrosoft(existing(), { clientId: 'c', fetch: f.fetch, xboxProfile: false })
    controller.abort()
    await expect(a).rejects.toMatchObject({ code: 'ECANCELLED' })
    release()
    await expect(b).resolves.toMatchObject({ msRefreshToken: 'ms-refresh-2' })
  })

  it('aborts the shared refresh once every waiter has left', async () => {
    const seen: AbortSignal[] = []
    const f = chainFetch({
      [`POST ${TOKEN_URL}`]: () => new Promise(() => {}),
    })
    const spy: typeof fetch = (input, init) => {
      if (init?.signal) seen.push(init.signal)
      return f.fetch(input, init)
    }
    const controller = new AbortController()
    const a = refreshMicrosoft(existing({ id: 'lonely' }), { clientId: 'c', fetch: spy, signal: controller.signal })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    controller.abort()
    await expect(a).rejects.toMatchObject({ code: 'ECANCELLED' })
    expect(seen[0]!.aborted).toBe(true)
  })
})
