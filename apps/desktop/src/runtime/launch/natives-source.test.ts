import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LWJGL2_ARM64_SOURCE, findLwjgl2Artifact, lwjgl2ArtifactUrl } from '@amethyst/game'
import { LWJGL2_NATIVES_MANIFEST_URL, Lwjgl2NativesSource } from './natives-source'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-natives-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const PINNED = DEFAULT_LWJGL2_ARM64_SOURCE.artifacts.find((a) => a.version === '2.9.2-nightly-20140822')!
const MIRROR = 'https://mirror.example/lwjgl-platform-2.9.2.jar'
/** A remote manifest that moves one pinned jar to another host (same sha256 and size). */
const MANIFEST = {
  baseUrl: 'https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-v1/',
  artifacts: [{ ...PINNED, url: MIRROR }],
}
const urlOf = (s: Awaited<ReturnType<Lwjgl2NativesSource['get']>>, version: string): string => lwjgl2ArtifactUrl(s, findLwjgl2Artifact(s, 'lwjgl-platform', version)!)

describe('Lwjgl2NativesSource', () => {
  it('points at the natives-lwjgl2-v1 release', () => {
    expect(LWJGL2_NATIVES_MANIFEST_URL).toBe('https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-v1/manifest.json')
  })

  it('fetches, validates and caches the manifest on disk', async () => {
    let now = 1_000
    const fetchJson = vi.fn<() => Promise<unknown>>(async () => MANIFEST)
    const a = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, now: () => now })
    expect(urlOf(await a.get(), PINNED.version)).toBe(MIRROR)
    expect(fetchJson).toHaveBeenCalledOnce()
    // A new instance (next session) reads the disk cache without fetching.
    const b = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, now: () => now })
    expect(urlOf(await b.get(), PINNED.version)).toBe(MIRROR)
    expect(fetchJson).toHaveBeenCalledOnce()
    // A day later it revalidates, and falls back to the stale copy when the fetch fails.
    now += 25 * 3600_000
    fetchJson.mockRejectedValueOnce(new Error('HTTP 503'))
    expect(urlOf(await b.get(), PINNED.version)).toBe(MIRROR)
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('fails with ENATIVES_UNAVAILABLE (not a crash) when the release is missing', async () => {
    const fetchJson = vi.fn<() => Promise<unknown>>(async () => {
      throw Object.assign(new Error('HTTP 404'), { code: 'EHTTP' })
    })
    const source = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson })
    await expect(source.get()).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE', details: { reason: 'manifest-unavailable' } })
    // Not retried on every launch.
    await expect(source.get()).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
    expect(fetchJson).toHaveBeenCalledOnce()
  })

  it('uses the pinned release at once (offline too) and caches the fetched manifest for next time', async () => {
    let fail = true
    const fetchJson = vi.fn<() => Promise<unknown>>(async () => {
      if (fail) throw new Error('offline')
      return MANIFEST
    })
    const now = 1_000
    const a = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, fallback: DEFAULT_LWJGL2_ARM64_SOURCE, now: () => now })
    expect(await a.get()).toBe(DEFAULT_LWJGL2_ARM64_SOURCE)
    fail = false
    const b = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, fallback: DEFAULT_LWJGL2_ARM64_SOURCE, now: () => now })
    expect(await b.get()).toBe(DEFAULT_LWJGL2_ARM64_SOURCE)
    await vi.waitFor(async () => expect((await new Lwjgl2NativesSource({ cacheDir: dir, fetchJson: async () => ({}), now: () => now }).get()).artifacts.some((x) => x.url === MIRROR)).toBe(true))
  })

  it('never lets a fetched or cached manifest change the pinned sha256s (only where a pinned jar is fetched from)', async () => {
    const evil = {
      baseUrl: 'https://evil.example/',
      artifacts: [
        // A different jar for a pinned version: ignored, the pinned entry stays.
        { ...PINNED, url: 'evil.jar', sha256: 'b'.repeat(64) },
        // A version that is not pinned at all: dropped.
        { name: 'lwjgl-platform', version: '9.9.9', url: 'new.jar', sha256: 'c'.repeat(64), size: 10 },
      ],
    }
    const source = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson: async () => evil })
    const got = await source.get()
    expect(got.artifacts.map((a) => [a.name, a.version, a.sha256, a.size])).toEqual(DEFAULT_LWJGL2_ARM64_SOURCE.artifacts.map((a) => [a.name, a.version, a.sha256, a.size]))
    expect(urlOf(got, PINNED.version)).toBe(lwjgl2ArtifactUrl(DEFAULT_LWJGL2_ARM64_SOURCE, PINNED))
    expect(JSON.stringify(got)).not.toContain('evil')

    // A cache file written by an older build (or tampered with) is restricted the same way.
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'lwjgl2-arm64.json'), JSON.stringify({ v: 1, url: LWJGL2_NATIVES_MANIFEST_URL, fetchedAt: Date.now(), source: evil }))
    const cached = await new Lwjgl2NativesSource({ cacheDir: dir, fetchJson: async () => ({}) }).get()
    expect(cached.artifacts.find((a) => a.version === PINNED.version)?.sha256).toBe(PINNED.sha256)
    expect(JSON.stringify(cached)).not.toContain('evil')
  })

  it('rejects a malformed manifest as unavailable', async () => {
    const source = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson: async () => ({ baseUrl: 'http://insecure/', artifacts: [] }) })
    await expect(source.get()).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
  })
})
