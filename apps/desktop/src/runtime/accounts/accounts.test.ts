/* oxlint-disable no-await-in-loop -- sequential on purpose */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuthError, type AccountSession, type LoopbackServer } from '@amethyst/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Events } from '@shared/events'
import { dataLayout, type DataLayout } from '../layout'
import { applySettingsPatch, defaultSettings } from '../settings/schema'
import { AccountManager, type AuthApi } from './service'

let root: string
let layout: DataLayout
let events: { event: keyof Events; payload: unknown }[]
let keychainBroken: boolean
let encryptionAvailable: boolean

const HOUR = 3600_000

const host = {
  encrypt: async (plain: string) => {
    if (!encryptionAvailable) throw Object.assign(new Error('no keychain'), { code: 'ESECRET_UNAVAILABLE' })
    return `enc:${Buffer.from(plain).toString('base64')}`
  },
  decrypt: async (cipher: string) => {
    if (keychainBroken) throw Object.assign(new Error('Stored secret could not be decrypted'), { code: 'ESECRET_UNREADABLE' })
    return Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString('utf8')
  },
  openAuthWindow: vi.fn<(url: string, redirectUri: string) => Promise<string>>(async (_url, redirectUri) => `${redirectUri}?code=the-code&state=${new URL(_url).searchParams.get('state')}`),
  closeAuthWindow: vi.fn<() => Promise<void>>(async () => {}),
  clearAuthSession: vi.fn<() => Promise<void>>(async () => {}),
  openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
}

function session(id: string, refreshToken: string, uuid = `${id}-uuid`): AccountSession {
  return {
    id,
    kind: 'microsoft',
    username: `Player${id}`,
    uuid,
    accessToken: `mc-token-${id}`,
    accessTokenExpiresAt: Date.now() + 24 * HOUR,
    msRefreshToken: refreshToken,
    skins: [{ id: 's1', state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/abc', variant: 'SLIM' }],
    capes: [],
  }
}

function fakeAuth(next: { id: string; refreshToken: string }[]): Partial<AuthApi> {
  return {
    startLoopbackServer: async () =>
      ({ port: 1234, redirectUri: 'http://localhost:1234', waitForCode: async () => ({ code: 'c' }), close: async () => {} }) as LoopbackServer,
    exchangeCode: async () => ({ accessToken: 'ms-access', refreshToken: 'ms-refresh', expiresAt: Date.now() + HOUR }),
    loginMicrosoft: async () => {
      const n = next.shift()
      if (!n) throw new Error('no more logins')
      return session(n.id, n.refreshToken)
    },
  }
}

function manager(auth: Partial<AuthApi>, options: { clientId?: string | null; developerMode?: boolean } = {}): AccountManager {
  const settings = options.developerMode ? applySettingsPatch(defaultSettings(), { general: { developerMode: true } }).next : defaultSettings()
  return new AccountManager({
    layout,
    emit: (event, payload) => events.push({ event, payload }),
    host,
    settings: { value: settings },
    ...(options.clientId === null ? {} : { msaClientId: options.clientId ?? 'client-id' }),
    auth,
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-acc-'))
  layout = dataLayout(root)
  events = []
  keychainBroken = false
  encryptionAvailable = true
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('AccountManager', () => {
  it('signs in through the embedded window and stores secrets only encrypted, one blob per account', async () => {
    const m = manager(fakeAuth([{ id: 'A', refreshToken: 'rt-A' }, { id: 'B', refreshToken: 'rt-B' }]))
    await m.load()
    const a = await m.loginMicrosoft()
    expect(host.openAuthWindow).toHaveBeenCalledWith(expect.stringContaining('login.microsoftonline.com'), 'http://localhost:1234')
    expect(a).toMatchObject({ id: 'A', kind: 'microsoft', name: 'PlayerA', selected: true, status: 'ok', skin: { model: 'slim' } })
    await m.loginMicrosoft({ method: 'browser' })
    expect(host.openExternal).toHaveBeenCalled()

    const blobs = await readdir(layout.secrets)
    expect(blobs).toHaveLength(2)
    for (const b of blobs) {
      const text = await readFile(path.join(layout.secrets, b), 'utf8')
      expect(text.startsWith('enc:')).toBe(true)
      expect(text).not.toContain('rt-')
    }
    const accountsJson = await readFile(layout.accounts, 'utf8')
    expect(accountsJson).not.toMatch(/mc-token|rt-A|rt-B|accessToken"|msRefreshToken/)
    expect(m.list().map((r) => [r.id, r.selected])).toEqual([
      ['B', true],
      ['A', false],
    ])
    // Each account's blob holds its own tokens.
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-A' } })
    expect(await m.secrets.get('B')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-B' } })
  })

  it('refreshes with the account’s own refresh token, single-flight, persisting rotations', async () => {
    const refreshMicrosoft = vi.fn<(s: AccountSession, o: { onRefreshTokenRotated?: (t: string) => void | Promise<void> }) => Promise<AccountSession>>(async (s, o) => {
      await o.onRefreshTokenRotated?.(`${s.msRefreshToken}-rotated`)
      await new Promise((r) => setTimeout(r, 10))
      return { ...session(s.id, `${s.msRefreshToken}-rotated`), uuid: s.uuid }
    })
    const m = manager({ ...fakeAuth([{ id: 'A', refreshToken: 'rt-A' }, { id: 'B', refreshToken: 'rt-B' }]), refreshMicrosoft: refreshMicrosoft as unknown as AuthApi['refreshMicrosoft'] })
    await m.load()
    await m.loginMicrosoft()
    await m.loginMicrosoft()
    await Promise.all([m.refresh('A', { force: true }), m.refresh('A', { force: true }), m.refresh('A', { force: true })])
    expect(refreshMicrosoft).toHaveBeenCalledTimes(1)
    expect(refreshMicrosoft.mock.calls[0]?.[0].msRefreshToken).toBe('rt-A')
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-A-rotated' } })
    expect(await m.secrets.get('B')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-B' } })
  })

  it('treats an undecryptable blob as "sign in again", never as a crash', async () => {
    const first = manager(fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]))
    await first.load()
    await first.loginMicrosoft()

    // A new session where the Keychain key changed (e.g. the app was re-signed).
    keychainBroken = true
    const m = manager({})
    await m.load()
    expect(m.list()).toMatchObject([{ id: 'A', status: 'ok' }])
    await expect(m.refresh('A', { force: true })).rejects.toMatchObject({ code: 'ESIGN_IN_REQUIRED', details: { reauth: true } })
    expect(m.list()).toMatchObject([{ id: 'A', status: 'needs-sign-in' }])
    await expect(m.sessionForLaunch('A')).rejects.toMatchObject({ code: 'ESIGN_IN_REQUIRED' })
  })

  it('marks definitive refresh failures, keeps credentials on transient ones', async () => {
    let failure: AuthError = new AuthError('ENETWORK', 'offline', { retryable: true })
    const m = manager({
      ...fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]),
      refreshMicrosoft: (async () => {
        throw failure
      }) as unknown as AuthApi['refreshMicrosoft'],
    })
    await m.load()
    await m.loginMicrosoft()
    await expect(m.refresh('A', { force: true })).rejects.toMatchObject({ code: 'ENETWORK' })
    expect(m.list()[0]?.status).toBe('ok')
    expect(await m.secrets.get('A')).toMatchObject({ ok: true })

    failure = new AuthError('EMSA_INVALID_GRANT', 'revoked').withRotatedRefreshToken('rt-new')
    await expect(m.refresh('A', { force: true })).rejects.toMatchObject({ code: 'EMSA_INVALID_GRANT', details: { reauth: true } })
    expect(m.list()[0]?.status).toBe('needs-sign-in')
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-new' } })
  })

  it('maps EMSA_APP_NOT_APPROVED to a clear message and reports a missing client id', async () => {
    const m = manager({
      ...fakeAuth([]),
      loginMicrosoft: async () => {
        throw new AuthError('EMSA_APP_NOT_APPROVED', 'Invalid app registration', { status: 403, link: 'https://aka.ms/AppRegInfo' })
      },
    })
    await m.load()
    await expect(m.loginMicrosoft()).rejects.toMatchObject({ code: 'EMSA_APP_NOT_APPROVED', message: expect.stringMatching(/not been approved by Mojang/), details: { link: 'https://aka.ms/AppRegInfo' } })
    expect(events.at(-1)).toMatchObject({ event: 'accounts:login', payload: { stage: 'failed', code: 'EMSA_APP_NOT_APPROVED' } })

    const none = manager({}, { clientId: null })
    await none.load()
    expect(none.status().microsoft).toEqual({ available: false, reason: 'no-client-id' })
    await expect(none.loginMicrosoft()).rejects.toMatchObject({ code: 'EUNAVAILABLE' })
  })

  it('allows offline accounts only after a Microsoft account (or in developer mode)', async () => {
    const m = manager(fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]))
    await m.load()
    await expect(m.addOffline('Steve')).rejects.toMatchObject({ code: 'EOFFLINE_NOT_ALLOWED' })
    await m.loginMicrosoft()
    const steve = await m.addOffline('Steve')
    expect(steve).toMatchObject({ kind: 'offline', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641', selected: true })
    await expect(m.addOffline('a')).rejects.toMatchObject({ code: 'EOFFLINE_NAME_LENGTH' })

    const dev = manager({}, { developerMode: true })
    await dev.load()
    expect(dev.status().offlineAllowed).toBe(true)
  })

  it('keeps two accounts isolated across switch, removal and re-adding (KI #1587)', async () => {
    const m = manager(fakeAuth([{ id: 'A', refreshToken: 'rt-A' }, { id: 'B', refreshToken: 'rt-B' }, { id: 'B', refreshToken: 'rt-B2' }]))
    await m.load()
    await m.loginMicrosoft()
    await m.loginMicrosoft()
    await m.select('A')
    host.clearAuthSession.mockClear()
    await m.remove('B')
    // The login window's Microsoft cookies are cleared with the account.
    expect(host.clearAuthSession).toHaveBeenCalledTimes(1)
    expect(await m.secrets.get('B')).toEqual({ ok: false, reason: 'missing' })
    expect(await readdir(layout.secrets)).toEqual([path.basename(m.secrets.fileFor('A'))])
    await m.loginMicrosoft()
    expect(m.list().map((r) => r.id).toSorted()).toEqual(['A', 'B'])
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-A' } })
    expect(await m.secrets.get('B')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-B2' } })
    // Removing an offline profile leaves the Microsoft sign-in alone.
    const steve = await m.addOffline('Steve')
    await m.remove(steve.id)
    expect(host.clearAuthSession).toHaveBeenCalledTimes(1)
  })

  it('never relabels another profile’s tokens after a refresh, and never opens a window to recover', async () => {
    const m = manager({
      ...fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]),
      refreshMicrosoft: (async (s: AccountSession) => ({ ...session(s.id, 'rt-other', 'other-uuid'), accessToken: 'mc-token-other' })) as unknown as AuthApi['refreshMicrosoft'],
    })
    await m.load()
    await m.loginMicrosoft()
    host.openAuthWindow.mockClear()
    host.openExternal.mockClear()
    await expect(m.refresh('A', { force: true })).rejects.toMatchObject({ code: 'EACCOUNT_MISMATCH', details: { reauth: true } })
    expect(m.list()[0]).toMatchObject({ id: 'A', uuid: 'A-uuid', status: 'needs-sign-in' })
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { accessToken: 'mc-token-A', msRefreshToken: 'rt-A' } })
    await expect(m.sessionForLaunch('A')).rejects.toMatchObject({ code: 'EACCOUNT_MISMATCH' })
    expect(host.openAuthWindow).not.toHaveBeenCalled()
    expect(host.openExternal).not.toHaveBeenCalled()
  })

  it('does not resurrect secrets when an account is removed during its refresh', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const m = manager({
      ...fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]),
      refreshMicrosoft: (async (s: AccountSession, o: { onRefreshTokenRotated?: (t: string) => Promise<void> }) => {
        await gate
        await o.onRefreshTokenRotated?.('rt-A-rotated')
        return session(s.id, 'rt-A-rotated')
      }) as unknown as AuthApi['refreshMicrosoft'],
    })
    await m.load()
    await m.loginMicrosoft()
    const refreshing = m.refresh('A', { force: true })
    refreshing.catch(() => {})
    await m.remove('A')
    release()
    await expect(refreshing).rejects.toMatchObject({ code: 'ECANCELLED' })
    await vi.waitFor(async () => expect(await readdir(layout.secrets)).toEqual([]))
    expect(await m.secrets.get('A')).toEqual({ ok: false, reason: 'missing' })
    expect(m.list()).toEqual([])
  })

  it('lets a sign-in win over a refresh that was already running for the same account', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let failRefresh = false
    const m = manager({
      ...fakeAuth([{ id: 'A', refreshToken: 'rt-A' }, { id: 'A', refreshToken: 'rt-A-new' }]),
      refreshMicrosoft: (async () => {
        if (!failRefresh) throw new AuthError('EMSA_INVALID_GRANT', 'revoked')
        await gate
        throw new AuthError('EMSA_INVALID_GRANT', 'revoked').withRotatedRefreshToken('rt-A-stale')
      }) as unknown as AuthApi['refreshMicrosoft'],
    })
    await m.load()
    await m.loginMicrosoft()
    await expect(m.refresh('A', { force: true })).rejects.toMatchObject({ code: 'EMSA_INVALID_GRANT' })
    expect(m.list()[0]?.status).toBe('needs-sign-in')

    // A launch starts a (doomed) refresh with the old token; meanwhile the user signs in again.
    failRefresh = true
    const refreshing = m.refresh('A')
    await m.loginMicrosoft({ accountId: 'A' })
    release()
    await expect(refreshing).resolves.toMatchObject({ id: 'A', status: 'ok' })
    expect(m.list()[0]?.status).toBe('ok')
    expect(await m.secrets.get('A')).toMatchObject({ ok: true, secrets: { msRefreshToken: 'rt-A-new' } })
  })

  it('removes accounts with their secrets and keeps memory-only credentials without a keychain', async () => {
    encryptionAvailable = false
    const m = manager(fakeAuth([{ id: 'A', refreshToken: 'rt-A' }]))
    await m.load()
    await m.loginMicrosoft()
    expect(await readdir(layout.secrets).catch(() => [])).toEqual([])
    expect(await m.secrets.get('A')).toMatchObject({ ok: true })

    encryptionAvailable = true
    await m.secrets.put('A', { accessToken: 't', accessTokenExpiresAt: 1, msRefreshToken: 'r' })
    expect(await readdir(layout.secrets)).toHaveLength(1)
    await m.remove('A')
    expect(await readdir(layout.secrets)).toEqual([])
    expect(m.list()).toEqual([])
    expect(events.at(-1)).toEqual({ event: 'accounts:changed', payload: { ids: [], removed: ['A'], selectedId: null } })
  })
})
