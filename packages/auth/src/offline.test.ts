import { describe, expect, it } from 'vitest'
import { createOfflineSession, normalizeUuid, offlineUuid, validateOfflineName } from './offline'

describe('offlineUuid', () => {
  it.each([
    ['Steve', '5627dd98-e6be-3c21-b8a8-e92344183641'],
    ['Notch', 'b50ad385-829d-3141-a216-7e7d7539ba7f'],
    ['jeb_', 'a762f560-4fce-3236-812a-b80efff0b62b'],
  ])('matches Java nameUUIDFromBytes for %s', (name, uuid) => {
    expect(offlineUuid(name)).toBe(uuid)
  })

  it('is case-sensitive and sets version 3 / RFC 4122 variant', () => {
    expect(offlineUuid('steve')).not.toBe(offlineUuid('Steve'))
    const uuid = offlineUuid('steve')
    expect(uuid[14]).toBe('3')
    expect('89ab').toContain(uuid[19])
  })
})

describe('validateOfflineName', () => {
  it.each([
    ['', 'EOFFLINE_NAME_REQUIRED'],
    ['ab', 'EOFFLINE_NAME_LENGTH'],
    ['a'.repeat(17), 'EOFFLINE_NAME_LENGTH'],
    ['Игрок', 'EOFFLINE_NAME_CYRILLIC'],
    ['bad name', 'EOFFLINE_NAME_CHARS'],
    ['bad-name', 'EOFFLINE_NAME_CHARS'],
  ])('rejects %j', (name, code) => {
    expect(validateOfflineName(name)?.code).toBe(code)
  })

  it.each(['abc', 'Steve', 'jeb_', 'a'.repeat(16), 'Player_123'])('accepts %j', (name) => {
    expect(validateOfflineName(name)).toBeUndefined()
  })
})

describe('createOfflineSession', () => {
  it('derives the UUID and a random token that never expires', () => {
    const a = createOfflineSession('Steve')
    expect(a).toMatchObject({ id: 'offline:5627dd98-e6be-3c21-b8a8-e92344183641', kind: 'offline', username: 'Steve', uuid: offlineUuid('Steve') })
    expect(a.accessToken).toMatch(/^[0-9a-f]{32}$/)
    expect(a.accessToken).not.toBe(createOfflineSession('Steve').accessToken)
    expect(a.accessTokenExpiresAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('keeps a custom UUID instead of the derived one', () => {
    const s = createOfflineSession('Steve', { uuid: '069A79F444E94726A5BEFCA90E38AAF5' })
    expect(s.uuid).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5')
    expect(s.id).toBe('offline:069a79f4-44e9-4726-a5be-fca90e38aaf5')
    expect(() => createOfflineSession('Steve', { uuid: 'nope' })).toThrow(expect.objectContaining({ code: 'EOFFLINE_UUID_INVALID' }))
    expect(() => createOfflineSession('x')).toThrow(expect.objectContaining({ code: 'EOFFLINE_NAME_LENGTH' }))
  })

  it('normalises UUIDs', () => {
    expect(normalizeUuid('5627dd98-e6be-3c21-b8a8-e92344183641')).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
    expect(normalizeUuid('5627DD98E6BE3C21B8A8E92344183641')).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
    expect(normalizeUuid('5627dd98-e6be3c21-b8a8-e92344183641')).toBeUndefined()
  })
})
