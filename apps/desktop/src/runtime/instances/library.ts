/**
 * The sidebar organisation of instances: pins and named folders (ui.md B2). Launcher-wide
 * presentation state, stored in `library.json` next to the instance registry and never inside
 * instance folders. Ids of instances that no longer exist are dropped lazily on read.
 */
import { randomUUID } from 'node:crypto'
import type { InstancesService, LibraryFolder, LibraryLayout } from '@shared/services'
import type { Emit } from '../context'
import { JsonDocument } from '../store/json-store'
import { invalid, notFound } from '../util/errors'
import { asRecord, readBool, readString } from '../util/parse'
import { uniqueDisplayName } from './model'

const MAX_FOLDERS = 200
const MAX_NAME = 64

function parseLayout(raw: Record<string, unknown>): LibraryLayout {
  const folders: LibraryFolder[] = []
  for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
    const o = asRecord(f)
    const id = readString(o.id)
    const name = readString(o.name)?.trim()
    if (!id || !name || folders.some((x) => x.id === id) || folders.length >= MAX_FOLDERS) continue
    folders.push({ id, name: name.slice(0, MAX_NAME), expanded: readBool(o.expanded) ?? true })
  }
  const pinned = [...new Set((Array.isArray(raw.pinned) ? raw.pinned : []).filter((x): x is string => typeof x === 'string'))]
  const folderOf: Record<string, string> = {}
  for (const [inst, folder] of Object.entries(asRecord(raw.folderOf))) {
    if (typeof folder === 'string' && folders.some((f) => f.id === folder)) folderOf[inst] = folder
  }
  return { folders, pinned, folderOf }
}

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > MAX_NAME || n.includes('\0')) throw invalid(`Folder names need 1–${MAX_NAME} characters`)
  return n
}

export class LibraryStore {
  readonly #doc: JsonDocument<LibraryLayout>
  readonly #emit: Emit
  /** Instance ids that exist (pins and folder memberships of other ids are hidden). */
  readonly #exists: (id: string) => boolean

  constructor(file: string, deps: { emit: Emit; exists: (id: string) => boolean }) {
    this.#emit = deps.emit
    this.#exists = deps.exists
    this.#doc = new JsonDocument<LibraryLayout>(file, {
      version: 1,
      parse: parseLayout,
      defaults: () => ({ folders: [], pinned: [], folderOf: {} }),
      serialize: (v) => v as unknown as Record<string, unknown>,
    })
  }

  async load(): Promise<void> {
    await this.#doc.load()
  }

  /** The layout, restricted to instances that exist. */
  get(): LibraryLayout {
    const v = this.#doc.value
    const folderOf: Record<string, string> = {}
    for (const [id, folder] of Object.entries(v.folderOf)) if (this.#exists(id)) folderOf[id] = folder
    return { folders: v.folders.map((f) => ({ ...f })), pinned: v.pinned.filter((id) => this.#exists(id)), folderOf }
  }

  async #update(fn: (v: LibraryLayout) => LibraryLayout): Promise<LibraryLayout> {
    if (!this.#doc.loaded) await this.#doc.load()
    await this.#doc.update(fn)
    this.#emit('library:changed', { at: Date.now() })
    return this.get()
  }

  #requireInstance(id: unknown): string {
    if (typeof id !== 'string' || !this.#exists(id)) throw notFound('Instance')
    return id
  }

  async setPinned(id: string, pinned: boolean): Promise<LibraryLayout> {
    const inst = this.#requireInstance(id)
    return this.#update((v) => {
      const rest = v.pinned.filter((x) => x !== inst)
      return { ...v, pinned: pinned === true ? [...rest, inst] : rest }
    })
  }

  async createFolder(name: string): Promise<LibraryFolder> {
    const base = validName(name)
    if (this.#doc.value.folders.length >= MAX_FOLDERS) throw invalid('Too many folders')
    const folder: LibraryFolder = { id: randomUUID(), name: uniqueDisplayName(base, this.#doc.value.folders.map((f) => f.name)), expanded: true }
    await this.#update((v) => ({ ...v, folders: [...v.folders, folder] }))
    return folder
  }

  async updateFolder(id: string, patch: { name?: string; expanded?: boolean }): Promise<LibraryLayout> {
    const folder = this.#doc.value.folders.find((f) => f.id === id)
    if (!folder) throw notFound('Folder')
    const p = asRecord(patch)
    const name = p.name !== undefined ? validName(p.name) : undefined
    const expanded = p.expanded !== undefined ? readBool(p.expanded) : undefined
    if (p.expanded !== undefined && expanded === undefined) throw invalid('`expanded` must be a boolean')
    const others = this.#doc.value.folders.filter((f) => f.id !== id).map((f) => f.name)
    return this.#update((v) => ({
      ...v,
      folders: v.folders.map((f) =>
        f.id === id ? { ...f, ...(name !== undefined ? { name: uniqueDisplayName(name, others) } : {}), ...(expanded !== undefined ? { expanded } : {}) } : f,
      ),
    }))
  }

  async deleteFolder(id: string): Promise<LibraryLayout> {
    if (!this.#doc.value.folders.some((f) => f.id === id)) throw notFound('Folder')
    return this.#update((v) => ({
      ...v,
      folders: v.folders.filter((f) => f.id !== id),
      folderOf: Object.fromEntries(Object.entries(v.folderOf).filter(([, f]) => f !== id)),
    }))
  }

  async moveToFolder(id: string, folderId: string | null): Promise<LibraryLayout> {
    const inst = this.#requireInstance(id)
    if (folderId !== null && !this.#doc.value.folders.some((f) => f.id === folderId)) throw notFound('Folder')
    return this.#update((v) => {
      const folderOf = { ...v.folderOf }
      if (folderId === null) delete folderOf[inst]
      else folderOf[inst] = folderId
      return { ...v, folderOf }
    })
  }

  async flush(): Promise<void> {
    await this.#doc.flush()
  }
}

/** The library half of the `instances` RPC facade. */
export function libraryService(store: LibraryStore): Pick<InstancesService, 'getLayout' | 'setPinned' | 'createFolder' | 'updateFolder' | 'deleteFolder' | 'moveToFolder'> {
  return {
    getLayout: async () => store.get(),
    setPinned: (id, pinned) => store.setPinned(id, pinned),
    createFolder: (name) => store.createFolder(name),
    updateFolder: (id, patch) => store.updateFolder(id, patch),
    deleteFolder: (id) => store.deleteFolder(id),
    moveToFolder: (id, folderId) => store.moveToFolder(id, folderId),
  }
}
