/* oxlint-disable no-await-in-loop -- test fixtures are read sequentially */
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { ContentStore } from '@amethyst/content'
import { curseforgeFingerprintSync, type CurseForgeFingerprintMatches } from '@amethyst/marketplace'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { openZip } from '@amethyst/zip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sha, startServer, tempDir, writeTree, type TestServer } from './__fixtures__/build'
import { cfFile, cfMod, mockCurseForge, mockModrinth, mrVersion } from './__fixtures__/market'
import {
  exportCurseForge,
  exportModrinth,
  installModpack,
  isNeverExported,
  readModpack,
  resolveModpackFiles,
  stripOptionsText,
  writeModpackLock,
  type ExportOptions,
} from './index'
import { listFiles } from './util'

let server: TestServer
let client: HttpClient
let tmp: string
let source: string

beforeAll(async () => {
  server = await startServer()
  client = createHttpClient({ retry: { retries: 0 } })
})
afterAll(async () => {
  await client.close()
  await server.close()
})
beforeEach(async () => {
  tmp = await tempDir()
  source = path.join(tmp, 'source')
  await writeTree(source, {
    'mods/linked.jar': 'linked mod bytes',
    'mods/local.jar': 'a jar nobody hosts',
    'mods/fromcf.jar': 'curseforge only',
    'mods/clientonly.jar': 'client side only',
    'mods/notes.txt': 'not a jar',
    'resourcepacks/rp.zip': 'resource pack bytes',
    'config/a.toml': 'a = 1',
    'config/sub/b.json': '{"b":2}',
    'options.txt': 'version:3465\nlastServer:play.example.com\nfov:0.5\n',
    'logs/latest.log': 'log',
    'crash-reports/crash.txt': 'crash',
    'screenshots/s.png': 'png',
    'servers.dat': 'servers',
    '.amethyst/instance.json': '{}',
    'accounts.json': '{"token":"x"}',
    'config/api_token.txt': 'secret',
    'config/.DS_Store': 'junk',
    'saves/World/level.dat': 'not selected',
  })
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const INCLUDE = ['mods', 'resourcepacks/', 'config', 'options.txt', 'logs', 'crash-reports', 'screenshots', 'servers.dat', '.amethyst', 'accounts.json']

const base = (output: string): ExportOptions => ({
  output,
  name: 'My Pack',
  version: '1.2.3',
  author: 'me',
  summary: 'An export',
  minecraft: '1.20.1',
  loader: { id: 'fabric', version: '0.15.11' },
  include: INCLUDE,
  env: { 'mods/clientonly.jar': { server: 'unsupported' } },
})

/** rel → sha1 of the files a fresh install should reproduce. */
async function expectedFiles(stripped: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await listFiles(source)) {
    if (/^(logs|crash-reports|screenshots|saves|\.amethyst)\//.test(rel) || ['servers.dat', 'accounts.json', 'config/api_token.txt', 'config/.DS_Store'].includes(rel)) continue
    out[rel] = sha('sha1', rel === 'options.txt' ? stripped : await readFile(path.join(source, rel)))
  }
  return out
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await listFiles(dir)) if (!rel.startsWith('.amethyst/')) out[rel] = sha('sha1', await readFile(path.join(dir, rel)))
  return out
}

describe('exportModrinth', () => {
  it('links known files, embeds the rest, excludes private data, and round-trips', async () => {
    await writeModpackLock(source, {
      schemaVersion: 1,
      source: 'curseforge',
      pack: { name: 'x', version: '1', sha1: 'x', minecraft: '1.20.1', loader: null },
      installedAt: 0,
      files: [{ path: 'mods/fromcf.jar', hashes: { sha1: sha('sha1', 'curseforge only') }, size: 15, origin: { kind: 'curseforge', projectId: 1, fileId: 2 } }],
      deselected: [],
    })
    const linkedUrl = 'https://cdn.modrinth.com/data/AAAAAAAA/versions/BBBBBBBB/linked.jar'
    const modrinth = mockModrinth({
      [sha('sha1', 'linked mod bytes')]: mrVersion('AAAAAAAA', 'BBBBBBBB', linkedUrl, 'linked mod bytes'),
      [sha('sha1', 'resource pack bytes')]: mrVersion('CCCCCCCC', 'DDDDDDDD', 'https://cdn.modrinth.com/data/CCCCCCCC/versions/DDDDDDDD/rp.zip', 'resource pack bytes'),
      // A match whose only URL is on a disallowed host is embedded in strict mode.
      [sha('sha1', 'a jar nobody hosts')]: mrVersion('EEEEEEEE', 'FFFFFFFF', 'https://example.com/local.jar', 'a jar nobody hosts'),
    })
    const output = path.join(tmp, 'out', 'My Pack-1.2.3.mrpack')
    const result = await exportModrinth(source, { ...base(output), modrinth })

    expect(result.linked.toSorted()).toEqual(['mods/linked.jar', 'resourcepacks/rp.zip'])
    expect(result.embedded.map((e) => [e.path, e.reason]).toSorted()).toEqual([
      ['config/a.toml', 'not-linkable'],
      ['config/sub/b.json', 'not-linkable'],
      ['mods/clientonly.jar', 'no-match'],
      ['mods/fromcf.jar', 'no-match'],
      ['mods/local.jar', 'no-match'],
      ['mods/notes.txt', 'not-linkable'],
      ['options.txt', 'not-linkable'],
    ])
    expect(result.excluded.toSorted()).toEqual([
      '.amethyst/instance.json',
      '.amethyst/modpack.lock.json',
      'accounts.json',
      'config/.DS_Store',
      'config/api_token.txt',
      'crash-reports/crash.txt',
      'logs/latest.log',
      'screenshots/s.png',
      'servers.dat',
    ])
    expect(result.warnings.some((w) => w.includes('mods/fromcf.jar') && w.includes('CurseForge'))).toBe(true)

    // Read it back as a pack.
    const m = await readModpack(output)
    expect(m).toMatchObject({ format: 'modrinth', name: 'My Pack', version: '1.2.3', summary: 'An export', minecraft: '1.20.1', loader: { id: 'fabric', version: '0.15.11' } })
    expect(m.files).toEqual([
      { kind: 'modrinth', path: 'mods/linked.jar', hashes: { sha1: sha('sha1', 'linked mod bytes'), sha512: sha('sha512', 'linked mod bytes') }, size: 16, downloads: [linkedUrl], env: { client: 'required', server: 'required' } },
      expect.objectContaining({ path: 'resourcepacks/rp.zip', size: 19 }),
    ])
    expect(Object.fromEntries(m.overrides.map((o) => [o.path, o.layer]))).toEqual({
      'config/a.toml': 'overrides',
      'config/sub/b.json': 'overrides',
      'mods/clientonly.jar': 'client-overrides',
      'mods/fromcf.jar': 'overrides',
      'mods/local.jar': 'overrides',
      'mods/notes.txt': 'overrides',
      'options.txt': 'overrides',
    })
    const zip = await openZip(output)
    const stripped = await zip.readText('overrides/options.txt')
    const index = JSON.parse(await zip.readText('modrinth.index.json')) as { files: { fileSize: number; hashes: { sha512: string } }[] }
    await zip.close()
    expect(stripped).toBe('version:3465\nfov:0.5\n')
    expect(index.files.every((f) => f.fileSize > 0 && f.hashes.sha512.length === 128)).toBe(true)

    // Install the export into a fresh instance (linked files come from the store) and compare.
    const store = new ContentStore(path.join(tmp, 'store'))
    for (const data of ['linked mod bytes', 'resource pack bytes']) {
      await store.ingest(
        (async function* () {
          yield Buffer.from(data)
        })(),
      )
    }
    const target = path.join(tmp, 'target')
    await installModpack(m, await resolveModpackFiles(m), { instanceDir: target, store, download: { client } })
    expect(await snapshot(target)).toEqual(await expectedFiles(stripped))
  })

  it('embeds everything when no platform knows the files, and honours strict mode off', async () => {
    const output = path.join(tmp, 'plain.mrpack')
    const modrinth = mockModrinth({ [sha('sha1', 'a jar nobody hosts')]: mrVersion('EEEEEEEE', 'FFFFFFFF', 'https://example.com/local.jar', 'a jar nobody hosts') })
    const result = await exportModrinth(source, { ...base(output), include: ['mods/local.jar', 'mods/linked.jar'], strict: false, modrinth })
    expect(result.linked).toEqual(['mods/local.jar'])
    expect(result.embedded.map((e) => e.path)).toEqual(['mods/linked.jar'])
  })

  it('never exports launcher folders or credentials', () => {
    for (const p of ['.amethyst/x', 'versions/1.20.1/1.20.1.jar', 'libraries/a.jar', 'assets/x', 'natives/x', 'usercache.json', 'launcher_profiles.json', 'keys/id.pem', 'config/my_secret.cfg', 'accounts_v2.json', 'mods/.DS_Store']) {
      expect(isNeverExported(p)).toBe(true)
    }
    expect(isNeverExported('config/a.toml')).toBe(false)
    expect(stripOptionsText('a:1\r\nlastServer:x\r\nb:2', ['lastServer'])).toBe('a:1\r\nb:2')
  })

  it('rejects include paths outside the instance', async () => {
    await expect(exportModrinth(source, { ...base(path.join(tmp, 'x.mrpack')), include: ['../etc'] })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
  })
})

describe('exportCurseForge', () => {
  it('links fingerprint matches, embeds the rest, and round-trips', async () => {
    const linked = cfFile(500, 50, 'linked.jar', 'linked mod bytes')
    const rp = cfFile(600, 60, 'rp.zip', 'resource pack bytes')
    const calls: number[][] = []
    const curseforge = {
      async matchFingerprints(fps: number[]): Promise<CurseForgeFingerprintMatches> {
        calls.push(fps)
        const known = [linked, rp].filter((f) => fps.includes(f.fileFingerprint))
        return {
          isCacheBuilt: true,
          exactMatches: known.map((file) => ({ id: file.modId, file, latestFiles: [] })),
          exactFingerprints: known.map((f) => f.fileFingerprint),
          partialMatches: [],
          partialMatchFingerprints: {},
          installedFingerprints: [],
          unmatchedFingerprints: [],
        }
      },
    }
    const output = path.join(tmp, 'My Pack-1.2.3.zip')
    const result = await exportCurseForge(source, { ...base(output), loader: { id: 'neoforge', version: '20.4.237' }, curseforge })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(curseforgeFingerprintSync(Buffer.from('linked mod bytes')))
    expect(result.linked.toSorted()).toEqual(['mods/linked.jar', 'resourcepacks/rp.zip'])

    const m = await readModpack(output)
    expect(m).toMatchObject({ format: 'curseforge', name: 'My Pack', version: '1.2.3', author: 'me', loader: { id: 'neoforge', version: '20.4.237' } })
    expect(m.files).toEqual([
      { kind: 'curseforge', projectId: 50, fileId: 500, required: true },
      { kind: 'curseforge', projectId: 60, fileId: 600, required: true },
    ])
    const overridePaths = m.overrides.map((o) => o.path).toSorted()
    expect(overridePaths).toEqual(['config/a.toml', 'config/sub/b.json', 'mods/clientonly.jar', 'mods/fromcf.jar', 'mods/local.jar', 'mods/notes.txt', 'options.txt'])

    // Resolve against the mock API, download from the local server, compare with the source.
    const { client: cf } = mockCurseForge([linked, rp], [cfMod(50, 6), cfMod(60, 12)])
    const resolved = await resolveModpackFiles(m, { curseforge: cf })
    for (const f of resolved.files) {
      f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    }
    server.serve('/files/500/linked.jar', 'linked mod bytes')
    server.serve('/files/600/rp.zip', 'resource pack bytes')
    const target = path.join(tmp, 'target')
    await installModpack(m, resolved, { instanceDir: target, download: { client } })
    expect(await snapshot(target)).toEqual(await expectedFiles('version:3465\nfov:0.5\n'))
  })

  it('leaves server-only files out of the client pack and warns about Quilt', async () => {
    const result = await exportCurseForge(source, {
      ...base(path.join(tmp, 'q.zip')),
      include: ['mods/local.jar', 'config/a.toml'],
      loader: { id: 'quilt', version: '0.26.0' },
      env: { 'mods/local.jar': { client: 'unsupported' } },
    })
    expect(result.embedded.map((e) => e.path)).toEqual(['config/a.toml'])
    expect(result.warnings.some((w) => w.includes('Quilt'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('server-only'))).toBe(true)
    const m = await readModpack(path.join(tmp, 'q.zip'))
    expect(m.loader).toEqual({ id: 'quilt', version: '0.26.0' })
  })
})
