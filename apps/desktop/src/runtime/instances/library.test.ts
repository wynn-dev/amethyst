import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryStore } from './library'

let dir: string
let file: string
let events: number
const existing = new Set(['a', 'b', 'c'])

const store = () =>
  new LibraryStore(file, {
    emit: (event) => {
      if (event === 'library:changed') events++
    },
    exists: (id) => existing.has(id),
  })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-library-'))
  file = path.join(dir, 'library.json')
  events = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LibraryStore', () => {
  it('pins, folders and memberships persist and announce changes', async () => {
    const s = store()
    await s.load()
    expect(s.get()).toEqual({ folders: [], pinned: [], folderOf: {} })
    await s.setPinned('a', true)
    await s.setPinned('b', true)
    await s.setPinned('a', false)
    const f = await s.createFolder('  Modded  ')
    expect(f.name).toBe('Modded')
    const g = await s.createFolder('modded')
    expect(g.name).toBe('modded (2)')
    await s.moveToFolder('c', f.id)
    await s.updateFolder(f.id, { expanded: false })
    await s.flush()
    expect(events).toBe(7)

    const reloaded = store()
    await reloaded.load()
    expect(reloaded.get()).toEqual({
      folders: [
        { id: f.id, name: 'Modded', expanded: false },
        { id: g.id, name: 'modded (2)', expanded: true },
      ],
      pinned: ['b'],
      folderOf: { c: f.id },
    })
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1)
  })

  it('deleting a folder moves its instances back to the top level', async () => {
    const s = store()
    await s.load()
    const f = await s.createFolder('Old')
    await s.moveToFolder('a', f.id)
    await s.moveToFolder('b', f.id)
    await s.moveToFolder('b', null)
    expect(s.get().folderOf).toEqual({ a: f.id })
    await s.deleteFolder(f.id)
    expect(s.get()).toEqual({ folders: [], pinned: [], folderOf: {} })
  })

  it('hides instances that no longer exist and validates input', async () => {
    const s = store()
    await s.load()
    await s.setPinned('c', true)
    const f = await s.createFolder('X')
    await s.moveToFolder('c', f.id)
    existing.delete('c')
    try {
      expect(s.get().pinned).toEqual([])
      expect(s.get().folderOf).toEqual({})
      await expect(s.setPinned('c', true)).rejects.toMatchObject({ code: 'ENOT_FOUND' })
      await expect(s.moveToFolder('a', 'nope')).rejects.toMatchObject({ code: 'ENOT_FOUND' })
      await expect(s.createFolder('   ')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
      await expect(s.updateFolder(f.id, { name: 'x'.repeat(65) })).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
      await expect(s.updateFolder('nope', { expanded: true })).rejects.toMatchObject({ code: 'ENOT_FOUND' })
    } finally {
      existing.add('c')
    }
  })
})
