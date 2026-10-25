import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ContentError } from '../errors'
import { isPathInside } from '../paths'

/** Write `data` to `file` atomically: write a temporary sibling, then rename it over the target. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Read a small user file without following symlinks: the last component is opened with
 * `O_NOFOLLOW` and must be a regular file, and when `root` is given the file's real path must
 * stay inside the real `root` (so a symlinked folder on the way cannot lead elsewhere either).
 * Used for icons that end up copied into the app's cache.
 *
 * @throws {ContentError} `EINVALID_ARGUMENT` for symlinks, non-files, escapes and files over `maxBytes`.
 */
export async function readRegularFile(file: string, options: { maxBytes: number; root?: string }): Promise<Buffer> {
  let handle
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new ContentError('EINVALID_ARGUMENT', `${file} is a symbolic link`)
    throw e
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new ContentError('EINVALID_ARGUMENT', `${file} is not a regular file`)
    if (st.size > options.maxBytes) throw new ContentError('EINVALID_ARGUMENT', `${file} is ${st.size} bytes (limit ${options.maxBytes})`)
    if (options.root !== undefined) {
      const [realRoot, realFile] = await Promise.all([realpath(options.root), realpath(file)])
      if (!isPathInside(realRoot, realFile) || realRoot === realFile) throw new ContentError('EINVALID_ARGUMENT', `${file} is outside ${options.root}`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
