/* oxlint-disable no-await-in-loop -- entries are cloned one at a time so the copy can be cancelled between them */
/**
 * Copy an instance folder quickly and safely: each top-level entry is cloned with
 * `/bin/cp -c -R` (APFS `clonefile(2)`: near-instant, no extra space), symlinks are copied as
 * symlinks and never followed, excluded paths are skipped, and the copy can be cancelled between
 * entries (and mid-entry, by killing `cp`). Without `cp -c` (another OS or file system) it falls
 * back to Node's recursive copy.
 */
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import type { TaskContext } from '@amethyst/task'
import { cancelled, isAbortError } from '../util/errors'

export interface CopyTreeOptions {
  /** Relative POSIX paths to skip (top level or one level down, e.g. `.amethyst/staging`). Compared case-insensitively. */
  exclude?: Iterable<string>
  signal?: AbortSignal
  ctx?: TaskContext
  /** Force the portable fallback (tests). */
  portable?: boolean
}

export interface CopyTreeResult {
  /** Relative paths that could not be copied (reported once, at the end). */
  failed: { path: string; message: string }[]
}

function runCp(src: string, dest: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/cp', ['-c', '-R', '-P', '-p', src, dest], { signal }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr).trim() || error.message), { code: (error as NodeJS.ErrnoException).code, name: error.name }))
      else resolve()
    })
  })
}

async function copyEntry(src: string, dest: string, options: CopyTreeOptions): Promise<void> {
  if (!options.portable && process.platform === 'darwin') {
    try {
      await runCp(src, dest, options.signal)
      return
    } catch (e) {
      if (isAbortError(e) || options.signal?.aborted) throw cancelled()
      // Fall through to the portable copy (e.g. a file system without clone support), starting clean.
      await rm(dest, { recursive: true, force: true })
    }
  }
  const st = await lstat(src)
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest)
    return
  }
  await cp(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true })
}

/** Copy the contents of `src` into the (new or empty) folder `dest`. */
export async function copyTree(src: string, dest: string, options: CopyTreeOptions = {}): Promise<CopyTreeResult> {
  const exclude = new Set([...(options.exclude ?? [])].map((p) => p.toLowerCase()))
  const failed: CopyTreeResult['failed'] = []
  await mkdir(dest, { recursive: true })

  // Entries containing an excluded child (e.g. `.amethyst`) are walked one level; others are cloned whole.
  const walkInto = new Set([...exclude].filter((p) => p.includes('/')).map((p) => p.split('/')[0] as string))
  const entries = await readdir(src, { withFileTypes: true })
  const top = entries.filter((e) => !exclude.has(e.name.toLowerCase()) && e.name !== '.DS_Store')
  options.ctx?.update(0, top.length)

  for (const entry of top) {
    if (options.signal?.aborted) throw cancelled()
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    try {
      if (entry.isDirectory() && walkInto.has(entry.name.toLowerCase())) {
        await mkdir(to, { recursive: true })
        for (const child of await readdir(from, { withFileTypes: true })) {
          if (exclude.has(`${entry.name}/${child.name}`.toLowerCase()) || child.name === '.DS_Store') continue
          await copyEntry(path.join(from, child.name), path.join(to, child.name), options)
        }
      } else {
        await copyEntry(from, to, options)
      }
    } catch (e) {
      if (isAbortError(e) || options.signal?.aborted) throw cancelled()
      // A file that vanished mid-copy is skipped quietly; anything else is reported once.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed.push({ path: entry.name, message: e instanceof Error ? e.message : String(e) })
    }
    options.ctx?.advance(1)
  }
  return { failed }
}
