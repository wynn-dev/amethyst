/* oxlint-disable no-await-in-loop -- fixtures are written sequentially */
/** Test fixture builders: every jar, zip and level.dat used by the tests is generated here. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nbt, writeNbt, type NbtTag } from '@amethyst/nbt'
import { createZip } from '@amethyst/zip'

/** Entry contents: text (UTF-8) or raw bytes. */
export type Entries = Record<string, string | Uint8Array>

/** Write a zip/jar to `file` with `@amethyst/zip`'s `createZip`. */
export async function makeZip(file: string, entries: Entries): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  const w = createZip(file)
  for (const [name, data] of Object.entries(entries)) w.addBuffer(typeof data === 'string' ? Buffer.from(data) : data, name)
  await w.finish()
  return file
}

/** Build a zip and return its bytes (for nested jars). */
export async function zipBytes(dir: string, entries: Entries): Promise<Buffer> {
  const file = path.join(dir, `nested-${Math.random().toString(36).slice(2)}.jar`)
  await makeZip(file, entries)
  const bytes = await readFile(file)
  await rm(file)
  return bytes
}

/** Write files under `dir` (creating folders). */
export async function writeTree(dir: string, entries: Entries): Promise<void> {
  for (const [name, data] of Object.entries(entries)) {
    const p = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, data)
  }
}

/** Options for {@link levelDat}. */
export interface LevelDatSpec {
  levelName?: string
  data?: Record<string, NbtTag>
}

/** A gzip `level.dat` with a typical modern `Data` compound (override or add fields via `data`). */
export async function levelDat(spec: LevelDatSpec = {}): Promise<Buffer> {
  const data: Record<string, NbtTag> = {
    LevelName: nbt.string(spec.levelName ?? 'Test World'),
    DataVersion: nbt.int(3955),
    Version: nbt.compound({ Id: nbt.int(3955), Name: nbt.string('1.21.1'), Snapshot: nbt.byte(0) }),
    GameType: nbt.int(0),
    Difficulty: nbt.byte(2),
    DifficultyLocked: nbt.byte(0),
    hardcore: nbt.byte(0),
    allowCommands: nbt.byte(1),
    LastPlayed: nbt.long(1_729_000_000_000n),
    Time: nbt.long(24_000n),
    DayTime: nbt.long(6000n),
    SpawnX: nbt.int(10),
    SpawnY: nbt.int(64),
    SpawnZ: nbt.int(-20),
    WorldGenSettings: nbt.compound({ seed: nbt.long(-4_172_144_997_902_289_642n) }),
    GameRules: nbt.compound({ doDaylightCycle: nbt.string('true'), keepInventory: nbt.string('false') }),
    ServerBrands: nbt.list([nbt.string('fabric')]),
    WasModded: nbt.byte(1),
    ...spec.data,
  }
  return writeNbt({ root: nbt.compound({ Data: nbt.compound(data) }) }, { compression: 'gzip' })
}

/** Create a world folder with a level.dat, an icon and some region data. */
export async function makeWorld(dir: string, spec: LevelDatSpec & { extra?: Entries } = {}): Promise<string> {
  await writeTree(dir, {
    'level.dat': await levelDat(spec),
    'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'region/r.0.0.mca': Buffer.alloc(8192, 7),
    'session.lock': '☃',
    ...spec.extra,
  })
  return dir
}

/** A fresh temporary directory; remove it with `rm(dir, { recursive: true })`. */
export function tempDir(prefix = 'amethyst-content-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}
