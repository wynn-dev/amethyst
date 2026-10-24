import { describe, expect, it } from 'vitest'
import { javaRequirementFor, matchesMajor, minecraftEra } from './requirement'
import { selectJava } from './select'
import type { JavaRecord } from './types'

let n = 0
function rec(version: string, major: number, arch: JavaRecord['arch'] = 'arm64', extra: Partial<JavaRecord> = {}): JavaRecord {
  const path = extra.path ?? `/jdk/${n++}-${version}-${arch}/bin/java`
  return {
    path,
    realPath: path,
    javaHome: path.replace(/\/bin\/java$/, ''),
    version,
    majorVersion: major,
    arch,
    source: 'system',
    managed: false,
    valid: true,
    verified: true,
    mtimeMs: 0,
    size: 0,
    probedAt: 0,
    ...extra,
  }
}

describe('selectJava', () => {
  const j8 = rec('1.8.0_512', 8)
  const j8x = rec('1.8.0_202', 8, 'x64')
  const j11 = rec('11.0.2', 11)
  const j17 = rec('17.0.15', 17)
  const j17x = rec('17.0.20', 17, 'x64')
  const j21 = rec('21.0.7', 21)
  const j21managed = rec('21.0.3', 21, 'arm64', { managed: true, source: 'managed' })
  const j25 = rec('25.0.1', 25)
  const j9 = rec('21.0.9', 21, 'arm64', { path: '/jdk/ibm-semeru-openj9-21/bin/java' })
  const broken = rec('21.0.8', 21, 'arm64', { valid: false, invalidReason: 'timeout' })
  const all = [j8x, j8, j11, j17x, j17, j21, j21managed, j25, j9, broken]

  it.each([
    // [required major, installed, expected, reason]
    [8, all, j8, 'exact-major'],
    [17, all, j17, 'exact-major'],
    [21, all, j21managed, 'exact-major'],
    [25, all, j25, 'exact-major'],
    [16, all, j17, 'compatible-major'],
    [16, [j8, j21, j25], j21, 'compatible-major'],
    [22, [j17, j21, j25], j25, 'compatible-major'],
    [8, [j8x, j11, j17], j8x, 'rosetta-only'],
    [17, [j17x, j8], j17x, 'rosetta-only'],
    [17, [j17x, j21], j21, 'compatible-major'],
  ] as const)('requires %i -> picks the expected JVM', (major, installed, expected, reason) => {
    const r = selectJava(installed, { major })
    expect(r.java).toBe(expected)
    expect(r.reason).toBe(reason)
    expect(r.rosetta).toBe(expected.arch === 'x64')
  })

  it('never picks an x64 JVM when an arm64 one matches, even a closer one', () => {
    expect(selectJava([j17x, j25], { major: 17 }).java).toBe(j25)
    expect(selectJava([j8x, j8], { major: 8 }).java).toBe(j8)
  })

  it('prefers managed, then newer, and ranks OpenJ9 last within a major', () => {
    const ranked = selectJava([j9, j21, j21managed], { major: 21 }).ranked.map((r) => r.java)
    expect(ranked).toEqual([j21managed, j9, j21])
    const a = rec('21.0.9', 21)
    expect(selectJava([j9, a], { major: 21 }).java).toBe(a)
  })

  it('uses a valid pinned Java whatever its grade, and falls back when it is gone', () => {
    const pinned = selectJava(all, { major: 21, pinnedPath: j8x.path })
    expect(pinned).toMatchObject({ java: j8x, reason: 'pinned', grade: 'bad', rosetta: true })
    expect(pinned.message).toMatch(/does not match/)
    const gone = selectJava(all, { major: 21, pinnedPath: '/nope/bin/java' })
    expect(gone).toMatchObject({ java: j21managed, reason: 'exact-major', pinnedUnavailable: true })
    const invalid = selectJava(all, { major: 21, pinnedPath: broken.path })
    expect(invalid.pinnedUnavailable).toBe(true)
  })

  it('uses the preferred Java only when it matches and does not force Rosetta', () => {
    expect(selectJava(all, { major: 17, preferredPath: j25.path })).toMatchObject({ java: j25, reason: 'preferred' })
    expect(selectJava(all, { major: 17, preferredPath: j8.path }).java).toBe(j17)
    expect(selectJava(all, { major: 17, preferredPath: j17x.path }).java).toBe(j17)
    expect(selectJava([j17x], { major: 17, preferredPath: j17x.path }).reason).toBe('preferred')
  })

  it('reports no match with an "okay" suggestion, and no valid Java at all', () => {
    const r = selectJava([j11, j17], { major: 8, okay: { kind: 'range', min: 8, max: 11 } })
    expect(r).toMatchObject({ reason: 'no-match', suggestion: j11 })
    expect(r.java).toBeUndefined()
    expect(r.ranked.map((x) => x.grade)).toEqual(['okay', 'bad'])
    expect(selectJava([broken], { major: 21 })).toMatchObject({ reason: 'no-valid-java' })
    expect(selectJava([], { major: 21 }).message).toMatch(/Java 21/)
  })

  it('honours an explicit match (Forge 17 pin, pack allow-list)', () => {
    expect(selectJava(all, { major: 17, match: { kind: 'exact', major: 17 } }).java).toBe(j17)
    expect(selectJava([j21, j25], { major: 17, match: { kind: 'exact', major: 17 } }).reason).toBe('no-match')
    expect(selectJava(all, { major: 8, match: { kind: 'oneOf', majors: [8, 17] } }).java).toBe(j8)
  })
})

describe('javaRequirementFor', () => {
  it('uses the version JSON: forward-compatible from 16, exact below', () => {
    expect(javaRequirementFor({ javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }, minecraftVersion: '1.21.4' })).toEqual({
      component: 'java-runtime-delta',
      majorVersion: 21,
      match: { kind: 'atLeast', major: 21 },
      okay: { kind: 'any' },
    })
    const legacy = javaRequirementFor({ javaVersion: { component: 'jre-legacy', majorVersion: 8 }, minecraftVersion: '1.12.2' })
    expect(legacy.match).toEqual({ kind: 'exact', major: 8 })
    expect(legacy.okay).toEqual({ kind: 'range', min: 8, max: 11 })
    expect(javaRequirementFor({ javaVersion: { majorVersion: 25 } }).component).toBe('java-runtime-epsilon')
  })

  it('pins Forge on 1.18 - 1.20.4 to exactly 17', () => {
    for (const mc of ['1.18.2', '1.19.4', '1.20', '1.20.4']) {
      expect(javaRequirementFor({ forge: true, minecraftVersion: mc, javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 } }).match).toEqual({ kind: 'exact', major: 17 })
    }
    expect(javaRequirementFor({ forge: true, minecraftVersion: '1.20.6', javaVersion: { component: 'java-runtime-delta', majorVersion: 21 } }).match).toEqual({ kind: 'atLeast', major: 21 })
    expect(javaRequirementFor({ forge: true, minecraftVersion: '1.19.2' })).toMatchObject({ component: 'java-runtime-gamma', majorVersion: 17 })
  })

  it('applies a pack allow-list', () => {
    expect(javaRequirementFor({ compatibleJavaMajors: [17, 21], javaVersion: { component: 'java-runtime-delta', majorVersion: 21 } })).toMatchObject({
      component: 'java-runtime-delta',
      majorVersion: 21,
      match: { kind: 'oneOf', majors: [17, 21] },
    })
    expect(javaRequirementFor({ compatibleJavaMajors: [21, 17], javaVersion: { component: 'jre-legacy', majorVersion: 8 } })).toMatchObject({ component: 'java-runtime-gamma', majorVersion: 17 })
    expect(javaRequirementFor({ compatibleJavaMajors: [11] })).toMatchObject({ component: '', majorVersion: 11 })
  })

  it('falls back by Minecraft era when no version JSON is available', () => {
    expect(javaRequirementFor({ minecraftVersion: '1.8.9' })).toMatchObject({ component: 'jre-legacy', majorVersion: 8, match: { kind: 'exact', major: 8 } })
    expect(javaRequirementFor({ minecraftVersion: '1.16.5' })).toMatchObject({ component: 'jre-legacy', match: { kind: 'range', min: 8, max: 16 } })
    expect(javaRequirementFor({ minecraftVersion: '26.1' })).toMatchObject({ majorVersion: 16, match: { kind: 'atLeast', major: 16 } })
  })

  it('classifies version ids, including year-based and snapshot ids', () => {
    expect(minecraftEra('1.12.2')).toBe('pre-1.13')
    expect(minecraftEra('b1.7.3')).toBe('pre-1.13')
    expect(minecraftEra('rd-132211')).toBe('pre-1.13')
    expect(minecraftEra('1.13')).toBe('1.13-1.16')
    expect(minecraftEra('1.16.5-rc1')).toBe('1.13-1.16')
    expect(minecraftEra('1.17')).toBe('1.17+')
    expect(minecraftEra('26.1')).toBe('1.17+')
    expect(minecraftEra('26.1-snapshot-2')).toBe('1.17+')
    expect(minecraftEra('24w14a')).toBe('1.17+')
    expect(minecraftEra('20w45a')).toBe('1.17+')
    expect(minecraftEra('20w14a')).toBe('1.13-1.16')
    expect(minecraftEra('17w43a')).toBe('1.13-1.16')
    expect(minecraftEra('17w31a')).toBe('pre-1.13')
    expect(minecraftEra('nonsense')).toBeUndefined()
  })

  it('matches majors', () => {
    expect(matchesMajor({ kind: 'atLeast', major: 17 }, 25)).toBe(true)
    expect(matchesMajor({ kind: 'exact', major: 8 }, 11)).toBe(false)
    expect(matchesMajor({ kind: 'range', min: 8, max: 16 }, 16)).toBe(true)
    expect(matchesMajor({ kind: 'any' }, 0)).toBe(false)
  })
})
