import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { openZip, type ZipReader } from '@amethyst/zip'
import { ContentError, wrapFsError } from '../errors'

/** Read-only view over a pack that is either a zip archive or an unpacked folder. */
export interface PackSource {
  readonly format: 'zip' | 'folder'
  /** True when a file exists at `rel` (forward slashes, relative to the pack root). */
  hasFile(rel: string): Promise<boolean>
  /** True when a directory exists at `rel`. */
  hasDir(rel: string): Promise<boolean>
  /** Names of the top-level entries; directories end with `/`. */
  rootEntries(): Promise<string[]>
  /** Names of the files (not directories) directly inside the directory `rel`. */
  listDir(rel: string): Promise<string[]>
  readBuffer(rel: string, maxBytes?: number): Promise<Buffer>
  close(): Promise<void>
}

const DEFAULT_MAX = 16 * 1024 * 1024

function safeRel(rel: string): string[] {
  const segs = rel.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) throw new ContentError('EINVALID_ARGUMENT', `Unsafe pack path ${JSON.stringify(rel)}`)
  return segs
}

class FolderSource implements PackSource {
  readonly format = 'folder'
  constructor(readonly root: string) {}

  async #stat(rel: string) {
    return stat(path.join(this.root, ...safeRel(rel))).catch(() => undefined)
  }
  async hasFile(rel: string) {
    return (await this.#stat(rel))?.isFile() ?? false
  }
  async hasDir(rel: string) {
    return (await this.#stat(rel))?.isDirectory() ?? false
  }
  async rootEntries() {
    const entries = await readdir(this.root, { withFileTypes: true })
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  }
  async listDir(rel: string) {
    const entries = await readdir(path.join(this.root, ...safeRel(rel)), { withFileTypes: true }).catch(() => [])
    return entries.filter((e) => e.isFile()).map((e) => e.name)
  }
  async readBuffer(rel: string, maxBytes = DEFAULT_MAX) {
    const file = path.join(this.root, ...safeRel(rel))
    const st = await stat(file)
    if (st.size > maxBytes) throw new ContentError('EINVALID_ARGUMENT', `${rel} is ${st.size} bytes (limit ${maxBytes})`)
    return readFile(file)
  }
  async close() {}
}

class ZipSourceImpl implements PackSource {
  readonly format = 'zip'
  #dirs?: Promise<Set<string>>
  constructor(readonly zip: ZipReader) {}

  /** Every directory implied by the entry names (zips often omit explicit directory entries). */
  #allDirs() {
    this.#dirs ??= this.zip.entries().then((entries) => {
      const dirs = new Set<string>()
      for (const e of entries) {
        const segs = e.name.split('/')
        // `a/b/` and `a/b/c` both imply the directories `a` and `a/b`.
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
      }
      dirs.delete('')
      return dirs
    })
    return this.#dirs
  }
  async hasFile(rel: string) {
    const e = await this.zip.entry(safeRel(rel).join('/'))
    return e !== undefined && !e.isDirectory
  }
  async hasDir(rel: string) {
    return (await this.#allDirs()).has(safeRel(rel).join('/'))
  }
  async rootEntries() {
    const out = new Set<string>()
    for (const e of await this.zip.entries()) {
      const [first, ...rest] = e.name.split('/')
      if (!first) continue
      out.add(rest.length > 0 || e.isDirectory ? `${first}/` : first)
    }
    return [...out]
  }
  async listDir(rel: string) {
    const prefix = `${safeRel(rel).join('/')}/`
    return (await this.zip.entries())
      .filter((e) => !e.isDirectory && e.name.startsWith(prefix) && !e.name.slice(prefix.length).includes('/'))
      .map((e) => e.name.slice(prefix.length))
  }
  async readBuffer(rel: string, maxBytes = DEFAULT_MAX) {
    return this.zip.readBuffer(safeRel(rel).join('/'), { maxBytes })
  }
  async close() {
    await this.zip.close()
  }
}

/**
 * Open a pack at `packPath`, which may be a zip file or a folder.
 *
 * @throws {ContentError} `ENOT_FOUND`, `EPERMISSION` or `EINVALID_ZIP`.
 */
export async function openPackSource(packPath: string): Promise<PackSource> {
  try {
    const st = await stat(packPath)
    if (st.isDirectory()) return new FolderSource(packPath)
    return new ZipSourceImpl(await openZip(packPath))
  } catch (e) {
    throw wrapFsError(e, `Cannot open pack ${packPath}`)
  }
}

/**
 * Read one file (an icon such as `pack.png`, or a mod's logo) from a zip archive or folder.
 * The relative path must not contain `..`.
 *
 * @throws {ContentError} `ENOT_FOUND` when the file does not exist, `EINVALID_ZIP` for corrupt archives.
 */
export async function readPackFile(packPath: string, rel: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
  const source = await openPackSource(packPath)
  try {
    if (!(await source.hasFile(rel))) throw new ContentError('ENOT_FOUND', `${rel} not found in ${packPath}`)
    return await source.readBuffer(rel, options.maxBytes)
  } catch (e) {
    throw wrapFsError(e, `Cannot read ${rel} from ${packPath}`)
  } finally {
    await source.close()
  }
}
