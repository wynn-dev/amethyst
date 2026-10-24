import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LWJGL2_NATIVES_MANIFEST_URL, Lwjgl2NativesSource } from './natives-source'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-natives-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const MANIFEST = {
  baseUrl: 'https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-v1/',
  artifacts: [{ name: 'lwjgl-platform', version: '2.9.2-nightly-20140822', url: 'lwjgl-platform-2.9.2-nightly-20140822-natives-macos-arm64.jar', sha256: 'a'.repeat(64), size: 1234 }],
}

describe('Lwjgl2NativesSource', () => {
  it('points at the natives-lwjgl2-v1 release', () => {
    expect(LWJGL2_NATIVES_MANIFEST_URL).toBe('https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-v1/manifest.json')
  })

  it('fetches, validates and caches the manifest on disk', async () => {
    let now = 1_000
    const fetchJson = vi.fn<() => Promise<unknown>>(async () => MANIFEST)
    const a = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, now: () => now })
    expect((await a.get()).artifacts).toHaveLength(1)
    expect(fetchJson).toHaveBeenCalledOnce()
    // A new instance (next session) reads the disk cache without fetching.
    const b = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson, now: () => now })
    expect((await b.get()).artifacts[0]?.sha256).toBe('a'.repeat(64))
    expect(fetchJson).toHaveBeenCalledOnce()
    // A day later it revalidates, and falls back to the stale copy when the fetch fails.
    now += 25 * 3600_000
    fetchJson.mockRejectedValueOnce(new Error('HTTP 503'))
    expect((await b.get()).artifacts).toHaveLength(1)
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

  it('rejects a malformed manifest as unavailable', async () => {
    const source = new Lwjgl2NativesSource({ cacheDir: dir, fetchJson: async () => ({ baseUrl: 'http://insecure/', artifacts: [] }) })
    await expect(source.get()).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
  })
})
