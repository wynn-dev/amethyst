import { describe, expect, it } from 'vitest'
import { createScrubber, MAX_SCRUBBED_LENGTH } from './scrub'

const scrub = createScrubber({ homeDir: '/Users/alexsmith', username: 'alexsmith', sensitive: ['Notch_Fan99'] })

describe('scrubber', () => {
  it('replaces the home directory with ~', () => {
    expect(scrub('/Users/alexsmith/Library/Application Support/Amethyst/settings.json')).toBe(
      '~/Library/Application Support/Amethyst/settings.json',
    )
    expect(scrub('file:///Users/alexsmith/x.js')).toBe('file://~/x.js')
  })

  it('replaces the home directory even when it contains spaces', () => {
    const s = createScrubber({ homeDir: '/Users/Alex Smith' })
    expect(s("open '/Users/Alex Smith/Documents/notes.txt'")).toBe("open '~/Documents/<redacted>.txt'")
  })

  it('replaces any other user home directory', () => {
    expect(scrub('/Users/someoneelse/foo and /home/bob/bar')).toBe('~/foo and ~/bar')
  })

  it('removes the OS username wherever it appears as a word', () => {
    expect(scrub('signed in as alexsmith on AlexSmith-MacBook')).toBe('signed in as <user> on <user>-MacBook')
    // Not inside other words.
    expect(scrub('alexsmithson')).toBe('alexsmithson')
  })

  it('ignores very short usernames to avoid mangling text', () => {
    expect(createScrubber({ username: 'al' })('al is an albatross')).toBe('al is an albatross')
  })

  it('removes registered sensitive strings, case-insensitively', () => {
    expect(scrub('Player notch_fan99 joined')).toBe('Player <redacted> joined')
    const s = createScrubber({})
    s.addSensitive('Herobrine')
    expect(s('hello Herobrine')).toBe('hello <redacted>')
  })

  it('removes emails', () => {
    expect(scrub('account a.b+c@example.co.uk failed')).toBe('account <email> failed')
  })

  it('removes dashed and undashed UUIDs (player ids)', () => {
    expect(scrub('profile 069a79f4-44e9-4726-a5be-fca90e38aaf5 missing')).toBe('profile <uuid> missing')
    expect(scrub('profile 069A79F444E94726A5BEFCA90E38AAF5 missing')).toBe('profile <uuid> missing')
  })

  it('removes JWTs and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(scrub(`token ${jwt} expired`)).toBe('token <token> expired')
    expect(scrub('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer <token>')
  })

  it('removes credentials in key=value, JSON and OAuth redirects', () => {
    expect(scrub('refresh_token=M.C5_BAY.0.U.-abc&x=1')).toBe('refresh_token=<redacted>&x=1')
    expect(scrub('{"accessToken": "abc123"}')).toBe('{"accessToken": "<redacted>"}')
    expect(scrub('http://localhost/cb?code=M.R3_BAY.c0de&state=xyz')).toBe('http://localhost/cb?code=<redacted>&state=<redacted>')
  })

  it('removes long hex strings and opaque tokens', () => {
    expect(scrub('sha1 2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e')).toBe('sha1 <hex>')
    expect(scrub('key phc_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 used')).toBe('key <token> used')
  })

  it('removes IPv4 and IPv6 addresses', () => {
    expect(scrub('connect ECONNREFUSED 192.168.1.20:25565')).toBe('connect ECONNREFUSED <ip>:25565')
    expect(scrub('from 2001:0db8:85a3:0000:0000:8a2e:0370:7334 and fe80::1 and ::1')).toBe('from <ip> and <ip> and <ip>')
  })

  it('keeps version numbers, error codes, line numbers and times', () => {
    expect(scrub('Minecraft 1.20.1 with Forge 47.2.0 failed: ENOENT at 12:34:56')).toBe(
      'Minecraft 1.20.1 with Forge 47.2.0 failed: ENOENT at 12:34:56',
    )
    expect(scrub("code: 'ENOENT', errno: -2")).toBe("code: 'ENOENT', errno: -2")
    expect(scrub('at load (app:///out/main/index.js:12:34)')).toBe('at load (app:///out/main/index.js:12:34)')
  })

  it('removes file and folder names inside user content folders, keeping the extension', () => {
    expect(scrub("ENOENT: open '/Users/alexsmith/Library/Application Support/Amethyst/instances/My Secret Pack/mods/Cool Mod 1.2.jar'")).toBe(
      "ENOENT: open '~/Library/Application Support/Amethyst/instances/<redacted>/mods/<redacted>.jar'",
    )
    expect(scrub('/x/.minecraft/saves/Our World/level.dat')).toBe('/x/.minecraft/saves/<redacted>/level.dat')
    expect(scrub('/x/screenshots/2026-01-01_10.00.00.png')).toBe('/x/screenshots/<redacted>.png')
    expect(scrub('/Users/alexsmith/Downloads/pack.mrpack')).toBe('~/Downloads/<redacted>.mrpack')
  })

  it('handles a realistic stack trace', () => {
    const stack = [
      "Error: EACCES: permission denied, open '/Users/alexsmith/Library/Application Support/Amethyst/instances/Alex SMP/options.txt'",
      '    at async open (node:internal/fs/promises:639:25)',
      '    at readOptions (/Applications/Amethyst.app/Contents/Resources/app.asar/out/main/runtime.js:1:2345)',
    ].join('\n')
    const out = scrub(stack)
    expect(out).not.toMatch(/alexsmith|Alex SMP/i)
    expect(out).toContain('instances/<redacted>/options.txt')
    expect(out).toContain('node:internal/fs/promises:639:25')
    expect(out).toContain('app.asar/out/main/runtime.js:1:2345')
  })

  it('truncates very long input', () => {
    expect(scrub('a '.repeat(MAX_SCRUBBED_LENGTH)).length).toBeLessThanOrEqual(MAX_SCRUBBED_LENGTH + 1)
  })
})
