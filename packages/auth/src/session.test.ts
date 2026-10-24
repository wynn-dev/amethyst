import { describe, expect, it } from 'vitest'
import { createOfflineSession } from './offline'
import { joinSession, needsRefresh, parseSession, REFRESH_MARGIN_MS, splitSession, toPublicAccount, type AccountSession } from './session'

const session: AccountSession = {
  id: 'mc-account-1',
  kind: 'microsoft',
  username: 'Notch',
  uuid: '069a79f444e94726a5befca90e38aaf5',
  accessToken: 'mc-secret',
  accessTokenExpiresAt: 1_800_000_000_000,
  msRefreshToken: 'ms-secret',
  xuid: '2535412345678901',
  skins: [{ id: 's', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc', variant: 'SLIM' }],
  capes: [],
  avatar: 'https://example.com/a.png',
}

describe('toPublicAccount', () => {
  it('strips tokens, including unknown extra fields', () => {
    const leaky = { ...session, sneaky: 'secret-too' } as AccountSession
    const pub = toPublicAccount(leaky)
    const text = JSON.stringify(pub)
    expect(text).not.toContain('secret')
    expect(pub).toEqual({
      id: 'mc-account-1',
      kind: 'microsoft',
      username: 'Notch',
      uuid: '069a79f444e94726a5befca90e38aaf5',
      accessTokenExpiresAt: 1_800_000_000_000,
      xuid: '2535412345678901',
      skins: session.skins,
      capes: [],
      avatar: 'https://example.com/a.png',
    })
    expect(JSON.stringify(toPublicAccount(createOfflineSession('Steve')))).not.toContain('accessToken"')
  })
})

describe('splitSession / joinSession', () => {
  it('round-trips through JSON', () => {
    const { account, secrets } = splitSession(session)
    expect(secrets).toEqual({ accessToken: 'mc-secret', msRefreshToken: 'ms-secret' })
    const restored = joinSession(JSON.parse(JSON.stringify(account)), JSON.parse(JSON.stringify(secrets)))
    expect(restored).toEqual(session)

    const offline = createOfflineSession('Steve', { uuid: '069a79f444e94726a5befca90e38aaf5' })
    const parts = splitSession(offline)
    expect(parts.secrets).toEqual({ accessToken: offline.accessToken })
    expect(joinSession(parts.account, parts.secrets)).toEqual(offline)
  })

  it('treats corrupt data as "log in again"', () => {
    for (const bad of [null, 'garbage', {}, { ...session, kind: 'mojang' }, { ...session, msRefreshToken: '' }, { ...session, accessTokenExpiresAt: 'x' }]) {
      expect(() => parseSession(bad)).toThrow(expect.objectContaining({ code: 'ESESSION_INVALID', reauth: true }))
    }
  })
})

describe('needsRefresh', () => {
  it('uses a safety margin', () => {
    const exp = session.accessTokenExpiresAt
    expect(needsRefresh(session, exp - REFRESH_MARGIN_MS - 1)).toBe(false)
    expect(needsRefresh(session, exp - REFRESH_MARGIN_MS)).toBe(true)
    expect(needsRefresh(session, exp + 1)).toBe(true)
    expect(needsRefresh(session, exp - 60_000, 0)).toBe(false)
  })

  it('handles unknown expiry and offline sessions', () => {
    expect(needsRefresh({ ...session, accessTokenExpiresAt: 0 }, 0)).toBe(true)
    expect(needsRefresh({ ...session, accessTokenExpiresAt: -1 }, 0)).toBe(true)
    expect(needsRefresh({ ...session, accessToken: '' }, 0)).toBe(true)
    expect(needsRefresh(createOfflineSession('Steve'), Date.now())).toBe(false)
  })
})
