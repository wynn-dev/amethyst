import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetUrl } from '@shared/paths'
import { isInside, parseRange, resolveAssetPath } from './asset-path'
import { serveAssetRequest } from './asset-protocol'

const ROOT = '/Users/me/Library/Application Support/Amethyst'

describe('resolveAssetPath', () => {
  it('serves images and videos inside the data root', () => {
    expect(resolveAssetPath(ROOT, assetUrl('cache/icons/ab12.png'))).toEqual({ ok: true, path: `${ROOT}/cache/icons/ab12.png`, mime: 'image/png', immutable: true })
    expect(resolveAssetPath(ROOT, assetUrl('instances/My Pack/icon.png', 123))).toMatchObject({ ok: true, path: `${ROOT}/instances/My Pack/icon.png`, immutable: false })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/theme-media/x.MP4')).toMatchObject({ ok: true, mime: 'video/mp4' })
    expect(resolveAssetPath(ROOT, assetUrl('instances/Café/icon.webp'))).toMatchObject({ ok: true, path: `${ROOT}/instances/Café/icon.webp` })
  })

  it('rejects traversal in every encoding', () => {
    // Encoded separators, NUL, hidden folders and empty segments are refused outright.
    for (const url of [
      'amethyst-asset://data/instances/%2e%2e%2f%2e%2e%2fx.png',
      'amethyst-asset://data/instances/..%2F..%2Fx.png',
      'amethyst-asset://data/instances/..%5c..%5cx.png',
      'amethyst-asset://data/instances/a%00.png',
      'amethyst-asset://data/instances//x.png',
      'amethyst-asset://data/instances/My%20Pack/.amethyst/x.png',
      'amethyst-asset://data/../secrets/a.png',
    ]) {
      expect({ url, ok: resolveAssetPath(ROOT, url).ok }).toEqual({ url, ok: false })
    }
    // Dot segments (literal or %2e-encoded) are collapsed by the URL parser; whatever is left
    // must still resolve inside the data root.
    for (const url of [
      'amethyst-asset://data/../../../etc/x.png',
      'amethyst-asset://data/%2e%2e/%2e%2e/etc/passwd.png',
      'amethyst-asset://data/instances/%2E%2E/%2E%2E/%2E%2E/x.png',
      'amethyst-asset://data/instances/./../x.png',
    ]) {
      const r = resolveAssetPath(ROOT, url)
      expect({ url, safe: !r.ok || isInside(ROOT, r.path) }).toEqual({ url, safe: true })
    }
  })

  it('refuses secrets, non-media files, other hosts and schemes', () => {
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/secrets/abc.png')).toEqual({ ok: false, status: 403 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/SECRETS/abc.png')).toEqual({ ok: false, status: 403 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/settings.json')).toEqual({ ok: false, status: 403 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/index.sqlite')).toEqual({ ok: false, status: 403 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/accounts.json.bak')).toEqual({ ok: false, status: 403 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://other/cache/icons/a.png')).toEqual({ ok: false, status: 400 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://user:pw@data/cache/icons/a.png')).toEqual({ ok: false, status: 400 })
    expect(resolveAssetPath(ROOT, 'file:///etc/passwd')).toEqual({ ok: false, status: 400 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/')).toEqual({ ok: false, status: 404 })
    expect(resolveAssetPath(ROOT, 'not a url')).toEqual({ ok: false, status: 400 })
    expect(resolveAssetPath(ROOT, 'amethyst-asset://data/%E0%A4%A.png')).toEqual({ ok: false, status: 400 })
  })
})

describe('parseRange', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=5-1', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
  })
})

describe('serveAssetRequest', () => {
  it('serves files with ranges and refuses symlinks that escape the data root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'amethyst-asset-'))
    try {
      const root = path.join(base, 'data')
      await mkdir(path.join(root, 'cache', 'icons'), { recursive: true })
      await writeFile(path.join(root, 'cache', 'icons', 'a.png'), '0123456789')
      await writeFile(path.join(base, 'outside.png'), 'secret')
      await symlink(path.join(base, 'outside.png'), path.join(root, 'cache', 'icons', 'evil.png'))
      await symlink(path.join(root, 'cache', 'icons', 'a.png'), path.join(root, 'cache', 'icons', 'alias.png'))

      const full = await serveAssetRequest(root, assetUrl('cache/icons/a.png'), null)
      expect(full.status).toBe(200)
      expect(full.headers.get('content-type')).toBe('image/png')
      expect(full.headers.get('cache-control')).toContain('immutable')
      expect(await full.text()).toBe('0123456789')

      const part = await serveAssetRequest(root, assetUrl('cache/icons/a.png'), 'bytes=2-4')
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
      expect(await part.text()).toBe('234')
      expect((await serveAssetRequest(root, assetUrl('cache/icons/a.png'), 'bytes=50-')).status).toBe(416)

      expect((await serveAssetRequest(root, assetUrl('cache/icons/evil.png'), null)).status).toBe(403)
      expect((await serveAssetRequest(root, assetUrl('cache/icons/alias.png'), null)).status).toBe(200)
      expect((await serveAssetRequest(root, assetUrl('cache/icons/missing.png'), null)).status).toBe(404)
      expect((await serveAssetRequest(root, 'amethyst-asset://data/../outside.png', null)).status).toBe(404)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
