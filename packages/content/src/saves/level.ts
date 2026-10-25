/* oxlint-disable no-await-in-loop -- directory walks are sequential to bound open file handles */
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { readNbt, type NbtCompound, type NbtTag } from '@amethyst/nbt'
import { ContentError, isAbortError, throwIfAborted, wrapFsError } from '../errors'

/** Game mode ids stored in `Data.GameType`. */
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'
/** Difficulty ids stored in `Data.Difficulty`. */
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

/** The `level.dat` fields shown in the UI. Every field is optional because formats changed over time. */
export interface LevelInfo {
  /** `Data.LevelName`; separate from the folder name. */
  levelName?: string
  /** `Data.Version.Name`, e.g. `1.21.1`. Absent before 1.9. */
  versionName?: string
  /** `Data.Version.Id`. */
  versionId?: number
  /** `Data.Version.Snapshot`. */
  snapshot?: boolean
  /** `Data.DataVersion` (falls back to `Version.Id`). */
  dataVersion?: number
  gameMode?: GameMode
  /** Raw `Data.GameType` value (kept when it is not a known mode). */
  gameType?: number
  hardcore?: boolean
  difficulty?: Difficulty
  difficultyLocked?: boolean
  /** `Data.allowCommands`. */
  cheats?: boolean
  /** World seed as a signed 64-bit decimal string. */
  seed?: string
  /** `Data.LastPlayed` in Unix epoch milliseconds. */
  lastPlayed?: number
  /** `Data.Time`: total game ticks. */
  time?: number
  /** `Data.DayTime`: ticks of the current day cycle. */
  dayTime?: number
  spawn?: { x: number; y: number; z: number }
  /** `Data.GameRules` as strings. */
  gameRules?: Record<string, string>
  /** `Data.ServerBrands`, e.g. `["vanilla", "fabric"]`. */
  serverBrands?: string[]
  /** `Data.WasModded`. */
  wasModded?: boolean
}

const GAME_MODES: GameMode[] = ['survival', 'creative', 'adventure', 'spectator']
const DIFFICULTIES: Difficulty[] = ['peaceful', 'easy', 'normal', 'hard']

const child = (c: NbtCompound | undefined, key: string): NbtTag | undefined => c?.value.get(key)

function compound(c: NbtCompound | undefined, key: string): NbtCompound | undefined {
  const t = child(c, key)
  return t?.type === 'compound' ? t : undefined
}

/** Integer-like value of a tag (byte, short, int, or a long that fits in a double). */
function num(c: NbtCompound | undefined, key: string): number | undefined {
  const t = child(c, key)
  if (!t) return undefined
  if (t.type === 'byte' || t.type === 'short' || t.type === 'int' || t.type === 'float' || t.type === 'double') return t.value
  if (t.type === 'long') return Number(t.value)
  return undefined
}

function bool(c: NbtCompound | undefined, key: string): boolean | undefined {
  const t = child(c, key)
  if (t?.type === 'string') return t.value === 'true' ? true : t.value === 'false' ? false : undefined
  const n = num(c, key)
  return n === undefined ? undefined : n !== 0
}

function text(c: NbtCompound | undefined, key: string): string | undefined {
  const t = child(c, key)
  return t?.type === 'string' ? t.value : undefined
}

function longString(c: NbtCompound | undefined, key: string): string | undefined {
  const t = child(c, key)
  if (t?.type === 'long') return t.value.toString()
  if (t?.type === 'int') return String(t.value)
  return undefined
}

function difficulty(data: NbtCompound | undefined): { difficulty?: Difficulty; locked?: boolean; hardcore?: boolean } {
  // Newer snapshots group these under `difficulty_settings` with a string difficulty.
  const settings = compound(data, 'difficulty_settings')
  if (settings) {
    const raw = text(settings, 'difficulty') ?? num(settings, 'difficulty')
    const d = typeof raw === 'string' ? DIFFICULTIES.find((x) => x === raw.toLowerCase()) : raw === undefined ? undefined : DIFFICULTIES[raw]
    return { difficulty: d, locked: bool(settings, 'locked'), hardcore: bool(settings, 'hardcore') }
  }
  const raw = num(data, 'Difficulty')
  return { difficulty: raw === undefined ? undefined : DIFFICULTIES[raw], locked: bool(data, 'DifficultyLocked') }
}

/** Extract {@link LevelInfo} from a decoded `level.dat` root compound. Unknown or missing fields are omitted. */
export function levelInfoFromNbt(root: NbtCompound): LevelInfo {
  const data = compound(root, 'Data') ?? root
  const version = compound(data, 'Version')
  const gameType = num(data, 'GameType')
  const diff = difficulty(data)
  const wgs = compound(data, 'WorldGenSettings')
  const rulesTag = compound(data, 'GameRules')
  let gameRules: Record<string, string> | undefined
  if (rulesTag) {
    gameRules = Object.create(null) as Record<string, string>
    for (const [k, v] of rulesTag.value) {
      if (v.type === 'string') gameRules[k] = v.value
      else if (v.type === 'byte' || v.type === 'int') gameRules[k] = String(v.value)
    }
  }
  const brands = child(data, 'ServerBrands')
  const sx = num(data, 'SpawnX')
  const sy = num(data, 'SpawnY')
  const sz = num(data, 'SpawnZ')

  const info: LevelInfo = {
    levelName: text(data, 'LevelName'),
    versionName: text(version, 'Name'),
    versionId: num(version, 'Id'),
    snapshot: bool(version, 'Snapshot'),
    dataVersion: num(data, 'DataVersion') ?? num(version, 'Id'),
    gameType,
    gameMode: gameType === undefined ? undefined : GAME_MODES[gameType],
    hardcore: bool(data, 'hardcore') ?? diff.hardcore,
    difficulty: diff.difficulty,
    difficultyLocked: diff.locked,
    cheats: bool(data, 'allowCommands'),
    seed: longString(wgs, 'seed') ?? longString(data, 'RandomSeed'),
    lastPlayed: num(data, 'LastPlayed'),
    time: num(data, 'Time'),
    dayTime: num(data, 'DayTime'),
    spawn: sx !== undefined && sy !== undefined && sz !== undefined ? { x: sx, y: sy, z: sz } : undefined,
    gameRules,
    serverBrands: brands?.type === 'list' ? brands.value.flatMap((b) => (b.type === 'string' ? [b.value] : [])) : undefined,
    wasModded: bool(data, 'WasModded'),
  }
  // Drop absent keys so the result is compact over IPC.
  for (const k of Object.keys(info) as (keyof LevelInfo)[]) if (info[k] === undefined) delete info[k]
  return info
}

/**
 * Read `level.dat` (gzip NBT) from a path or bytes.
 *
 * @throws {ContentError} `ENOT_FOUND` / `EPERMISSION` for file system errors, `ENOT_A_WORLD`
 * when the file is not valid NBT.
 */
export async function readLevelDat(source: string | Uint8Array): Promise<LevelInfo> {
  try {
    const bytes = typeof source === 'string' ? await readFile(source) : source
    const file = await readNbt(bytes)
    return levelInfoFromNbt(file.root)
  } catch (e) {
    if ((e as { code?: string }).code === 'ENBT_MALFORMED') throw new ContentError('ENOT_A_WORLD', `level.dat is corrupt: ${(e as Error).message}`, { cause: e })
    throw wrapFsError(e, 'Cannot read level.dat')
  }
}

/** One world folder under `saves/`. */
export interface SaveInfo {
  /** Folder name (what the game calls the world id). */
  folderName: string
  path: string
  level: LevelInfo
  /** Absolute path of `icon.png` when present. */
  iconPath?: string
  /** True when the save folder is a symlink. */
  linked: boolean
  /** Total size of all files in bytes (only when `computeSize` was requested). */
  sizeBytes?: number
}

/** Options for {@link readSave} and {@link listSaves}. */
export interface ReadSaveOptions {
  /** Also walk the world to compute `sizeBytes` (slow for big worlds). */
  computeSize?: boolean
  signal?: AbortSignal
}

/**
 * Sum the sizes of all regular files below `dir` (symlinks are not followed). Files that vanish
 * during the walk are ignored.
 */
export async function directorySize(dir: string, options: { signal?: AbortSignal } = {}): Promise<number> {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    throwIfAborted(options.signal)
    const current = stack.pop() as string
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (e) {
      if (current !== dir && (e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.isFile()) total += (await lstat(p).catch(() => undefined))?.size ?? 0
    }
  }
  return total
}

/**
 * Read one save folder: its `level.dat`, `icon.png` and (optionally) size on disk.
 *
 * @throws {ContentError} `ENOT_A_WORLD` when there is no readable `level.dat`.
 */
export async function readSave(saveDir: string, options: ReadSaveOptions = {}): Promise<SaveInfo> {
  throwIfAborted(options.signal)
  const levelPath = path.join(saveDir, 'level.dat')
  let level: LevelInfo
  try {
    level = await readLevelDat(levelPath)
  } catch (e) {
    if (e instanceof ContentError && e.code === 'ENOT_FOUND') throw new ContentError('ENOT_A_WORLD', `${saveDir} has no level.dat`, { cause: e })
    throw e
  }
  const icon = path.join(saveDir, 'icon.png')
  // lstat: a symlinked icon.png is ignored (icons are copied into the app's cache).
  const hasIcon = (await lstat(icon).catch(() => undefined))?.isFile() ?? false
  const linked = (await lstat(saveDir).catch(() => undefined))?.isSymbolicLink() ?? false
  const info: SaveInfo = { folderName: path.basename(saveDir), path: saveDir, level, linked }
  if (hasIcon) info.iconPath = icon
  if (options.computeSize) info.sizeBytes = await directorySize(saveDir, options)
  return info
}

/**
 * List the worlds in a `saves/` folder: every non-hidden directory with a readable
 * `level.dat`. A missing folder yields an empty list. Folders that are not worlds are returned
 * separately in `invalid` for diagnostics.
 */
export async function listSaves(savesDir: string, options: ReadSaveOptions = {}): Promise<{ saves: SaveInfo[]; invalid: { path: string; message: string }[] }> {
  let entries
  try {
    entries = await readdir(savesDir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { saves: [], invalid: [] }
    throw wrapFsError(e, `Cannot list ${savesDir}`)
  }
  const saves: SaveInfo[] = []
  const invalid: { path: string; message: string }[] = []
  for (const entry of entries) {
    throwIfAborted(options.signal)
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue
    const dir = path.join(savesDir, entry.name)
    try {
      saves.push(await readSave(dir, options))
    } catch (e) {
      if (isAbortError(e)) throw e
      invalid.push({ path: dir, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { saves, invalid }
}
