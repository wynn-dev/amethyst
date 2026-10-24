import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeMrpack, mrFile, read, sha, startServer, tempDir, writeTree, type Entries, type TestServer } from './__fixtures__/build'
import {
  applyModpackUpdate,
  installModpack,
  planModpackUpdate,
  readModpack,
  readModpackLock,
  resolveModpackFiles,
  rollbackModpackUpdate,
} from './index'
import { listFiles } from './util'

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

/** Build, read and resolve a pack whose mods are served by the local server under `/<tag>/<name>`. */
async function pack(tag: string, mods: Record<string, string>, overrides: Entries, optional: string[] = []) {
  const files = Object.entries(mods).map(([name, data]) => {
    const f = mrFile(`mods/${name}`, data, optional.includes(name) ? { env: { client: 'optional', server: 'optional' } } : {})
    f.downloads = [`https://cdn.modrinth.com/data/AAAAAAAA/versions/${tag.padEnd(8, 'x').slice(0, 8)}/${name}`]
    return f
  })
  const file = await makeMrpack(path.join(tmp, `${tag}.mrpack`), { versionId: tag, files }, Object.fromEntries(Object.entries(overrides).map(([k, v]) => [`overrides/${k}`, v])))
  const manifest = await readModpack(file)
  const resolved = await resolveModpackFiles(manifest)
  for (const f of resolved.files) {
    f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    server.serve(new URL(f.downloads[0] as string).pathname, mods[f.path.slice('mods/'.length)] as string)
  }
  return { manifest, resolved }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await listFiles(dir)) if (!rel.startsWith('.amethyst/')) out[rel] = sha('sha1', await readFile(path.join(dir, rel)))
  return out
}

const paths = (rows: { path: string }[]) => rows.map((r) => r.path).toSorted()

/** v1 installed with the optional mod deselected, then changed by the user; v2 resolved and planned. */
async function scenario() {
  const v1 = await pack('v1', { 'a.jar': 'a v1', 'b.jar': 'b optional', 'c.jar': 'c v1' }, { 'config/x.toml': 'x v1', 'config/y.toml': 'y', 'config/z.toml': 'z v1' }, ['b.jar'])
  await installModpack(v1.manifest, v1.resolved, { instanceDir: instance, selectedOptional: [], download: download() })
  // The user edits two pack configs and adds files of their own.
  await writeTree(instance, {
    'config/x.toml': 'x edited by user',
    'config/z.toml': 'z edited by user',
    'config/new.toml': 'user made this first',
    'config/user.toml': 'user only',
    'mods/user.jar': 'user mod',
  })
  const v2 = await pack(
    'v2',
    { 'a.jar': 'a v2', 'b.jar': 'b optional', 'd.jar': 'd new' },
    { 'config/x.toml': 'x v2', 'config/y.toml': 'y', 'config/new.toml': 'pack new' },
    ['b.jar'],
  )
  const lock = await readModpackLock(instance)
  const plan = await planModpackUpdate(lock, v2.manifest, v2.resolved, instance)
  return { v1, v2, lock, plan }
}

describe('planModpackUpdate', () => {
  it('computes the three-way diff from hashes', async () => {
    const { plan } = await scenario()
    expect(paths(plan.add)).toEqual(['mods/d.jar'])
    expect(paths(plan.update)).toEqual(['mods/a.jar'])
    expect(paths(plan.remove)).toEqual(['mods/c.jar'])
    expect(paths(plan.keep)).toEqual(['config/y.toml'])
    expect(plan.conflicts.map((c) => [c.path, c.conflict]).toSorted()).toEqual([
      ['config/new.toml', 'unmanaged-replaced'],
      ['config/x.toml', 'modified-replaced'],
      ['config/z.toml', 'modified-removed'],
    ])
    // Deselected optional files stay deselected; user-added files are not in the plan at all.
    expect(plan.deselected).toEqual(['mods/b.jar'])
    const all = [...plan.add, ...plan.update, ...plan.remove, ...plan.keep, ...plan.conflicts].map((c) => c.path)
    expect(all).not.toContain('mods/user.jar')
    expect(all).not.toContain('config/user.toml')
    expect(all).not.toContain('mods/b.jar')
    expect(plan.runtime.from).toEqual({ minecraft: '1.20.1', loader: { id: 'fabric', version: '0.15.11' } })
  })

  it('adds a deselected optional file only when the user selects it', async () => {
    const { v2, lock } = await scenario()
    const plan = await planModpackUpdate(lock, v2.manifest, v2.resolved, instance, { selectedOptional: ['mods/b.jar'] })
    expect(paths(plan.add)).toEqual(['mods/b.jar', 'mods/d.jar'])
    expect(plan.deselected).toEqual([])
  })

  it('treats every differing file as a conflict when there is no lock', async () => {
    const v1 = await pack('nolock', { 'a.jar': 'a v1' }, { 'config/x.toml': 'x v1' })
    await writeTree(instance, { 'mods/a.jar': 'something else', 'config/x.toml': 'x v1' })
    const plan = await planModpackUpdate(undefined, v1.manifest, v1.resolved, instance)
    expect(plan.conflicts.map((c) => [c.path, c.conflict])).toEqual([['mods/a.jar', 'unmanaged-replaced']])
    expect(paths(plan.keep)).toEqual(['config/x.toml'])
  })
})

describe('applyModpackUpdate', () => {
  it('applies the diff, backs up replaced and removed files and never touches user files', async () => {
    const { plan, v2 } = await scenario()
    const result = await applyModpackUpdate(plan, { download: download(), upstream: { kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'v2xxxxxx' } })
    expect(await snapshot(instance)).toEqual({
      'config/new.toml': sha('sha1', 'pack new'),
      'config/user.toml': sha('sha1', 'user only'),
      'config/x.toml': sha('sha1', 'x v2'),
      'config/y.toml': sha('sha1', 'y'),
      'mods/a.jar': sha('sha1', 'a v2'),
      'mods/d.jar': sha('sha1', 'd new'),
      'mods/user.jar': sha('sha1', 'user mod'),
    })
    const backup = `.amethyst/backups/${result.backupId}`
    expect(await read(instance, `${backup}/config/x.toml`)).toBe('x edited by user')
    expect(await read(instance, `${backup}/config/z.toml`)).toBe('z edited by user')
    expect(await read(instance, `${backup}/config/new.toml`)).toBe('user made this first')
    expect(await read(instance, `${backup}/mods/a.jar`)).toBe('a v1')
    expect(await read(instance, `${backup}/mods/c.jar`)).toBe('c v1')
    expect(result.backedUp.toSorted()).toEqual(['config/new.toml', 'config/x.toml', 'config/z.toml', 'mods/a.jar', 'mods/c.jar'])

    const lock = await readModpackLock(instance)
    expect(lock?.pack.sha1).toBe(v2.manifest.sha1)
    expect(lock?.upstream).toEqual({ kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'v2xxxxxx', packSha1: v2.manifest.sha1 })
    expect(lock?.deselected).toEqual(['mods/b.jar'])
    expect(lock?.files.map((f) => f.path).toSorted()).toEqual(['config/new.toml', 'config/x.toml', 'config/y.toml', 'mods/a.jar', 'mods/d.jar'])
  })

  it('leaves excluded rows exactly as they are', async () => {
    const { plan } = await scenario()
    const result = await applyModpackUpdate(plan, { download: download(), exclude: ['mods/c.jar', 'config/x.toml'] })
    expect(result.excluded.toSorted()).toEqual(['config/x.toml', 'mods/c.jar'])
    expect(await read(instance, 'mods/c.jar')).toBe('c v1')
    expect(await read(instance, 'config/x.toml')).toBe('x edited by user')
  })

  it('changes nothing when a download fails, then resumes', async () => {
    const { plan } = await scenario()
    const before = await snapshot(instance)
    const lockBefore = await readModpackLock(instance)
    const source = plan.add[0]?.target?.source
    if (source?.type !== 'download') throw new Error('expected a download')
    const dPath = new URL(source.urls[0] as string).pathname
    server.unserve(dPath)
    await expect(applyModpackUpdate(plan, { download: download() })).rejects.toMatchObject({ code: 'EINSTALL_INCOMPLETE', failed: [expect.objectContaining({ path: 'mods/d.jar' })] })
    expect(await snapshot(instance)).toEqual(before)
    expect(await readModpackLock(instance)).toEqual(lockBefore)

    server.serve(dPath, 'd new')
    const result = await applyModpackUpdate(plan, { download: download() })
    expect(result.added).toEqual(['mods/d.jar'])
  })

  it('rolls back a failed commit', async () => {
    const { plan } = await scenario()
    const before = await snapshot(instance)
    let n = 0
    await expect(
      applyModpackUpdate(plan, {
        download: download(),
        hooks: {
          beforeCommitFile: () => {
            if (++n === 5) throw new Error('EIO')
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ECOMMIT' })
    expect(await snapshot(instance)).toEqual(before)
  })

  it('restores the previous version with rollbackModpackUpdate', async () => {
    const { plan, lock } = await scenario()
    const before = await snapshot(instance)
    const result = await applyModpackUpdate(plan, { download: download() })
    const rb = await rollbackModpackUpdate(instance, result.backupId)
    expect(rb.displaced).toEqual([])
    expect(await snapshot(instance)).toEqual(before)
    expect(await readModpackLock(instance)).toEqual(lock)
  })
})
