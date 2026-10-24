/**
 * Copy-on-write clones on APFS.
 *
 * Node's `fs.copyFile` cannot clone on macOS: libuv answers `COPYFILE_FICLONE_FORCE` with
 * `ENOSYS` and silently does a full copy for `COPYFILE_FICLONE`. `/bin/cp -c` calls
 * `clonefile(2)`, so on macOS we fall back to it. Elsewhere (Linux reflinks) `copyFile` works.
 */
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'

const CP = '/bin/cp'

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${file} failed: ${String(stderr).trim() || error.message}`), { code: 'ECLONE', cause: error }))
      else resolve()
    })
  })
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * Clone `src` to the new file `dest`. Rejects (typically with `ENOTSUP`, `EXDEV` or `ENOSYS`)
 * when a copy-on-write clone is not possible, so callers can fall back to another method.
 * `dest` must not exist.
 */
export async function cloneFile(src: string, dest: string): Promise<void> {
  try {
    await copyFile(src, dest, fsConstants.COPYFILE_FICLONE_FORCE)
    return
  } catch (e) {
    if (process.platform !== 'darwin' || (e as NodeJS.ErrnoException).code !== 'ENOSYS') throw e
  }
  // `cp -c` silently falls back to a full copy across volumes, so require the same device.
  const [a, b] = await Promise.all([stat(src), stat(path.dirname(dest))])
  if (a.dev !== b.dev) throw errno('EXDEV', `cannot clone ${src} across volumes`)
  await run(CP, ['-c', src, dest])
}

/**
 * Best-effort recursive clone of the *contents* of `srcDir` into `destDir` with `cp -c -R`
 * (macOS only; returns false elsewhere without doing anything). Errors for individual files
 * (for example ones that vanish mid-copy) are ignored: callers must verify what arrived.
 */
export async function cloneTree(srcDir: string, destDir: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const [a, b] = await Promise.all([stat(srcDir), stat(path.dirname(destDir))]).catch(() => [undefined, undefined])
  if (!a || !b || a.dev !== b.dev) return false
  // A trailing slash makes BSD cp copy the directory's contents rather than the directory.
  await run(CP, ['-c', '-R', `${srcDir.replace(/\/+$/, '')}/`, destDir]).catch(() => {})
  return true
}
