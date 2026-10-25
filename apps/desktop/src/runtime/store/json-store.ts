/* oxlint-disable no-await-in-loop -- queued writes are applied one after another by design */
/**
 * Crash-safe JSON documents (settings, instance metadata, the instance registry, accounts).
 *
 * Writes go to a temporary sibling that is fsynced and then renamed over the target, so a crash
 * or kill at any point leaves either the old or the new file, never a truncated one. Before each
 * replace the previous good file is copied to `<file>.bak`. Writes to one document are
 * serialised, and bursts coalesce: while a write is in flight only the latest value is queued.
 *
 * Reading never resets user data silently: a file that does not parse is moved aside to
 * `<file>.corrupt-<epoch ms>` (or, with `onCorrupt: 'keep'`, left in place and the document
 * becomes read-only), the `.bak` is tried next, and only then do defaults apply. Documents carry
 * a `schemaVersion`; older ones are migrated step by step on load.
 */
import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../util/errors'

/** How a document's JSON maps to its typed value. */
export interface DocumentSchema<T> {
  /** Current version, written as `schemaVersion`. */
  version: number
  /** `migrations[n]` upgrades a raw document from version `n` to `n + 1`. */
  migrations?: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>
  /**
   * Turn migrated raw JSON into a value. Must be lenient per field (an invalid field falls back
   * to its default); throw only when the document as a whole is unusable.
   */
  parse(raw: Record<string, unknown>): T
  /** Value used when the file does not exist (or nothing could be recovered). */
  defaults(): T
  /** Plain JSON to persist. Default: the value itself. `schemaVersion` is added. */
  serialize?(value: T): Record<string, unknown>
}

/** What {@link JsonDocument.load} found. */
export type LoadOutcome =
  /** The file was read normally. */
  | 'loaded'
  /** No file yet: defaults. */
  | 'missing'
  /** The file was unreadable (moved aside) and the `.bak` was used. */
  | 'recovered'
  /** The file and its backup were unreadable (moved aside): defaults. */
  | 'reset'
  /** The file is unreadable and was left in place (`onCorrupt: 'keep'`, or any I/O error): defaults, read-only. */
  | 'unreadable'

export interface LoadResult<T> {
  value: T
  outcome: LoadOutcome
  /** Where the unreadable file was moved, when it was. */
  corruptPath?: string
  /** Parse error message, when the primary file was unreadable. */
  error?: string
}

/** File system calls used by the store; injectable to simulate crashes in tests. */
export interface StoreFs {
  readFile(file: string): Promise<string>
  /** Create `file`, write `data`, fsync and close. */
  writeDurable(file: string, data: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  rm(file: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  mkdir(dir: string): Promise<void>
}

export const nodeStoreFs: StoreFs = {
  readFile: (f) => fsp.readFile(f, 'utf8'),
  async writeDurable(file, data, mode) {
    const fh = await fsp.open(file, 'wx', mode)
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
  },
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  rm: (f) => fsp.rm(f, { force: true }),
  readdir: (d) => fsp.readdir(d),
  mkdir: async (d) => {
    await fsp.mkdir(d, { recursive: true })
  },
}

export interface JsonDocumentOptions {
  /** `move-aside` (default): rename an unreadable file and continue. `keep`: leave it, become read-only. */
  onCorrupt?: 'move-aside' | 'keep'
  /** Keep `<file>.bak` with the previous version (default true). */
  backup?: boolean
  /** File mode for new files (default 0o644; secrets use 0o600). */
  mode?: number
  fs?: Partial<StoreFs>
  /** Clock for corrupt-file names (tests). */
  now?: () => number
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class JsonDocument<T> {
  readonly file: string
  readonly #schema: DocumentSchema<T>
  readonly #fs: StoreFs
  readonly #onCorrupt: 'move-aside' | 'keep'
  readonly #backup: boolean
  readonly #mode: number
  readonly #now: () => number
  #value: T
  #loaded = false
  #readOnly = false
  /** The on-disk version is newer than ours; keep a copy of it before the first overwrite. */
  #newerOnDisk: number | undefined
  #running = false
  #queued: { value: T } | undefined
  #waiters: { resolve: () => void; reject: (e: unknown) => void }[] = []

  constructor(file: string, schema: DocumentSchema<T>, options: JsonDocumentOptions = {}) {
    this.file = path.resolve(file)
    this.#schema = schema
    this.#fs = { ...nodeStoreFs, ...options.fs }
    this.#onCorrupt = options.onCorrupt ?? 'move-aside'
    this.#backup = options.backup ?? true
    this.#mode = options.mode ?? 0o644
    this.#now = options.now ?? Date.now
    this.#value = schema.defaults()
  }

  get value(): T {
    return this.#value
  }

  get loaded(): boolean {
    return this.#loaded
  }

  /** True when the file on disk is unreadable and was kept (`onCorrupt: 'keep'`); writes reject. */
  get readOnly(): boolean {
    return this.#readOnly
  }

  get backupPath(): string {
    return `${this.file}.bak`
  }

  /** Read the document from disk (see the module comment for the recovery rules). */
  async load(): Promise<LoadResult<T>> {
    await this.#cleanupTemporaries()
    const primary = await this.#read(this.file)
    if (primary.kind === 'ok') return this.#accept(primary.value, 'loaded')
    if (primary.kind === 'missing') {
      // A crash can never leave the primary missing, but a user may have deleted it: use the backup.
      const bak = this.#backup ? await this.#read(this.backupPath) : ({ kind: 'missing' } as const)
      if (bak.kind === 'ok') return this.#accept(bak.value, 'recovered')
      return this.#accept(this.#schema.defaults(), 'missing')
    }
    // Unreadable primary. An I/O error (EACCES, EIO, EMFILE…) says nothing about the content, so
    // the file is always kept in place then: moving it aside would reset a good document.
    if (this.#onCorrupt === 'keep' || primary.kind === 'io') {
      this.#value = this.#schema.defaults()
      this.#loaded = true
      this.#readOnly = true
      return { value: this.#value, outcome: 'unreadable', error: primary.error }
    }
    const corruptPath = `${this.file}.corrupt-${this.#now()}`
    await this.#fs.rename(this.file, corruptPath)
    const bak = this.#backup ? await this.#read(this.backupPath) : ({ kind: 'missing' } as const)
    if (bak.kind === 'ok') return { ...this.#accept(bak.value, 'recovered'), corruptPath, error: primary.error }
    return { ...this.#accept(this.#schema.defaults(), 'reset'), corruptPath, error: primary.error }
  }

  #accept(value: T, outcome: LoadOutcome): LoadResult<T> {
    this.#value = value
    this.#loaded = true
    this.#readOnly = false
    return { value, outcome }
  }

  async #read(file: string): Promise<{ kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'bad' | 'io'; error: string }> {
    let text: string
    try {
      text = await this.#fs.readFile(file)
    } catch (e) {
      if (isMissing(e)) return { kind: 'missing' }
      return { kind: 'io', error: e instanceof Error ? e.message : String(e) }
    }
    try {
      const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
      if (!isRecord(raw)) throw new Error('not a JSON object')
      return { kind: 'ok', value: this.#schema.parse(this.#migrate(raw, file === this.file)) }
    } catch (e) {
      return { kind: 'bad', error: e instanceof Error ? e.message : String(e) }
    }
  }

  #migrate(raw: Record<string, unknown>, primary: boolean): Record<string, unknown> {
    const declared = raw.schemaVersion
    let version = typeof declared === 'number' && Number.isInteger(declared) && declared >= 0 ? declared : this.#schema.version
    if (version > this.#schema.version) {
      if (primary) this.#newerOnDisk = version
      return raw
    }
    let doc = raw
    while (version < this.#schema.version) {
      const step = this.#schema.migrations?.[version]
      if (step) doc = step(doc)
      version++
    }
    return doc
  }

  /** Remove temporary files left behind by a crash mid-write. */
  async #cleanupTemporaries(): Promise<void> {
    const dir = path.dirname(this.file)
    const prefix = `${path.basename(this.file)}.`
    const names = await this.#fs.readdir(dir).catch(() => [] as string[])
    await Promise.all(names.filter((n) => n.startsWith(prefix) && n.endsWith('.tmp')).map((n) => this.#fs.rm(path.join(dir, n)).catch(() => {})))
  }

  /**
   * Replace the value and persist it. Resolves once a write containing this value (or a later
   * one) is durable. Rejects with `EDOCUMENT_READONLY` for unreadable kept documents.
   */
  set(value: T): Promise<void> {
    if (this.#readOnly) {
      return Promise.reject(new AppError('EDOCUMENT_READONLY', `${path.basename(this.file)} is unreadable; repair it before saving`))
    }
    this.#value = value
    this.#queued = { value }
    const done = new Promise<void>((resolve, reject) => this.#waiters.push({ resolve, reject }))
    if (!this.#running) void this.#drain()
    return done
  }

  /** Apply `fn` to the current value and persist the result. */
  async update(fn: (value: T) => T): Promise<T> {
    const next = fn(this.#value)
    await this.set(next)
    return next
  }

  /** Wait for queued writes to finish. */
  async flush(): Promise<void> {
    if (!this.#running) return
    await new Promise<void>((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  /**
   * Allow writing again after an unreadable kept file: it is moved to `.corrupt-<ts>` first, so
   * the next {@link set} never destroys it.
   */
  async discardUnreadable(): Promise<string | undefined> {
    if (!this.#readOnly) return undefined
    const corruptPath = `${this.file}.corrupt-${this.#now()}`
    await this.#fs.rename(this.file, corruptPath).catch((e: unknown) => {
      if (!isMissing(e)) throw e
    })
    this.#readOnly = false
    return corruptPath
  }

  async #drain(): Promise<void> {
    this.#running = true
    try {
      while (this.#queued) {
        const { value } = this.#queued
        this.#queued = undefined
        const waiters = this.#waiters
        this.#waiters = []
        try {
          await this.#writeNow(value)
          for (const w of waiters) w.resolve()
        } catch (e) {
          for (const w of waiters) w.reject(e)
        }
      }
    } finally {
      this.#running = false
      // flush() callers that arrived after the last write.
      const late = this.#waiters
      this.#waiters = []
      for (const w of late) w.resolve()
    }
  }

  async #writeNow(value: T): Promise<void> {
    const body = this.#schema.serialize ? this.#schema.serialize(value) : (value as unknown as Record<string, unknown>)
    const { schemaVersion: _ignored, ...rest } = body
    const text = `${JSON.stringify({ schemaVersion: this.#schema.version, ...rest }, null, 2)}\n`
    const dir = path.dirname(this.file)
    await this.#fs.mkdir(dir)
    if (this.#newerOnDisk !== undefined) {
      await this.#fs.copyFile(this.file, `${this.file}.v${this.#newerOnDisk}.bak`).catch(() => {})
      this.#newerOnDisk = undefined
    }
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await this.#fs.writeDurable(tmp, text, this.#mode)
      if (this.#backup) {
        await this.#fs.copyFile(this.file, this.backupPath).catch((e: unknown) => {
          if (!isMissing(e)) throw e
        })
      }
      await this.#fs.rename(tmp, this.file)
    } catch (e) {
      await this.#fs.rm(tmp).catch(() => {})
      throw e
    }
  }
}
