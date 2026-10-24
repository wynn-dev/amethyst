import { describe, expect, it } from 'vitest'
import { FIXTURE_VERSIONS } from './__fixtures__/helpers'
import { resolveLibraries } from './libraries'
import { resolveVersion } from './resolve'
import { darwinToMacosVersion, evaluateRules, normalizeArch, type Platform } from './rules'
import type { Rule } from './schema'

const arm64: Platform = { name: 'osx', version: '14.4', arch: 'arm64' }
const x64: Platform = { name: 'osx', version: '14.4', arch: 'x64' }
const win = (version: string): Platform => ({ name: 'windows', version, arch: 'x64' })

describe('evaluateRules', () => {
  it('allows when there are no rules and otherwise lets the last applicable rule win', () => {
    expect(evaluateRules(undefined, arm64)).toBe(true)
    expect(evaluateRules([], arm64)).toBe(true)
    const r: Rule[] = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]
    expect(evaluateRules(r, arm64)).toBe(false)
    expect(evaluateRules(r, { ...arm64, name: 'linux' })).toBe(true)
    expect(evaluateRules([{ action: 'allow', os: { name: 'windows' } }], arm64)).toBe(false)
  })

  it('matches the os version regex against the product version', () => {
    const r: Rule[] = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx', version: '^10\\.5\\.\\d$' } }]
    expect(evaluateRules(r, arm64)).toBe(true)
    expect(evaluateRules(r, { ...arm64, version: '10.5.8' })).toBe(false)
    // An invalid regex never matches instead of throwing.
    expect(evaluateRules([{ action: 'allow', os: { version: '(' } }], arm64)).toBe(false)
  })

  it('evaluates 26.x versionRange (min inclusive, max exclusive)', () => {
    const zgc: Rule[] = [{ action: 'allow', os: { name: 'windows', versionRange: { min: '10.0.17134' } } }]
    const g1: Rule[] = [{ action: 'allow', os: { name: 'windows', versionRange: { max: '10.0.17134' } } }]
    expect(evaluateRules(zgc, win('10.0.17134'))).toBe(true)
    expect(evaluateRules(g1, win('10.0.17134'))).toBe(false)
    expect(evaluateRules(g1, win('10.0.10240'))).toBe(true)
  })

  it('uses the JVM arch; Mojang x86 means a 32-bit JVM only', () => {
    const x86: Rule[] = [{ action: 'allow', os: { arch: 'x86' } }]
    expect(evaluateRules(x86, arm64)).toBe(false)
    expect(evaluateRules(x86, x64)).toBe(false)
    expect(evaluateRules(x86, { ...x64, arch: 'x86' })).toBe(true)
    expect(evaluateRules([{ action: 'allow', os: { arch: 'aarch64' } }], arm64)).toBe(true)
    expect(evaluateRules([{ action: 'allow', os: { arch: 'x86_64' } }], arm64)).toBe(false)
    expect(evaluateRules([{ action: 'allow', os: { arch: 'amd64' } }], x64)).toBe(true)
  })

  it('treats features by value, not by key presence', () => {
    const demo: Rule[] = [{ action: 'allow', features: { is_demo_user: true } }]
    expect(evaluateRules(demo, arm64, {})).toBe(false)
    expect(evaluateRules(demo, arm64, { is_demo_user: false })).toBe(false)
    expect(evaluateRules(demo, arm64, { is_demo_user: true })).toBe(true)
    expect(evaluateRules([{ action: 'allow', features: { has_custom_resolution: false } }], arm64, {})).toBe(true)
  })

  it('normalizes architecture names', () => {
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('x86_64')).toBe('x64')
    expect(normalizeArch('ia32')).toBe('x86')
    expect(normalizeArch('ppc')).toBeUndefined()
  })

  it('maps Darwin releases to macOS versions', () => {
    expect(darwinToMacosVersion('22.6.0')).toBe('13.6')
    expect(darwinToMacosVersion('24.1.0')).toBe('15.1')
    expect(darwinToMacosVersion('25.0.0')).toBe('26.0')
  })
})

describe('library rules on arm64 vs x64 JVMs', () => {
  it('1.16.5 keeps LWJGL 3.2.1 on macOS and drops the 3.2.2 entries (any JVM arch)', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.16.5')
    for (const p of [arm64, x64]) {
      const lwjgl = resolveLibraries(v, p).libraries.filter((l) => l.coordinate.group === 'org.lwjgl')
      expect(new Set(lwjgl.map((l) => l.coordinate.version))).toEqual(new Set(['3.2.1']))
    }
  })

  it('1.19.4 lists both macOS natives jars for either JVM; windows/linux ones are dropped', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.19.4')
    for (const p of [arm64, x64]) {
      const classifiers = resolveLibraries(v, p)
        .libraries.filter((l) => l.coordinate.artifact === 'lwjgl')
        .map((l) => l.coordinate.classifier)
      expect(classifiers).toEqual([undefined, 'natives-macos', 'natives-macos-arm64'])
    }
  })

  it('JVM arguments gated on arch x86 are dropped for 64-bit JVMs', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    const gated = v.arguments.jvm.filter((a) => typeof a !== 'string' && a.rules?.some((r) => r.os?.arch === 'x86'))
    expect(gated.length).toBeGreaterThan(0)
    expect(gated.every((a) => typeof a !== 'string' && !evaluateRules(a.rules, arm64))).toBe(true)
  })
})
