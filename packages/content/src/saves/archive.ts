/* oxlint-disable no-await-in-loop -- files are cloned one at a time to bound open file handles */
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { TaskContext } from '@amethyst/task'
import { createZip, openZip, type ZipEntryInfo, type ZipReader } from '@amethyst/zip'
import { ContentError, throwIfAborted, wrapFsError } from '../errors'
import { sanitizeFileName, uniqueName } from '../paths'
import { cloneTree } from '../util/clone'
import { readLevelDat, type LevelInfo } from './level'

/** File names never copied out of a world: the game's lock file and Finder metadata. */
const SKIP_NAMES = new Set(['session.lock', '.ds_store'])

/** Options shared by long-running world operations. */
export interface WorldOperationOptions {
  signal?: AbortSignal
  /** Progress is reported in bytes; the message names the current phase. */
  ctx?: TaskContext
}

/** Summary of a world archive that was written. */
export interface WorldZipResult {
  zipPath: string
  /** Size of the zip file in bytes. */
  size: number
  /** Number of files stored. */
  fileCount: number
  /** Sum of the uncompressed file sizes. */
  uncompressedSize: number
  /** Relative paths that vanished or could not be read while copying (the game may be running). */
  skipped: string[]
}

export function combinedSignal(options: WorldOperationOptions): AbortSignal | undefined {
  const signals = [options.signal, options.ctx?.signal].filter((s): s is AbortSignal => s !== undefined)
  return signals.length <= 1 ? signals[0] : AbortSignal.any(signals)
}

const isVanished = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

interface TreeFile {
  rel: string
  size: number
}

/** List regular files below `root` (relative, `/`-separated), skipping lock files, symlinks and vanished entries. */
async function listTree(root: string, signal: AbortSignal | undefined): Promise<TreeFile[]> {
  const out: TreeFile[] = []
  const stack: string[] = ['']
  while (stack.length > 0) {
    throwIfAborted(signal)
    const rel = stack.pop() as string
    let entries
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true })
    } catch (e) {
      if (rel !== '' && isVanished(e)) continue
      throw e
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) stack.push(childRel)
      else if (entry.isFile()) {
        const st = await lstat(path.join(root, childRel)).catch(() => undefined)
        if (st?.isFile()) out.push({ rel: childRel, size: st.size })
      }
    }
  }
  return out.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * Copy a world into `dest` as a point-in-time snapshot. On APFS the tree is cloned (instant,
 * no extra space); elsewhere files are copied. Only files in the initial listing are reported,
 * so `session.lock` and files created mid-copy are left out, and files that vanish mid-copy
 * (the game rewrites region files while running) are reported in `skipped`.
 */
async function snapshotWorld(src: string, dest: string, options: WorldOperationOptions): Promise<{ files: TreeFile[]; skipped: string[] }> {
  const signal = combinedSignal(options)
  const listed = await listTree(src, signal)
  const total = listed.reduce((n, f) => n + f.size, 0)
  options.ctx?.update(0, total, 'Copying world')
  const files: TreeFile[] = []
  const skipped: string[] = []
  const madeDirs = new Set<string>()
  let done = 0
  // One `cp -c -R` clones the whole tree on APFS; anything it missed is copied file by file below.
  const cloned = await cloneTree(src, dest)
  if (cloned) await rm(path.join(dest, 'session.lock'), { force: true })
  for (const file of listed) {
    throwIfAborted(signal)
    const target = path.join(dest, ...file.rel.split('/'))
    const dir = path.dirname(target)
    try {
      const existing = cloned ? await lstat(target).catch(() => undefined) : undefined
      if (existing?.isFile()) {
        files.push({ rel: file.rel, size: existing.size })
      } else {
        if (!madeDirs.has(dir)) {
          await mkdir(dir, { recursive: true })
          madeDirs.add(dir)
        }
        await copyFile(path.join(src, ...file.rel.split('/')), target, fsConstants.COPYFILE_FICLONE)
        files.push({ rel: file.rel, size: (await stat(target)).size })
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!isVanished(e) && code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') throw e
      skipped.push(file.rel)
    }
    done += file.size
    options.ctx?.update(done, total)
  }
  return { files, skipped }
}

/**
 * Zip a world folder as a single top-level folder named `topLevel` (default: the world folder
 * name). The world is snapshotted first (APFS clones, see {@link snapshotWorld}) into a hidden
 * temporary folder next to the output, so it is safe while the game is running; `session.lock`
 * and `.DS_Store` are skipped.
 */
export async function zipWorld(saveDir: string, outZip: string, options: WorldOperationOptions & { topLevel?: string } = {}): Promise<WorldZipResult> {
  const signal = combinedSignal(options)
  throwIfAborted(signal)
  const top = sanitizeFileName(options.topLevel ?? path.basename(saveDir), 'world')
  const outDir = path.dirname(path.resolve(outZip))
  await mkdir(outDir, { recursive: true })
  const snapshot = path.join(outDir, `.snapshot-${randomBytes(6).toString('hex')}`)
  try {
    const { files, skipped } = await snapshotWorld(saveDir, snapshot, options)
    throwIfAborted(signal)
    options.ctx?.update(files.reduce((n, f) => n + f.size, 0), undefined, 'Compressing world')
    const writer = createZip(outZip, signal ? { signal } : {})
    try {
      for (const f of files) writer.addFile(path.join(snapshot, ...f.rel.split('/')), `${top}/${f.rel}`)
      await writer.finish()
    } catch (e) {
      await writer.abort()
      throw e
    }
    return {
      zipPath: outZip,
      size: (await stat(outZip)).size,
      fileCount: files.length,
      uncompressedSize: files.reduce((n, f) => n + f.size, 0),
      skipped,
    }
  } catch (e) {
    throw wrapFsError(e, `Cannot archive world ${saveDir}`)
  } finally {
    await rm(snapshot, { recursive: true, force: true })
  }
}

async function assertWorld(saveDir: string): Promise<void> {
  const st = await stat(path.join(saveDir, 'level.dat')).catch(() => undefined)
  if (!st?.isFile()) throw new ContentError('ENOT_A_WORLD', `${saveDir} is not a world: level.dat must be at the root of the world folder`)
}

/**
 * Export a world (the folder that directly contains `level.dat`, e.g. `<instance>/saves/<world>`)
 * to a zip with one top-level folder named after the world folder.
 *
 * @throws {ContentError} `ENOT_A_WORLD` when `saveDir` has no `level.dat` at its root.
 */
export async function exportWorld(saveDir: string, outZip: string, options: WorldOperationOptions = {}): Promise<WorldZipResult> {
  await assertWorld(saveDir)
  return zipWorld(saveDir, outZip, options)
}

/** Where the world lives inside an archive: the folder containing the shallowest `level.dat`. */
export interface WorldRoot {
  /** Entry prefix of the world root (`''` or e.g. `My World/`). */
  prefix: string
  /** Number of path components in `prefix`. */
  depth: number
}

const isJunk = (name: string) => name.startsWith('__MACOSX/') || name.split('/').some((s) => s.toLowerCase() === '.ds_store')

/** Find the shallowest `level.dat` in an archive, ignoring `__MACOSX/`. */
export function findWorldRoot(entries: readonly ZipEntryInfo[]): WorldRoot | undefined {
  let best: WorldRoot | undefined
  for (const e of entries) {
    if (e.isDirectory || isJunk(e.name)) continue
    const segs = e.name.split('/').filter((s) => s !== '')
    if (segs.at(-1) !== 'level.dat') continue
    const depth = segs.length - 1
    if (!best || depth < best.depth) best = { prefix: depth === 0 ? '' : `${segs.slice(0, -1).join('/')}/`, depth }
  }
  return best
}

/** Extract the world inside `zip` into the new folder `dest` (which must not exist yet). */
export async function extractWorld(zip: ZipReader, dest: string, options: WorldOperationOptions = {}): Promise<void> {
  const signal = combinedSignal(options)
  const root = findWorldRoot(await zip.entries())
  if (!root) throw new ContentError('ENOT_A_WORLD', 'The archive does not contain a level.dat')
  await zip.extractTo(dest, {
    strip: root.depth,
    signal,
    filter: (e) => e.name.startsWith(root.prefix) && !isJunk(e.name) && !SKIP_NAMES.has(path.posix.basename(e.name).toLowerCase()),
    onProgress: (bytes, total) => options.ctx?.update(bytes, total),
  })
}

/** Result of importing or restoring a world. */
export interface ImportedWorld {
  /** Absolute path of the new world folder. */
  path: string
  folderName: string
  level: LevelInfo
}

/** Rename `from` to a fresh name in `dir` based on `base`, retrying if another writer takes it first. */
export async function renameIntoFreeName(from: string, dir: string, base: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const name = await uniqueName(dir, base, { extension: false })
    const target = path.join(dir, name)
    // rename() replaces empty directories; refuse to clobber anything that appeared meanwhile.
    if (await lstat(target).catch(() => undefined)) {
      if (attempt < 5) continue
      throw new ContentError('EEXIST', `${target} already exists`)
    }
    try {
      await rename(from, target)
      return target
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code === 'EEXIST' || code === 'ENOTEMPTY') && attempt < 5) continue
      throw e
    }
  }
}

/**
 * Import a world zip into `savesDir`. The world root is the folder holding the shallowest
 * `level.dat` (at the root or nested, e.g. `My World/level.dat`); only entries under it are
 * extracted, with the prefix stripped. `__MACOSX/`, `.DS_Store` and `session.lock` are skipped.
 * The destination folder is `options.name` or the sanitised zip stem, with ` (2)`, ` (3)` …
 * appended on (case-insensitive) collision. Extraction goes to a hidden temporary folder that
 * is renamed into place, so a failed import leaves nothing behind.
 *
 * @throws {ContentError} `ENOT_A_WORLD` when the archive has no `level.dat`; `EINVALID_ZIP` for
 * corrupt archives. Entries escaping the destination fail with the zip package's `EZIP_UNSAFE_PATH`.
 */
export async function importWorld(zipPath: string, savesDir: string, options: WorldOperationOptions & { name?: string } = {}): Promise<ImportedWorld> {
  const signal = combinedSignal(options)
  throwIfAborted(signal)
  await mkdir(savesDir, { recursive: true })
  const temp = path.join(savesDir, `.import-${randomBytes(6).toString('hex')}`)
  let zip: ZipReader | undefined
  try {
    zip = await openZip(zipPath)
    await extractWorld(zip, temp, options)
    const level = await readLevelDat(path.join(temp, 'level.dat'))
    const base = sanitizeFileName(options.name ?? path.basename(zipPath).replace(/\.zip$/i, ''), 'World')
    const target = await renameIntoFreeName(temp, savesDir, base)
    return { path: target, folderName: path.basename(target), level }
  } catch (e) {
    throw wrapFsError(e, `Cannot import world ${zipPath}`)
  } finally {
    await zip?.close()
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * Import a world folder (which must have `level.dat` at its root) by copying it into
 * `savesDir`, cloning files on APFS. Names collide the same way as {@link importWorld}.
 */
export async function importWorldFolder(srcDir: string, savesDir: string, options: WorldOperationOptions & { name?: string } = {}): Promise<ImportedWorld> {
  await assertWorld(srcDir)
  await mkdir(savesDir, { recursive: true })
  const temp = path.join(savesDir, `.import-${randomBytes(6).toString('hex')}`)
  try {
    await snapshotWorld(srcDir, temp, options)
    const level = await readLevelDat(path.join(temp, 'level.dat'))
    const target = await renameIntoFreeName(temp, savesDir, sanitizeFileName(options.name ?? path.basename(srcDir), 'World'))
    return { path: target, folderName: path.basename(target), level }
  } catch (e) {
    throw wrapFsError(e, `Cannot import world ${srcDir}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
