/* oxlint-disable no-await-in-loop -- test fixtures are read sequentially */
/**
 * Interrupted commits (the runtime killed mid-commit), repeated rollbacks, and folders that are
 * symlinks out of the instance.
 */
import { chmod, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeMrpack, mrFile, read, sha, startServer, tempDir, writeTree, type TestServer } from './__fixtures__/build'
import { writeRecord } from './engine'
import {
  installModpack,
  listIncompleteOperations,
  readModpack,
  readModpackLock,
  recoverInterruptedCommits,
  resolveModpackFiles,
  rollbackModpackOperation,
  waitForCommits,
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
const DATA = { 'a.jar': 'mod A', 'b.jar': 'mod B' }

function localize(r: ResolvedModpack): void {
  for (const f of r.files) {
    f.downloads = f.downloads.map((u) => `${server.url}${new URL(u).pathname}`)
    const body = DATA[f.path.split('/').pop() as keyof typeof DATA]
    for (const u of f.downloads) server.serve(new URL(u).pathname, body)
  }
}

/** Commit order: the archive entries (config/x.toml, options.txt), then mods/a.jar, mods/b.jar. */
async function mrpack(name: string) {
  const file = await makeMrpack(path.join(tmp, `${name}.mrpack`), { files: [mrFile('mods/a.jar', DATA['a.jar']), mrFile('mods/b.jar', DATA['b.jar'])] }, {
    'overrides/config/x.toml': 'x = 1',
    'overrides/options.txt': 'pack options',
  })
  const manifest = await readModpack(file)
  const resolved = await resolveModpackFiles(manifest)
  localize(resolved)
  return { manifest, resolved }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await listFiles(dir)) if (!rel.startsWith('.amethyst/')) out[rel] = sha('sha1', await readFile(path.join(dir, rel)))
  return out
}

const USER = { 'mods/a.jar': 'user version of a', 'config/x.toml': 'user config', 'saves/w/level.dat': 'world' }

/**
 * Start an install over the user's files and "kill" it in the middle of the commit: it stops
 * before moving mods/b.jar (after config/x.toml, options.txt and mods/a.jar were moved), and the
 * instance folder is copied as it is at that moment. Returns the copy.
 */
async function crashMidCommit(name: string): Promise<{ crashed: string; release: () => void; pending: Promise<unknown> }> {
  const { manifest, resolved } = await mrpack(name)
  await writeTree(instance, USER)
  let reached!: () => void
  const atB = new Promise<void>((r) => (reached = r))
  let release!: () => void
  const hold = new Promise<void>((r) => (release = r))
  const pending = installModpack(manifest, resolved, {
    instanceDir: instance,
    download: download(),
    hooks: {
      beforeCommitFile: async (rel) => {
        if (rel !== 'mods/b.jar') return
        reached()
        await hold
      },
    },
  }).catch((e: unknown) => e)
  await atB
  const crashed = path.join(tmp, 'crashed')
  await cp(instance, crashed, { recursive: true })
  return { crashed, release, pending }
}

describe('interrupted commits', () => {
  it('rolls back a commit that was cut off, so the instance is exactly as before, and the install can resume', async () => {
    const { crashed, release, pending } = await crashMidCommit('crash')
    release()
    await pending
    // Half-committed: the pack's a.jar is in, the user's is in the backup.
    expect(await read(crashed, 'mods/a.jar')).toBe(DATA['a.jar'])
    expect(await listIncompleteOperations(crashed)).toMatchObject([{ kind: 'install', state: 'committing' }])

    expect(await recoverInterruptedCommits(crashed)).toHaveLength(1)
    expect(await snapshot(crashed)).toEqual(await snapshotOf(USER))
    expect(await readModpackLock(crashed)).toBeUndefined()
    expect(await readdir(path.join(crashed, '.amethyst/backups')).catch(() => [])).toEqual([])
    // Still resumable, never auto-resumed.
    expect(await listIncompleteOperations(crashed)).toMatchObject([{ kind: 'install', state: 'staging' }])
    expect(await recoverInterruptedCommits(crashed)).toEqual([])

    const { manifest, resolved } = await mrpack('crash')
    const result = await installModpack(manifest, resolved, { instanceDir: crashed, download: download() })
    expect(result.backedUp.toSorted()).toEqual(['config/x.toml', 'mods/a.jar'])
    expect(await read(crashed, `.amethyst/backups/${result.backupId}/mods/a.jar`)).toBe(USER['mods/a.jar'])
  })

  it('never overwrites a committing record: the next install undoes the interrupted commit first', async () => {
    const { crashed, release, pending } = await crashMidCommit('overwrite')
    release()
    await pending
    const { manifest, resolved } = await mrpack('overwrite')
    const result = await installModpack(manifest, resolved, { instanceDir: crashed, download: download() })
    // Without recovery, the pack's a.jar (moved in before the crash) would be "kept" and the
    // user's version stranded in an orphaned backup folder.
    expect(result.backedUp.toSorted()).toEqual(['config/x.toml', 'mods/a.jar'])
    expect(await read(crashed, `.amethyst/backups/${result.backupId}/mods/a.jar`)).toBe(USER['mods/a.jar'])
    expect(await readdir(path.join(crashed, '.amethyst/backups'))).toEqual([result.backupId])
    expect(await listIncompleteOperations(crashed)).toEqual([])
  })

  it('refuses to start over an interrupted commit it cannot undo, and keeps its record', async () => {
    const { crashed, release, pending } = await crashMidCommit('stuck')
    release()
    await pending
    await chmod(path.join(crashed, 'mods'), 0o555)
    try {
      const { manifest, resolved } = await mrpack('stuck')
      await expect(installModpack(manifest, resolved, { instanceDir: crashed, download: download() })).rejects.toThrow(/permission denied/i)
      expect(await listIncompleteOperations(crashed)).toMatchObject([{ state: 'committing' }])
    } finally {
      await chmod(path.join(crashed, 'mods'), 0o755)
    }
    await recoverInterruptedCommits(crashed)
    expect(await snapshot(crashed)).toEqual(await snapshotOf(USER))
  })

  it('undoes a commit that had moved every file (journal written) but not finished, including the lock', async () => {
    const { manifest, resolved } = await mrpack('finished')
    await writeTree(instance, USER)
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    // Killed after the journal and the lock were written, before the record was removed.
    await writeRecord(instance, {
      schemaVersion: 1,
      id: 'install-0123456789abcdef',
      kind: 'install',
      packSha1: manifest.sha1,
      createdAt: 1,
      state: 'committing',
      backupDir: `.amethyst/backups/${result.backupId}`,
      changes: result.installed.map((p) => ({ path: p, action: 'place', kind: 'file' })),
    })
    expect(await recoverInterruptedCommits(instance)).toEqual(['install-0123456789abcdef'])
    expect(await snapshot(instance)).toEqual(await snapshotOf(USER))
    expect(await readModpackLock(instance)).toBeUndefined()
    expect(await listIncompleteOperations(instance)).toEqual([])
  })

  it('lets shutdown wait (bounded) for a commit in progress', async () => {
    const { release, pending } = await crashMidCommit('shutdown')
    expect(await waitForCommits(30)).toBe(false)
    const waited = waitForCommits(5_000)
    release()
    expect(await waited).toBe(true)
    expect(await pending).toMatchObject({ backupId: expect.any(String) })
    expect(await waitForCommits(0)).toBe(true)
  })
})

describe('rolling back a backup', () => {
  it('refuses to roll back the same backup twice, so files the user changed since are kept', async () => {
    const { manifest, resolved } = await mrpack('twice')
    await writeTree(instance, { 'config/x.toml': 'user config' })
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    await writeTree(instance, { 'options.txt': 'user changed the pack options' })
    const first = await rollbackModpackOperation(instance, result.backupId)
    expect(first.displaced).toEqual(['options.txt'])
    const aside = `.amethyst/backups/${result.backupId}/rollback-displaced/options.txt`
    expect(await read(instance, aside)).toBe('user changed the pack options')

    // The user keeps playing and edits the restored config.
    await writeTree(instance, { 'config/x.toml': 'edited after the rollback', 'options.txt': 'new options' })
    const before = await snapshot(instance)
    await expect(rollbackModpackOperation(instance, result.backupId)).rejects.toMatchObject({ code: 'EALREADY_ROLLED_BACK' })
    expect(await snapshot(instance)).toEqual(before)
    expect(await read(instance, aside)).toBe('user changed the pack options')
  })

  it('never deletes a file set aside earlier', async () => {
    const { manifest, resolved } = await mrpack('aside')
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    const backup = path.join(instance, '.amethyst/backups', result.backupId)
    await writeTree(path.join(backup, 'rollback-displaced'), { 'options.txt': 'precious' })
    await writeTree(instance, { 'options.txt': 'edited' })
    await rollbackModpackOperation(instance, result.backupId)
    expect(await read(backup, 'rollback-displaced/options.txt')).toBe('precious')
    expect(await read(backup, 'rollback-displaced-2/options.txt')).toBe('edited')
  })
})

describe('symlinked folders', () => {
  it('refuses to install through a mods/ folder that links out of the instance, and writes nothing there', async () => {
    const elsewhere = path.join(tmp, 'elsewhere')
    await writeTree(elsewhere, { 'a.jar': 'not yours to replace' })
    await mkdir(instance, { recursive: true })
    await symlink(elsewhere, path.join(instance, 'mods'))
    const { manifest, resolved } = await mrpack('link')
    await expect(installModpack(manifest, resolved, { instanceDir: instance, download: download() })).rejects.toMatchObject({ code: 'EUNSAFE_PATH' })
    expect(await readdir(elsewhere)).toEqual(['a.jar'])
    expect(await read(elsewhere, 'a.jar')).toBe('not yours to replace')
    // Nothing moved; the operation is resumable once the link is gone.
    expect(await lstatOrUndefined(path.join(instance, 'config/x.toml'))).toBeUndefined()
    expect(await listIncompleteOperations(instance)).toMatchObject([{ state: 'staging' }])
  })

  it('refuses a .amethyst/ folder that links out of the instance before writing anything', async () => {
    const elsewhere = path.join(tmp, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    await mkdir(instance, { recursive: true })
    await symlink(elsewhere, path.join(instance, '.amethyst'))
    const { manifest, resolved } = await mrpack('dotlink')
    await expect(installModpack(manifest, resolved, { instanceDir: instance, download: download() })).rejects.toMatchObject({ code: 'EUNSAFE_PATH' })
    expect(await readdir(elsewhere)).toEqual([])
  })

  it('allows links that stay inside the instance', async () => {
    await mkdir(path.join(instance, 'real-mods'), { recursive: true })
    await symlink(path.join(instance, 'real-mods'), path.join(instance, 'mods'))
    const { manifest, resolved } = await mrpack('inside')
    await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    expect(await read(instance, 'real-mods/a.jar')).toBe(DATA['a.jar'])
  })

  it('refuses to roll back through a folder that became a link out of the instance', async () => {
    const { manifest, resolved } = await mrpack('rblink')
    const result = await installModpack(manifest, resolved, { instanceDir: instance, download: download() })
    const elsewhere = path.join(tmp, 'elsewhere')
    await cp(path.join(instance, 'mods'), elsewhere, { recursive: true })
    await rm(path.join(instance, 'mods'), { recursive: true })
    await symlink(elsewhere, path.join(instance, 'mods'))
    await expect(rollbackModpackOperation(instance, result.backupId)).rejects.toMatchObject({ code: 'EUNSAFE_PATH' })
    expect((await readdir(elsewhere)).toSorted()).toEqual(['a.jar', 'b.jar'])
    expect(await read(instance, 'options.txt')).toBe('pack options')
  })
})

async function snapshotOf(tree: Record<string, string>): Promise<Record<string, string>> {
  const dir = path.join(tmp, `expected-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  for (const [rel, data] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), data)
  }
  return snapshot(dir)
}
