import { describe, expect, it } from 'vitest'
import { packCompat, packFormatFor, releasesFor } from './pack-format'

describe('pack formats', () => {
  it('maps releases to pack formats', () => {
    expect(packFormatFor('1.21.1')).toBe(34)
    expect(packFormatFor('1.20')).toBe(15)
    expect(packFormatFor('1.12.2')).toBe(3)
    expect(packFormatFor('24w14a')).toBeUndefined()
    expect(releasesFor(15)).toBe('1.20–1.20.1')
    expect(releasesFor(46)).toBe('1.21.4')
  })

  it('explains incompatible packs', () => {
    expect(packCompat({ min: 34, max: 34 }, '1.21.1')?.ok).toBe(true)
    expect(packCompat({ min: 15, max: 34 }, '1.21')?.ok).toBe(true)
    const old = packCompat({ min: 15, max: 15 }, '1.21.1')
    expect(old).toMatchObject({ ok: false, label: 'Made for 1.20–1.20.1' })
    expect(packCompat(undefined, '1.21.1')).toBeUndefined()
  })
})
