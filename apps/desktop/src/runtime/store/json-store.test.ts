import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readInt, readString } from '../util/parse'
import { JsonDocument, nodeStoreFs, type DocumentSchema } from './json-store'

interface Doc {
  name: string
  count: number
}

const schema: DocumentSchema<Doc> = {
  version: 2,
  migrations: {
    // v1 called the field `title`.
    1: ({ title, ...rest }) => ({ ...rest, name: title }),
  },
  parse: (raw) => ({ name: readString(raw.name) ?? 'default', count: readInt(raw.count, 0) ?? 0 }),
  defaults: () => ({ name: 'default', count: 0 }),
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-store-'))
  file = path.join(dir, 'doc.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const read = async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>

describe('JsonDocument', () => {
  it('starts from defaults and writes atomically with a schema version', async () => {
    const doc = new JsonDocument(file, schema)
    expect((await doc.load()).outcome).toBe('missing')
    await doc.set({ name: 'a', count: 1 })
    expect(await read()).toEqual({ schemaVersion: 2, name: 'a', count: 1 })
    await doc.set({ name: 'b', count: 2 })
    // The previous good version is kept as a backup.
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toMatchObject({ name: 'a' })
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('survives a crash between writing the temp file and renaming it', async () => {
    const doc = new JsonDocument(file, schema)
    await doc.load()
    await doc.set({ name: 'good', count: 1 })

    // "Crash": the temp file is fully written, then the process dies before the rename (and
    // obviously never gets to clean up).
    const crashing = new JsonDocument(file, schema, {
      fs: {
        rename: async () => {
          throw Object.assign(new Error('killed'), { code: 'ECRASH' })
        },
        rm: async () => {},
      },
    })
    await crashing.load()
    await expect(crashing.set({ name: 'lost', count: 2 })).rejects.toMatchObject({ code: 'ECRASH' })
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(true)

    // After a restart the old content is intact and the leftover temp file is swept.
    const restarted = new JsonDocument(file, schema)
    const result = await restarted.load()
    expect(result).toMatchObject({ outcome: 'loaded', value: { name: 'good', count: 1 } })
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(false)
  })

  it('never overwrites an unreadable file with defaults: moves it aside and recovers the backup', async () => {
    const doc = new JsonDocument(file, schema, { now: () => 1234 })
    await doc.load()
    await doc.set({ name: 'v1', count: 1 })
    await doc.set({ name: 'v2', count: 2 })
    await writeFile(file, '{"name": "trunc') // truncated by another tool

    const reopened = new JsonDocument(file, schema, { now: () => 1234 })
    const result = await reopened.load()
    expect(result.outcome).toBe('recovered')
    expect(result.value).toEqual({ name: 'v1', count: 1 })
    expect(result.corruptPath).toBe(`${file}.corrupt-1234`)
    expect(await readFile(`${file}.corrupt-1234`, 'utf8')).toBe('{"name": "trunc')
  })

  it('falls back to defaults (keeping the corrupt copy) when the backup is unreadable too', async () => {
    await writeFile(file, 'garbage')
    await writeFile(`${file}.bak`, 'also garbage')
    const doc = new JsonDocument(file, schema, { now: () => 7 })
    const result = await doc.load()
    expect(result).toMatchObject({ outcome: 'reset', value: schema.defaults(), corruptPath: `${file}.corrupt-7` })
    expect(await readFile(`${file}.corrupt-7`, 'utf8')).toBe('garbage')
  })

  it('keeps an unreadable file in place and refuses writes in keep mode', async () => {
    await writeFile(file, '[1,2')
    const doc = new JsonDocument(file, schema, { onCorrupt: 'keep' })
    expect((await doc.load()).outcome).toBe('unreadable')
    expect(doc.readOnly).toBe(true)
    await expect(doc.set({ name: 'x', count: 0 })).rejects.toMatchObject({ code: 'EDOCUMENT_READONLY' })
    expect(await readFile(file, 'utf8')).toBe('[1,2')
    const moved = await doc.discardUnreadable()
    expect(moved).toMatch(/\.corrupt-\d+$/)
    await doc.set({ name: 'x', count: 0 })
    expect(await read()).toMatchObject({ name: 'x' })
  })

  it('never moves a good file aside or resets it when reading fails with an I/O error', async () => {
    const good = `${JSON.stringify({ schemaVersion: 2, name: 'mine', count: 3 })}\n`
    await writeFile(file, good)
    // EMFILE / EACCES / EIO say nothing about the content: even in move-aside mode the file stays.
    const doc = new JsonDocument(file, schema, {
      fs: {
        readFile: async () => {
          throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
        },
      },
    })
    const result = await doc.load()
    expect(result.outcome).toBe('unreadable')
    expect(result.corruptPath).toBeUndefined()
    expect(doc.readOnly).toBe(true)
    await expect(doc.set({ name: 'default', count: 0 })).rejects.toMatchObject({ code: 'EDOCUMENT_READONLY' })
    expect(await readFile(file, 'utf8')).toBe(good)
    expect((await readdir(dir)).filter((n) => n.includes('.corrupt-'))).toEqual([])
  })

  it('migrates older documents and parses fields leniently', async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, title: 'old', count: 'nope' }))
    const doc = new JsonDocument(file, schema)
    expect((await doc.load()).value).toEqual({ name: 'old', count: 0 })
  })

  it('serialises writes and coalesces bursts to the latest value', async () => {
    let writes = 0
    const doc = new JsonDocument(file, schema, {
      fs: {
        writeDurable: async (f, data, mode) => {
          writes++
          await new Promise((r) => setTimeout(r, 5))
          await nodeStoreFs.writeDurable(f, data, mode)
        },
      },
    })
    await doc.load()
    await Promise.all(Array.from({ length: 20 }, (_, i) => doc.set({ name: `n${i}`, count: i })))
    expect(await read()).toMatchObject({ name: 'n19', count: 19 })
    // The first write runs immediately; everything queued behind it collapses into one more.
    expect(writes).toBe(2)
  })
})
