/**
 * Packaging and release configuration that only matters in the signed, Finder-launched app, so
 * no unit of code exercises it: pin it here (known-issues §1 #781, #1765, #925; lesson 12).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const desktop = path.resolve(import.meta.dirname, '../..')
const repo = path.resolve(desktop, '../..')
const read = (...p: string[]) => readFileSync(path.join(...p), 'utf8')

/** The value of a `key: value` line in a YAML file (unquoted), or undefined. */
const yamlValue = (yaml: string, key: string) => new RegExp(`^\\s*${key}:\\s*['"]?(.*?)['"]?\\s*$`, 'm').exec(yaml)?.[1]

describe('macOS packaging', () => {
  const builder = read(desktop, 'electron-builder.yml')
  const entitlements = read(desktop, 'build', 'entitlements.mac.plist')
  const entitled = (key: string) => new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`).test(entitlements)

  it('signs with the hardened runtime and notarizes', () => {
    expect(yamlValue(builder, 'hardenedRuntime')).toBe('true')
    expect(yamlValue(builder, 'notarize')).toBe('true')
    expect(entitled('com.apple.security.cs.allow-jit')).toBe(true)
  })

  it('lets games ask for the microphone (voice-chat mods) and the local network (LAN worlds)', () => {
    // Amethyst is the TCC responsible process for the Java child: without these macOS denies silently.
    expect(yamlValue(builder, 'NSMicrophoneUsageDescription')?.length).toBeGreaterThan(20)
    expect(entitled('com.apple.security.device.audio-input')).toBe(true)
    expect(yamlValue(builder, 'NSLocalNetworkUsageDescription')?.length).toBeGreaterThan(20)
  })
})

describe('release workflows', () => {
  it('bound every smoke test of the app with a timeout, so a hung window fails the run', () => {
    for (const file of ['ci.yml', 'nightly.yml']) {
      const steps = read(repo, '.github', 'workflows', file).split(/\n {6}- /)
      const smoke = steps.filter((s) => s.includes('AMETHYST_SMOKE'))
      expect({ file, count: smoke.length > 0 }).toEqual({ file, count: true })
      for (const step of smoke) expect({ file, step: step.split('\n')[0], timeout: /timeout-minutes:\s*\d+/.test(step) }).toMatchObject({ timeout: true })
    }
  })
})
