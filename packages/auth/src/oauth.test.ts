import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_URL, fakeJwt, msTokenResponse, TOKEN_URL } from './__fixtures__/chain'
import { createFakeFetch, json, type Reply } from './__fixtures__/fake-fetch'
import { AuthError } from './errors'
import {
  createAuthorizationRequest,
  exchangeCode,
  matchesRedirectUri,
  parseAuthorizationResponse,
  pollDeviceCode,
  refreshMsToken,
  startDeviceCode,
  type DeviceCode,
} from './oauth'

describe('createAuthorizationRequest', () => {
  it('builds a PKCE authorize URL on the consumers tenant', () => {
    const req = createAuthorizationRequest({ clientId: 'client-id', redirectUri: 'http://localhost:4321' })
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      response_type: 'code',
      redirect_uri: 'http://localhost:4321',
      response_mode: 'query',
      scope: 'XboxLive.signin offline_access',
      code_challenge: createHash('sha256').update(req.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: req.state,
      prompt: 'select_account',
    })
    expect(req.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(req.state.length).toBeGreaterThanOrEqual(16)
    expect(createAuthorizationRequest({ clientId: 'c', redirectUri: 'x' }).state).not.toBe(req.state)
  })

  it('adds a login hint and custom scopes, and can omit prompt', () => {
    const req = createAuthorizationRequest({ clientId: 'c', redirectUri: 'r', scopes: ['a', 'b'], loginHint: 'user+mc@gmail.com', prompt: null })
    const url = new URL(req.url)
    expect(url.searchParams.get('login_hint')).toBe('user+mc@gmail.com')
    expect(url.searchParams.get('scope')).toBe('a b')
    expect(url.searchParams.has('prompt')).toBe(false)
  })
})

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return (e as AuthError).code
  }
  return undefined
}

describe('parseAuthorizationResponse', () => {
  const expected = { redirectUri: 'http://localhost:4321', state: 's1' }

  it('ignores unrelated navigations', () => {
    expect(parseAuthorizationResponse('https://login.live.com/ppsecure', expected)).toBeNull()
    expect(parseAuthorizationResponse('http://localhost:9999/?code=x&state=s1', expected)).toBeNull()
    expect(parseAuthorizationResponse('not a url', expected)).toBeNull()
  })

  it('returns the code and treats loopback hosts as equivalent', () => {
    expect(parseAuthorizationResponse('http://localhost:4321/?code=abc&state=s1', expected)).toEqual({ code: 'abc' })
    expect(parseAuthorizationResponse('http://127.0.0.1:4321/?code=abc&state=s1', expected)).toEqual({ code: 'abc' })
    expect(matchesRedirectUri('http://[::1]:4321/', 'http://localhost:4321')).toBe(true)
    expect(matchesRedirectUri('http://localhost:4321/auth', 'http://localhost:4321')).toBe(false)
    expect(matchesRedirectUri('https://localhost:4321/', 'http://localhost:4321')).toBe(false)
  })

  it('rejects state mismatches, errors and missing codes', () => {
    expect(errorCode(() => parseAuthorizationResponse('http://localhost:4321/?code=abc&state=evil', expected))).toBe('EMSA_STATE_MISMATCH')
    expect(errorCode(() => parseAuthorizationResponse('http://localhost:4321/?state=s1', expected))).toBe('EMSA_NO_CODE')
    expect(errorCode(() => parseAuthorizationResponse('http://localhost:4321/?error=access_denied&state=s1', expected))).toBe('EMSA_CANCELLED')
    expect(errorCode(() => parseAuthorizationResponse('http://localhost:4321/?error=server_error&error_description=x&state=s1', expected))).toBe(
      'EMSA_TOKEN_FAILED',
    )
  })
})

const reply = (body: unknown) => createFakeFetch({ [`POST ${TOKEN_URL}`]: json(body, 400) }).fetch
const run = (fetch: typeof globalThis.fetch) => refreshMsToken({ clientId: 'c', refreshToken: 'r', fetch }).catch((e: AuthError) => e)

describe('token endpoint', () => {
  it('exchanges a code with the verifier and redirect URI', async () => {
    const idToken = fakeJwt({ oid: 'ms-oid', sub: 'ms-sub', preferred_username: 'user@example.photography' })
    const f = createFakeFetch({ [`POST ${TOKEN_URL}`]: json({ ...msTokenResponse(), id_token: idToken }) })
    const before = Date.now()
    const tokens = await exchangeCode({ clientId: 'c', code: 'abc', codeVerifier: 'v', redirectUri: 'http://localhost:4321', fetch: f.fetch })
    expect(tokens).toMatchObject({ accessToken: 'ms-access', refreshToken: 'ms-refresh-2', accountId: 'ms-oid', loginHint: 'user@example.photography' })
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    const call = f.calls[0]!
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(call.text))).toEqual({
      client_id: 'c',
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'http://localhost:4321',
      code_verifier: 'v',
      scope: 'XboxLive.signin offline_access',
    })
  })

  it('never copies tokens from a malformed token response into the error', async () => {
    const { expires_in: _, ...malformed } = { ...msTokenResponse('ms-refresh-secret'), id_token: fakeJwt({ oid: 'x' }) }
    const f = createFakeFetch({ [`POST ${TOKEN_URL}`]: json(malformed) })
    const e = (await refreshMsToken({ clientId: 'c', refreshToken: 'r', fetch: f.fetch }).catch((err: unknown) => err)) as AuthError
    expect(e).toMatchObject({ code: 'EMSA_TOKEN_FAILED', status: 200 })
    const serialized = JSON.stringify(e)
    expect(serialized).toContain('"access_token\\":\\"<redacted>')
    expect(serialized).not.toMatch(/ms-access|ms-refresh-secret|eyJ/)
  })

  it('maps OAuth errors', async () => {
    expect((await run(reply({ error: 'invalid_grant' }))) as AuthError).toMatchObject({ code: 'EMSA_INVALID_GRANT', reauth: true })
    expect((await run(reply({ error: 'interaction_required' }))) as AuthError).toMatchObject({ code: 'EMSA_INTERACTION_REQUIRED', reauth: true })
    expect((await run(reply({ error: 'invalid_client', error_description: 'AADSTS7000218: bad\r\nTrace ID: x' }))) as AuthError).toMatchObject({
      code: 'EMSA_TOKEN_FAILED',
      message: 'Microsoft sign-in failed: AADSTS7000218: bad',
      oauthError: 'invalid_client',
    })
    // A used or expired authorization code is not a "log in again" signal for a stored account.
    const e = await exchangeCode({ clientId: 'c', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetch: reply({ error: 'invalid_grant' }) }).catch(
      (err: AuthError) => err,
    )
    expect(e).toMatchObject({ code: 'EMSA_TOKEN_FAILED' })
  })
})

const start = async (overrides: Record<string, unknown> = {}) => {
  const f = createFakeFetch({
    [`POST ${DEVICE_URL}`]: json({
      device_code: 'dev-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://www.microsoft.com/link',
      expires_in: 900,
      interval: 5,
      message: 'To sign in, use a web browser…',
      ...overrides,
    }),
  })
  return startDeviceCode({ clientId: 'c', fetch: f.fetch })
}

/** Poll with scripted token responses, recording the fake clock at each poll. */
const poll = (device: DeviceCode, replies: Reply[], signal?: AbortSignal) => {
  const times: number[] = []
  const f = createFakeFetch({
    [`POST ${TOKEN_URL}`]: replies.map((r) => () => {
      times.push(Date.now())
      return r
    }),
  })
  const promise = pollDeviceCode({ clientId: 'c', device, fetch: f.fetch, signal })
  promise.catch(() => {})
  return { promise, times, f }
}

const pending = json({ error: 'authorization_pending' }, 400)

describe('device code', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-24T12:00:00Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a device login', async () => {
    const device = await start()
    expect(device).toEqual({
      deviceCode: 'dev-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://www.microsoft.com/link',
      expiresAt: Date.now() + 900_000,
      interval: 5,
      message: 'To sign in, use a web browser…',
    })
  })

  it('polls every interval, backs off on slow_down, and resolves with tokens', async () => {
    const device = await start()
    const t0 = Date.now()
    const { promise, times, f } = poll(device, [pending, json({ error: 'slow_down' }, 400), pending, json(msTokenResponse())])
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(promise).resolves.toMatchObject({ accessToken: 'ms-access', refreshToken: 'ms-refresh-2' })
    expect(times.map((t) => (t - t0) / 1000)).toEqual([5, 10, 20, 30])
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.text))).toEqual({
      client_id: 'c',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dev-code',
    })
  })

  it('does not poll before the first interval', async () => {
    const device = await start({ interval: 7 })
    const { times } = poll(device, [pending])
    await vi.advanceTimersByTimeAsync(6_999)
    expect(times).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(times).toHaveLength(1)
  })

  it.each([
    ['authorization_declined', 'EDEVICE_DECLINED'],
    ['expired_token', 'EDEVICE_EXPIRED'],
    ['bad_verification_code', 'EDEVICE_BAD_CODE'],
  ])('fails on %s', async (error, code) => {
    const device = await start()
    const { promise } = poll(device, [pending, json({ error }, 400)])
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(promise).rejects.toMatchObject({ code })
  })

  it('keeps polling through transient failures', async () => {
    const device = await start()
    const { promise, times } = poll(device, [{ status: 503, text: 'busy' }, json(msTokenResponse())])
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toMatchObject({ accessToken: 'ms-access' })
    expect(times).toHaveLength(2)
  })

  it('expires locally after expires_in', async () => {
    const device = await start({ expires_in: 12 })
    const { promise, times } = poll(device, [pending])
    await vi.advanceTimersByTimeAsync(13_000)
    await expect(promise).rejects.toMatchObject({ code: 'EDEVICE_EXPIRED' })
    expect(times).toHaveLength(2)
  })

  it('stops when cancelled', async () => {
    const device = await start()
    const controller = new AbortController()
    const { promise, times } = poll(device, [pending], controller.signal)
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'ECANCELLED' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(times).toHaveLength(1)
  })
})
