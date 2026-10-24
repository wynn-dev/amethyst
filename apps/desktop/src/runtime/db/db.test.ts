import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createQueryHandlers, openDatabase } from './engine'
import { testDbClient } from './test-utils'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-db-'))
  file = path.join(dir, 'index.sqlite')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const rec = (sha1: string) => ({ ino: 1, size: 10, mtimeMs: 5, parserVersion: 1, sha1, record: { hashes: { sha1 } } })

describe('engine', () => {
  it('opens in WAL mode and runs batched placement writes', () => {
    const { db } = openDatabase(file)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const q = createQueryHandlers(db)
    expect(q['placements.apply']({ dir: '/i/mods', upserts: [['/i/mods/a.jar', rec('a')], ['/i/mods/b.jar', rec('b')]], deletes: [], now: 1 })).toEqual({
      upserted: 2,
      deleted: 0,
    })
    q['placements.apply']({ dir: '/i/mods', upserts: [], deletes: ['/i/mods/a.jar'], now: 2 })
    expect(q['placements.listDir']({ dir: '/i/mods' })).toEqual([['/i/mods/b.jar', { hashes: { sha1: 'b' } }]])
    q['placements.apply']({ dir: '/i/other/mods', upserts: [['/i/other/mods/c.jar', rec('c')]], deletes: [], now: 2 })
    expect(q['placements.deleteUnder']({ prefix: '/i/mods' })).toEqual({ deleted: 1 })
    expect(q['placements.listDir']({ dir: '/i/other/mods' })).toHaveLength(1)
    db.close()
  })

  it('keeps install provenance over hash lookups and clears negative lookups', () => {
    const { db } = openDatabase(file)
    const q = createQueryHandlers(db)
    q['lookups.put']({ sha1s: ['h'], platform: 'modrinth', now: 10 })
    expect(q['lookups.fresh']({ sha1s: ['h', 'x'], platform: 'modrinth', since: 5 })).toEqual(['h'])
    q['sources.put']({ rows: [{ sha1: 'h', platform: 'modrinth', projectId: 'AAAAAAAA', versionId: 'BBBBBBBB', confidence: 'manifest', resolvedAt: 1 }] })
    q['sources.put']({ rows: [{ sha1: 'h', platform: 'modrinth', projectId: 'CCCCCCCC', versionId: 'DDDDDDDD', confidence: 'hash', resolvedAt: 2 }] })
    expect(q['sources.get']({ sha1s: ['h'] })).toMatchObject([{ projectId: 'AAAAAAAA', confidence: 'manifest' }])
    expect(q['lookups.fresh']({ sha1s: ['h'], platform: 'modrinth', since: 5 })).toEqual([])
    db.close()
  })

  it('prunes the response cache by expiry and size', () => {
    const { db } = openDatabase(file)
    const q = createQueryHandlers(db)
    q['cache.put']({ entries: [{ key: 'old', value: 1, expiresAt: 5 }, { key: 'a', value: 'x'.repeat(100), expiresAt: 50 }, { key: 'b', value: 'y'.repeat(100), expiresAt: 60 }] })
    expect(q['cache.prune']({ now: 10, maxBytes: 150 })).toEqual({ deleted: 2 })
    expect(q['cache.load']({ now: 10, limit: 10 }).map((e) => e.key)).toEqual(['b'])
    db.close()
  })

  it('moves a corrupt database aside and starts fresh', async () => {
    await writeFile(file, 'this is definitely not sqlite'.repeat(200))
    const { db, healed } = openDatabase(file, { now: () => 42 })
    expect(healed).toEqual([`${file}.42.bak`])
    expect(createQueryHandlers(db)['meta.stats']({})).toMatchObject({ placements: 0, schemaVersion: 1 })
    db.close()
    expect(await readdir(dir)).toContain('index.sqlite.42.bak')
  })
})

describe('DbClient', () => {
  it('answers typed queries through the worker protocol', async () => {
    const { client } = testDbClient(file)
    expect((await client.open()).schemaVersion).toBe(1)
    await client.query('fingerprints.put', { entries: [['abc', 123]] })
    expect(await client.query('fingerprints.get', { sha1s: ['abc', 'zzz'] })).toEqual([['abc', 123]])
    await expect(client.query('nope' as 'meta.stats', {})).rejects.toMatchObject({ code: 'EDB_UNKNOWN_QUERY' })
    await client.close()
    await expect(client.query('meta.stats', {})).rejects.toMatchObject({ code: 'EDB_CLOSED' })
  })

  it('fails in-flight queries when the worker crashes, then restarts it', async () => {
    const { client, workers } = testDbClient(file)
    await client.open()
    await client.query('fingerprints.put', { entries: [['abc', 1]] })
    const first = workers[0]
    if (!first) throw new Error('no worker')
    // Post a query and kill the worker before it can answer.
    const inflight = client.query('meta.stats', {})
    first.crash()
    await expect(inflight).rejects.toMatchObject({ code: 'EDB_RESTARTED' })
    // The next query transparently gets a fresh worker; the data is still there (it is on disk).
    expect(await client.query('fingerprints.get', { sha1s: ['abc'] })).toEqual([['abc', 1]])
    expect(workers.length).toBeGreaterThanOrEqual(2)
    await client.close()
  })
})
