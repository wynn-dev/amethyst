/* oxlint-disable no-await-in-loop -- backups are created in timestamp order */
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nbt, writeNbt } from '@amethyst/nbt'
import type { TaskContext } from '@amethyst/task'
import { openZip } from '@amethyst/zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { levelDat, makeWorld, makeZip, tempDir } from '../__fixtures__/build'
import { backupWorld, deleteBackup, exportWorld, importWorld, importWorldFolder, listBackups, listSaves, pruneBackups, readLevelDat, readSave, restoreBackup } from '../index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('level.dat', () => {
  it('reads the fields shown in the UI', async () => {
    const info = await readLevelDat(await levelDat({ levelName: 'Survival 😀' }))
    expect(info).toEqual({
      levelName: 'Survival 😀',
      versionName: '1.21.1',
      versionId: 3955,
      snapshot: false,
      dataVersion: 3955,
      gameType: 0,
      gameMode: 'survival',
      hardcore: false,
      difficulty: 'normal',
      difficultyLocked: false,
      cheats: true,
      seed: '-4172144997902289642',
      lastPlayed: 1_729_000_000_000,
      time: 24_000,
      dayTime: 6000,
      spawn: { x: 10, y: 64, z: -20 },
      gameRules: { doDaylightCycle: 'true', keepInventory: 'false' },
      serverBrands: ['fabric'],
      wasModded: true,
    })
  })

  it('handles pre-1.9 worlds (no Version, RandomSeed) without throwing', async () => {
    const root = nbt.compound({
      Data: nbt.compound({ LevelName: nbt.string('Old'), RandomSeed: nbt.long(12345n), GameType: nbt.int(1), hardcore: nbt.byte(1) }),
    })
    const info = await readLevelDat(await writeNbt({ root }, { compression: 'gzip' }))
    expect(info).toEqual({ levelName: 'Old', seed: '12345', gameType: 1, gameMode: 'creative', hardcore: true })
  })

  it('reads the newer difficulty_settings compound', async () => {
    const bytes = await levelDat({
      data: { Difficulty: nbt.byte(0), difficulty_settings: nbt.compound({ difficulty: nbt.string('hard'), hardcore: nbt.byte(1), locked: nbt.byte(1) }) },
    })
    expect(await readLevelDat(bytes)).toMatchObject({ difficulty: 'hard', hardcore: false, difficultyLocked: true })
  })

  it('rejects corrupt data with ENOT_A_WORLD', async () => {
    await expect(readLevelDat(Buffer.from([0x1f, 0x8b, 0, 1, 2]))).rejects.toMatchObject({ code: 'ENOT_A_WORLD' })
  })

  it('reads a save folder with icon and size, and lists saves', async () => {
    const saves = path.join(tmp, 'saves')
    await makeWorld(path.join(saves, 'World A'))
    await mkdir(path.join(saves, 'not a world'))
    await mkdir(path.join(saves, '.hidden'))
    const save = await readSave(path.join(saves, 'World A'), { computeSize: true })
    expect(save).toMatchObject({ folderName: 'World A', linked: false, iconPath: path.join(saves, 'World A', 'icon.png') })
    expect(save.sizeBytes).toBeGreaterThan(8192)
    const listed = await listSaves(saves)
    expect(listed.saves.map((s) => s.folderName)).toEqual(['World A'])
    expect(listed.invalid.map((i) => path.basename(i.path))).toEqual(['not a world'])
    expect(await listSaves(path.join(tmp, 'missing'))).toEqual({ saves: [], invalid: [] })
  })
})

const at = (min: number) => new Date(2026, 0, 1, 12, min, 0)

async function zipNames(file: string): Promise<string[]> {
  const z = await openZip(file)
  try {
    return (await z.entries()).map((e) => e.name).toSorted()
  } finally {
    await z.close()
  }
}

describe('export and import', () => {
  it('exports the folder that contains level.dat, as one top-level folder without session.lock', async () => {
    const world = await makeWorld(path.join(tmp, 'instance', 'saves', 'My World'))
    const out = path.join(tmp, 'out', 'My World.zip')
    const result = await exportWorld(world, out)
    expect(result).toMatchObject({ zipPath: out, fileCount: 3, skipped: [] })
    expect(await zipNames(out)).toEqual(['My World/icon.png', 'My World/level.dat', 'My World/region/r.0.0.mca'])
    // No snapshot folder is left behind.
    expect(await readdir(path.join(tmp, 'out'))).toEqual(['My World.zip'])
    await expect(exportWorld(path.join(tmp, 'instance'), path.join(tmp, 'x.zip'))).rejects.toMatchObject({ code: 'ENOT_A_WORLD' })
  })

  it('imports a zip whose level.dat is nested one level deep, with collision-free names', async () => {
    const saves = path.join(tmp, 'saves')
    const zip = await makeZip(path.join(tmp, 'Cool World.zip'), {
      'Inner/level.dat': await levelDat({ levelName: 'Cool' }),
      'Inner/region/r.0.0.mca': Buffer.alloc(100, 1),
      'Inner/session.lock': 'x',
      'Inner/.DS_Store': 'x',
      '__MACOSX/Inner/._level.dat': 'x',
      'readme.txt': 'outside the world root',
    })
    const first = await importWorld(zip, saves)
    expect(first).toMatchObject({ folderName: 'Cool World', level: { levelName: 'Cool' } })
    expect((await readdir(first.path)).toSorted()).toEqual(['level.dat', 'region'])
    await mkdir(path.join(saves, 'cool world (2)')) // case-insensitive collision
    const second = await importWorld(zip, saves)
    expect(second.folderName).toBe('Cool World (3)')
    expect((await readdir(saves)).toSorted()).toEqual(['Cool World', 'Cool World (3)', 'cool world (2)'])
  })

  it('imports a zip with level.dat at the root, and rejects archives without one', async () => {
    const saves = path.join(tmp, 'saves')
    const flat = await makeZip(path.join(tmp, 'flat.zip'), { 'level.dat': await levelDat(), 'data/x.dat': 'x' })
    const imported = await importWorld(flat, saves, { name: '../evil/name' })
    expect(imported.folderName).toBe('_evil_name')
    expect(path.dirname(imported.path)).toBe(saves)
    const none = await makeZip(path.join(tmp, 'none.zip'), { 'foo/bar.txt': 'x' })
    await expect(importWorld(none, saves)).rejects.toMatchObject({ code: 'ENOT_A_WORLD' })
    expect((await readdir(saves)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('round-trips export → import', async () => {
    const world = await makeWorld(path.join(tmp, 'a', 'Round'), { levelName: 'Round Trip' })
    const out = await exportWorld(world, path.join(tmp, 'round.zip'))
    const back = await importWorld(out.zipPath, path.join(tmp, 'b'))
    expect(back.level.levelName).toBe('Round Trip')
    expect(await readFile(path.join(back.path, 'region', 'r.0.0.mca'))).toEqual(await readFile(path.join(world, 'region', 'r.0.0.mca')))
  })

  it('imports a world folder by copying it', async () => {
    const src = await makeWorld(path.join(tmp, 'src', 'Folder World'))
    const imported = await importWorldFolder(src, path.join(tmp, 'saves'))
    expect(imported.folderName).toBe('Folder World')
    expect(await stat(path.join(imported.path, 'session.lock')).catch(() => undefined)).toBeUndefined()
  })
})

describe('backups', () => {
  it('backs up, lists and restores (replace) atomically', async () => {
    const saves = path.join(tmp, 'saves')
    const backups = path.join(tmp, 'backups', 'inst-1')
    const world = await makeWorld(path.join(saves, 'Main'), { levelName: 'Main World' })
    const backup = await backupWorld(world, backups, { reason: 'manual', now: new Date(2026, 9, 24, 13, 5, 9) })
    expect(backup).toMatchObject({
      id: '2026-10-24_13-05-09',
      world: 'Main',
      worldName: 'Main World',
      reason: 'manual',
      automatic: false,
      fileCount: 3,
      dataVersion: 3955,
      versionName: '1.21.1',
      skipped: 0,
    })
    expect(backup.path).toBe(path.join(backups, 'Main', '2026-10-24_13-05-09.zip'))
    const sidecar = JSON.parse(await readFile(path.join(backups, 'Main', '2026-10-24_13-05-09.json'), 'utf8'))
    expect(sidecar).toMatchObject({ reason: 'manual', world: 'Main', worldName: 'Main World', createdAt: new Date(2026, 9, 24, 13, 5, 9).toISOString(), size: backup.size })
    expect(await listBackups(backups)).toEqual([backup])

    // Damage the world, then restore over it.
    await writeFile(path.join(world, 'region', 'r.0.0.mca'), 'corrupted')
    await writeFile(path.join(world, 'junk.txt'), 'new file')
    const disposed: string[] = []
    const restored = await restoreBackup(backup, saves, {
      disposePrevious: async (dir) => {
        disposed.push(path.basename(dir))
        // The previous world is still on disk when it is handed over.
        expect((await stat(path.join(dir, 'junk.txt'))).isFile()).toBe(true)
        await rm(dir, { recursive: true })
      },
    })
    expect(restored).toMatchObject({ path: world, folderName: 'Main', level: { levelName: 'Main World' } })
    expect(disposed).toEqual(['Main.before-restore'])
    expect(await readFile(path.join(world, 'region', 'r.0.0.mca'))).toEqual(Buffer.alloc(8192, 7))
    expect((await readdir(saves)).toSorted()).toEqual(['Main'])
  })

  it('keeps the previous world when disposing of it fails, and supports copy mode', async () => {
    const saves = path.join(tmp, 'saves')
    const backups = path.join(tmp, 'backups')
    const world = await makeWorld(path.join(saves, 'W'))
    const backup = await backupWorld(world, backups)
    const kept = await restoreBackup(backup.path, saves, {
      disposePrevious: async () => {
        throw new Error('Trash unavailable')
      },
    })
    expect(kept.previousPath).toBe(path.join(saves, 'W.before-restore'))
    const copy = await restoreBackup(backup, saves, { mode: 'copy' })
    expect(copy.folderName).toMatch(/^W \(restored \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)$/)
    expect((await readdir(saves)).length).toBe(3)
  })

  it('leaves the current world untouched when the backup is invalid', async () => {
    const saves = path.join(tmp, 'saves')
    const world = await makeWorld(path.join(saves, 'Safe'))
    const fake = await makeZip(path.join(tmp, 'backups', 'Safe', 'fake.zip'), { 'nothing.txt': 'x' })
    await expect(restoreBackup(fake, saves)).rejects.toMatchObject({ code: 'ENOT_A_WORLD' })
    expect((await readdir(saves)).toSorted()).toEqual(['Safe'])
    expect((await stat(path.join(world, 'level.dat'))).isFile()).toBe(true)
  })

  it('prunes all but the N newest automatic backups per world, never manual ones', async () => {
    const saves = path.join(tmp, 'saves')
    const backups = path.join(tmp, 'backups')
    const a = await makeWorld(path.join(saves, 'A'))
    const b = await makeWorld(path.join(saves, 'B'))
    const manual = await backupWorld(a, backups, { reason: 'manual', now: at(0) })
    for (let i = 1; i <= 4; i++) await backupWorld(a, backups, { reason: 'pre-version-change', now: at(i) })
    for (let i = 1; i <= 2; i++) await backupWorld(b, backups, { reason: 'pre-modpack-update', now: at(i) })

    const removed = await pruneBackups(backups, { keep: 2 })
    expect(removed.map((r) => `${r.world}/${r.id}`).toSorted()).toEqual(['A/2026-01-01_12-01-00', 'A/2026-01-01_12-02-00'])
    const left = await listBackups(backups, 'A')
    expect(left.map((r) => r.id)).toEqual(['2026-01-01_12-04-00', '2026-01-01_12-03-00', manual.id])
    expect(await listBackups(backups, 'B')).toHaveLength(2)

    await deleteBackup(manual)
    expect(await readdir(path.join(backups, 'A'))).not.toContain(`${manual.id}.json`)
  })

  it('skips files that vanish while the game is running and reports progress', async () => {
    const world = await makeWorld(path.join(tmp, 'saves', 'Live'), { extra: { 'playerdata/p.dat': 'x', 'region/r.1.0.mca': 'y' } })
    const updates: [number, number | undefined, string | undefined][] = []
    let deleted = false
    const ctx: TaskContext = {
      id: 't',
      signal: new AbortController().signal,
      update(progress, total, message) {
        updates.push([progress, total, message])
        // The first update comes right after the world was listed: simulate an autosave deleting a file.
        if (!deleted) {
          deleted = true
          rmSync(path.join(world, 'region', 'r.1.0.mca'))
        }
      },
      advance() {},
      child: (_name, fn) => fn(ctx),
      throwIfAborted() {},
    }
    const backup = await backupWorld(world, path.join(tmp, 'bk'), { ctx })
    expect(backup.skipped).toBe(1)
    expect(await zipNames(backup.path)).toEqual(['Live/icon.png', 'Live/level.dat', 'Live/playerdata/p.dat', 'Live/region/r.0.0.mca'])
    expect(updates[0]?.[2]).toBe('Copying world')
    expect(updates.some(([, , m]) => m === 'Compressing world')).toBe(true)
  })

  it('gives same-second backups distinct ids and is cancellable', async () => {
    const world = await makeWorld(path.join(tmp, 'saves', 'S'))
    const now = new Date(2026, 1, 2, 3, 4, 5)
    const one = await backupWorld(world, path.join(tmp, 'bk'), { now })
    const two = await backupWorld(world, path.join(tmp, 'bk'), { now })
    expect([one.id, two.id]).toEqual(['2026-02-02_03-04-05', '2026-02-02_03-04-05-2'])
    const controller = new AbortController()
    controller.abort()
    await expect(backupWorld(world, path.join(tmp, 'bk'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
