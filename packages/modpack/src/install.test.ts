/* oxlint-disable no-await-in-loop -- test fixtures are read sequentially */
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { ContentStore } from '@amethyst/content'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeCfZip, makeMrpack, makeZip, mrFile, read, sha, startServer, tempDir, writeTree, type TestServer } from './__fixtures__/build'
import { cfFile, cfMod, mockCurseForge } from './__fixtures__/market'
import {
  discardIncompleteOperation,
  installModpack,
  listIncompleteOperations,
  readModpack,
  readModpackLock,
  resolveModpackFiles,
  rollbackModpackOperation,
  type ResolvedModpack,
} from './index'
import { listFiles, lstatOrUndefined } from './util'

let server: TestServer
let client: HttpClient
let tmp: string
let instance: string

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
  instance = path.join(tmp, 'instance')
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const download = () => ({ client, retry: { retries: 0 } })

/** Point every download at the local server and serve the bytes. */
function localize(r: ResolvedModpack, data: Record<string, string>): void {
  for (const f of r.files) {
    f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    const name = f.path.split('/').pop() as string
    const body = data[name]
    if (body !== undefined) for (const u of f.downloads) server.serve(new URL(u).pathname, body)
  }
}

/** rel path → sha1 of every file in `dir` (optionally without `.amethyst/`). */
async function snapshot(dir: string, withAmethyst = false): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await listFiles(dir)) {
    if (!withAmethyst && rel.startsWith('.amethyst/')) continue
    out[rel] = sha('sha1', await readFile(path.join(dir, rel)))
  }
  return out
}

const DATA = { 'a.jar': 'mod A', 'b.jar': 'mod B (optional)', 's.jar': 'server only', 'c.jar': 'mod C' }

async function mrpack(name = 'pack', extraFiles: object[] = []) {
  const file = await makeMrpack(
    path.join(tmp, `${name}.mrpack`),
    {
      files: [
        mrFile('mods/a.jar', DATA['a.jar']),
        mrFile('mods/b.jar', DATA['b.jar'], { env: { client: 'optional', server: 'optional' } }),
        mrFile('mods/s.jar', DATA['s.jar'], { env: { client: 'unsupported', server: 'required' } }),
        ...extraFiles,
      ],
    },
    { 'overrides/config/x.toml': 'x = 1', 'overrides/options.txt': 'base', 'client-overrides/options.txt': 'client' },
  )
  const manifest = await readModpack(file)
  const resolved = await resolveModpackFiles(manifest)
  localize(resolved, DATA)
  return { manifest, resolved }
}

describe('installModpack', () => {
  it('installs, honours env and the optional selection, and writes the lock', async () => {
    const { manifest, resolved } = await mrpack()
    const result = await installModpack(manifest, resolved, {
      instanceDir: instance,
      selectedOptional: [],
      download: download(),
      upstream: { kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'BBBBBBBB' },
    })
    expect(await snapshot(instance)).toEqual({
      'config/x.toml': sha('sha1', 'x = 1'),
      'mods/a.jar': sha('sha1', DATA['a.jar']),
      'options.txt': sha('sha1', 'client'),
    })
    expect(result.deselected).toEqual(['mods/b.jar'])
    expect(result.unresolved).toEqual([])

    const lock = await readModpackLock(instance)
    expect(lock).toMatchObject({
      schemaVersion: 1,
      source: 'modrinth',
      upstream: { kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'BBBBBBBB', packSha1: manifest.sha1 },
      pack: { name: 'Test Pack', version: '1.0.0', sha1: manifest.sha1, minecraft: '1.20.1', loader: { id: 'fabric', version: '0.15.11' } },
      deselected: ['mods/b.jar'],
    })
    const files = Object.fromEntries((lock?.files ?? []).map((f) => [f.path, f]))
    expect(Object.keys(files).toSorted()).toEqual(['config/x.toml', 'mods/a.jar', 'options.txt'])
    expect(files['mods/a.jar']).toMatchObject({ hashes: { sha1: sha('sha1', DATA['a.jar']), sha512: sha('sha512', DATA['a.jar']) }, origin: { kind: 'modrinth', projectId: 'AAAAAAAA' }, size: 5 })
    expect(files['options.txt']).toMatchObject({ hashes: { sha1: sha('sha1', 'client') }, origin: { kind: 'override', layer: 'client-overrides' } })
    // Workspace and operation record are gone; nothing is pending.
    expect(await lstatOrUndefined(path.join(instance, '.amethyst/staging'))).toBeUndefined()
    expect(await listIncompleteOperations(instance)).toEqual([])
  })

  it('changes nothing when a download fails, and resumes without re-downloading', async () => {
    const { manifest, resolved } = await mrpack('fail', [mrFile('mods/c.jar', DATA['c.jar'])])
    const cPath = new URL(resolved.files.find((f) => f.path === 'mods/c.jar')?.downloads[0] as string).pathname
    const aPath = new URL(resolved.files.find((f) => f.path === 'mods/a.jar')?.downloads[0] as string).pathname
    server.unserve(cPath)
    const aHits = server.hits(aPath)
    await writeTree(instance, { 'mods/user.jar': 'mine' })

    const err = await installModpack(manifest, resolved, { instanceDir: instance, download: download() }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'EINSTALL_INCOMPLETE', failed: [expect.objectContaining({ path: 'mods/c.jar' })] })
    expect(await snapshot(instance)).toEqual({ 'mods/user.jar': sha('sha1', 'mine') })
    expect(await readModpackLock(instance)).toBeUndefined()
    expect(await listIncompleteOperations(instance)).toMatchObject([{ kind: 'install', state: 'staging', packSha1: manifest.sha1 }])

    server.serve(cPath, DATA['c.jar'])
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(result.installed.toSorted()).toEqual(['config/x.toml', 'mods/a.jar', 'mods/b.jar', 'mods/c.jar', 'options.txt'])
    expect(server.hits(aPath) - aHits).toBe(1)
    expect(await read(instance, 'mods/user.jar')).toBe('mine')
  })

  it('rolls back a failed commit and leaves the instance as it was', async () => {
    const { manifest, resolved } = await mrpack('rollback')
    await writeTree(instance, { 'mods/a.jar': 'user version of a', 'config/x.toml': 'user config', 'saves/w/level.dat': 'world' })
    const before = await snapshot(instance, true)
    let n = 0
    const err = await installModpack(manifest, resolved, {
      instanceDir: instance,
      download: download(),
      hooks: {
        beforeCommitFile: () => {
          if (++n === 3) throw new Error('disk on fire')
        },
      },
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'ECOMMIT' })
    const after = await snapshot(instance, true)
    for (const k of Object.keys(after)) if (k.startsWith('.amethyst/')) delete after[k]
    expect(after).toEqual(before)
    expect(await readModpackLock(instance)).toBeUndefined()

    // The record survives for Resume / Discard; discarding leaves the instance unchanged.
    expect(await listIncompleteOperations(instance)).toHaveLength(1)
    await discardIncompleteOperation(instance, (await listIncompleteOperations(instance))[0]?.id as string)
    expect(await listIncompleteOperations(instance)).toEqual([])
    expect(await snapshot(instance)).toEqual(before)

    // A later attempt re-stages what the rollback consumed and succeeds.
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(result.backedUp.toSorted()).toEqual(['config/x.toml', 'mods/a.jar'])
    expect(await read(instance, 'mods/a.jar')).toBe(DATA['a.jar'])
  })

  it('honours cancellation', async () => {
    const { manifest, resolved } = await mrpack('cancel')
    const controller = new AbortController()
    controller.abort()
    await expect(installModpack(manifest, resolved, { instanceDir: instance, download: download(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('backs up differing files and can be rolled back explicitly', async () => {
    const { manifest, resolved } = await mrpack('backup')
    await writeTree(instance, { 'config/x.toml': 'user config' })
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(result.backedUp).toEqual(['config/x.toml'])
    expect(await read(instance, `.amethyst/backups/${result.backupId}/config/x.toml`)).toBe('user config')
    expect(await read(instance, 'config/x.toml')).toBe('x = 1')

    const rb = await rollbackModpackOperation(instance, result.backupId)
    expect(rb.restored).toEqual(['config/x.toml'])
    expect(await snapshot(instance)).toEqual({ 'config/x.toml': sha('sha1', 'user config') })
    expect(await readModpackLock(instance)).toBeUndefined()
  })

  it('uses the content store before downloading and feeds it with new mods', async () => {
    const { manifest, resolved } = await mrpack('store')
    const store = new ContentStore(path.join(tmp, 'store'))
    await store.ingest((async function* () {
      yield Buffer.from(DATA['a.jar'])
    })())
    const aPath = new URL(resolved.files.find((f) => f.path === 'mods/a.jar')?.downloads[0] as string).pathname
    server.unserve(aPath)
    await installModpack(manifest, resolved, { instanceDir: instance, store, download: download() })
    expect(await read(instance, 'mods/a.jar')).toBe(DATA['a.jar'])
    expect(await store.has(sha('sha1', DATA['b.jar']))).toBe(true)
    server.serve(aPath, DATA['a.jar'])
  })
})

describe('CurseForge manual files', () => {
  it('installs everything else, lists blocked files, and accepts the user download by hash', async () => {
    const worldZip = await makeZip(path.join(tmp, 'w.zip'), { 'My World/level.dat': 'level', 'My World/region/r.0.0.mca': 'region' })
    const worldBytes = await readFile(worldZip)
    const files = [cfFile(1, 10, 'free.jar', 'free'), cfFile(2, 20, 'blocked.jar', 'blocked bytes', null), cfFile(3, 30, 'Adventure.zip', worldBytes)]
    const { client: curseforge } = mockCurseForge(files, [cfMod(10, 6), cfMod(20, 6, 'Blocked'), cfMod(30, 17)])
    const zip = await makeCfZip(path.join(tmp, 'cf.zip'), { files: files.map((f) => ({ projectID: f.modId, fileID: f.id })) }, { 'overrides/config/c.cfg': 'cfg' })
    const manifest = await readModpack(zip)
    const resolved = await resolveModpackFiles(manifest, { curseforge })
    for (const f of resolved.files) f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    server.serve('/files/1/free.jar', 'free')
    server.serve('/files/3/Adventure.zip', worldBytes)

    const first = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(first.unresolved.map((u) => u.fileName)).toEqual(['blocked.jar'])
    expect(await read(instance, '.amethyst/unresolved.json')).toContain('blocked.jar')
    expect(await read(instance, 'mods/free.jar')).toBe('free')
    expect(await read(instance, 'saves/Adventure/level.dat')).toBe('level')
    expect(await read(instance, 'saves/Adventure/region/r.0.0.mca')).toBe('region')
    expect(await read(instance, 'config/c.cfg')).toBe('cfg')

    await writeTree(tmp, { 'dl/blocked.jar': 'tampered bytes', 'dl/renamed (1).jar': 'blocked bytes' })
    const second = await installModpack(manifest, resolved, {
      instanceDir: instance,
      download: download(),
      manualFiles: [path.join(tmp, 'dl/blocked.jar'), path.join(tmp, 'dl/renamed (1).jar')],
    })
    expect(second.installed).toEqual(['mods/blocked.jar'])
    expect(second.rejectedManualFiles).toEqual([expect.objectContaining({ file: path.join(tmp, 'dl/blocked.jar') })])
    expect(second.unresolved).toEqual([])
    expect(await read(instance, 'mods/blocked.jar')).toBe('blocked bytes')
    expect(await lstatOrUndefined(path.join(instance, '.amethyst/unresolved.json'))).toBeUndefined()
    const lock = await readModpackLock(instance)
    expect(lock?.files.find((f) => f.path === 'mods/blocked.jar')?.origin).toEqual({ kind: 'manual', projectId: 20, fileId: 2 })
    expect(lock?.files.find((f) => f.path === 'saves/Adventure')).toMatchObject({ kind: 'world' })
  })
})

describe('placing manual files later', () => {
  it('touches only the missing files: configs changed since the install are not reverted', async () => {
    const files = [cfFile(1, 10, 'free.jar', 'free'), cfFile(2, 20, 'blocked.jar', 'blocked bytes', null)]
    const { client: curseforge } = mockCurseForge(files, [cfMod(10, 6), cfMod(20, 6, 'Blocked')])
    const zip = await makeCfZip(path.join(tmp, 'cf.zip'), { files: files.map((f) => ({ projectID: f.modId, fileID: f.id })) }, { 'overrides/config/c.cfg': 'pack default', 'overrides/options.txt': 'pack options' })
    const manifest = await readModpack(zip)
    const resolved = await resolveModpackFiles(manifest, { curseforge })
    for (const f of resolved.files) f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    server.serve('/files/1/free.jar', 'free')
    const upstream = { kind: 'curseforge' as const, projectId: 99, fileId: 999 }
    await installModpack(manifest, resolved, { instanceDir: instance, download: download(), upstream })

    // The user plays: the game rewrites options and a config, and a mod is updated by hand.
    await writeTree(instance, { 'options.txt': 'user options', 'config/c.cfg': 'user tuned', 'mods/free.jar': 'free (user update)' })
    await writeTree(tmp, { 'dl/blocked.jar': 'blocked bytes' })
    const result = await installModpack(manifest, resolved, {
      instanceDir: instance,
      download: download(),
      manualFiles: [path.join(tmp, 'dl/blocked.jar')],
      only: ['mods/blocked.jar'],
    })
    expect(result.installed).toEqual(['mods/blocked.jar'])
    expect(result.backedUp).toEqual([])
    expect(await read(instance, 'options.txt')).toBe('user options')
    expect(await read(instance, 'config/c.cfg')).toBe('user tuned')
    expect(await read(instance, 'mods/free.jar')).toBe('free (user update)')
    expect(await read(instance, 'mods/blocked.jar')).toBe('blocked bytes')
    const lock = await readModpackLock(instance)
    expect(lock?.upstream).toMatchObject(upstream)
    // The lock still knows the pack's own versions of the untouched files (so the next update sees the user's changes).
    expect(Object.fromEntries((lock?.files ?? []).map((f) => [f.path, f.hashes.sha1]))).toEqual({
      'config/c.cfg': sha('sha1', 'pack default'),
      'mods/blocked.jar': sha('sha1', 'blocked bytes'),
      'mods/free.jar': sha('sha1', 'free'),
      'options.txt': sha('sha1', 'pack options'),
    })
  })
})

describe('path collisions on a case- and normalisation-insensitive volume', () => {
  it('keeps one target per APFS path: client-overrides beat overrides beat manifest files', async () => {
    const nfc = 'config/café.txt'
    const nfd = 'config/café.txt'
    const file = await makeMrpack(
      path.join(tmp, 'collide.mrpack'),
      { files: [mrFile('mods/Foo.jar', 'manifest jar')] },
      { 'overrides/mods/foo.jar': 'override jar', [`overrides/${nfd}`]: 'base', [`client-overrides/${nfc.toUpperCase()}`]: 'client' },
    )
    const manifest = await readModpack(file)
    const resolved = await resolveModpackFiles(manifest)
    localize(resolved, { 'Foo.jar': 'manifest jar' })
    await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    const lock = await readModpackLock(instance)
    expect(lock?.files.map((f) => [f.path, f.origin.kind]).toSorted()).toEqual([
      [nfc.toUpperCase(), 'override'],
      ['mods/foo.jar', 'override'],
    ])
    expect(await read(instance, 'mods/foo.jar')).toBe('override jar')
    expect(await read(instance, nfc)).toBe('client')
  })
})

describe('download verification', () => {
  it('checks a CurseForge file that has no digest by its fingerprint, and never installs a mismatch', async () => {
    const file = { ...cfFile(9, 90, 'nohash.jar', 'real bytes!'), hashes: [] }
    const { client: curseforge } = mockCurseForge([file], [cfMod(90, 6)])
    const zip = await makeCfZip(path.join(tmp, 'nohash.zip'), { files: [{ projectID: 90, fileID: 9 }] })
    const manifest = await readModpack(zip)
    const resolved = await resolveModpackFiles(manifest, { curseforge })
    expect(resolved.files[0]?.hashes).toEqual({})
    for (const f of resolved.files) f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)

    server.serve('/files/9/nohash.jar', 'fake bytes!')
    const err = await installModpack(manifest, resolved, { instanceDir: instance, download: download() }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'EINSTALL_INCOMPLETE', failed: [expect.objectContaining({ path: 'mods/nohash.jar', reason: expect.stringContaining('fingerprint') })] })
    expect(await lstatOrUndefined(path.join(instance, 'mods/nohash.jar'))).toBeUndefined()

    const noId = { ...resolved, files: resolved.files.map((f) => ({ ...f, fingerprint: undefined })) }
    const err2 = await installModpack(manifest, noId, { instanceDir: instance, download: download() }).catch((e: unknown) => e)
    expect(err2).toMatchObject({ code: 'EINSTALL_INCOMPLETE', failed: [expect.objectContaining({ reason: expect.stringContaining('no checksum') })] })

    server.serve('/files/9/nohash.jar', 'real bytes!')
    await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(await read(instance, 'mods/nohash.jar')).toBe('real bytes!')
  })
})
