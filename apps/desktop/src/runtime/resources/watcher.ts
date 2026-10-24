/**
 * One recursive FSEvents watcher per open instance (`fs.watch(dir, { recursive: true })`).
 * Raw events are routed to the content folders they affect, then debounced and coalesced: a
 * burst of events (copying 200 jars, the game autosaving) becomes one rescan per affected folder,
 * fired `debounceMs` after the last event (and at least every `maxWaitMs` during a long burst).
 */
import { watch } from 'node:fs'
import type { ResourceKind } from '@shared/services'

/** Start watching `dir`; `onEvent` receives paths relative to it (`null` when unknown, e.g. overflow). */
export type WatchFactory = (dir: string, onEvent: (relative: string | null) => void, onError: (error: Error) => void) => { close(): void }

export const fsWatch: WatchFactory = (dir, onEvent, onError) => {
  const watcher = watch(dir, { recursive: true, persistent: false }, (_type, filename) => onEvent(filename ? filename.toString() : null))
  watcher.on('error', onError)
  return watcher
}

const KINDS: readonly ResourceKind[] = ['mods', 'resourcepacks', 'shaderpacks', 'saves']
const IGNORED = /(\.part|\.tmp|\.pending|\.ds_store|\.rartemp|~)$/i

/** The content folders a change at `relative` (inside the instance folder) can affect. */
export function routeChange(relative: string | null): ResourceKind[] {
  if (relative === null) return [...KINDS]
  const parts = relative.split(/[\\/]+/).filter(Boolean)
  const first = parts[0]?.toLowerCase()
  const last = parts.at(-1) ?? ''
  if (!first || IGNORED.test(last)) return []
  if (first === 'mods' || first === 'resourcepacks' || first === 'shaderpacks') {
    // The folder itself, a direct child, or a file directly inside a folder pack (pack.mcmeta).
    return parts.length <= 3 ? [first] : []
  }
  if (first === 'saves') {
    if (parts.length <= 2) return ['saves']
    return parts.length === 3 && /^(level\.dat|icon\.png)$/i.test(last) ? ['saves'] : []
  }
  if (parts.length === 1 && first === 'options.txt') return ['resourcepacks']
  if (parts.length === 1 && first === 'optionsshaders.txt') return ['shaderpacks']
  if (parts.length === 2 && first === 'config' && /^(iris|oculus)\.properties$/i.test(last)) return ['shaderpacks']
  return []
}

export interface InstanceWatcherOptions {
  debounceMs?: number
  maxWaitMs?: number
  factory?: WatchFactory
  onError?: (error: Error) => void
}

export class InstanceWatcher {
  readonly #dir: string
  readonly #onDirty: (kinds: ResourceKind[]) => void
  readonly #debounceMs: number
  readonly #maxWaitMs: number
  readonly #factory: WatchFactory
  readonly #onError: (error: Error) => void
  #handle: { close(): void } | undefined
  readonly #dirty = new Set<ResourceKind>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #firstEventAt = 0
  /** Raw events seen (diagnostics and tests). */
  events = 0

  constructor(dir: string, onDirty: (kinds: ResourceKind[]) => void, options: InstanceWatcherOptions = {}) {
    this.#dir = dir
    this.#onDirty = onDirty
    this.#debounceMs = options.debounceMs ?? 300
    this.#maxWaitMs = options.maxWaitMs ?? 2000
    this.#factory = options.factory ?? fsWatch
    this.#onError = options.onError ?? (() => {})
  }

  get active(): boolean {
    return this.#handle !== undefined
  }

  start(): void {
    if (this.#handle) return
    this.#handle = this.#factory(
      this.#dir,
      (rel) => this.#event(rel),
      (e) => {
        // EPERM/EBUSY style errors: report, then treat as "something changed" once.
        this.#onError(e)
        this.#event(null)
      },
    )
  }

  stop(): void {
    this.#handle?.close()
    this.#handle = undefined
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#dirty.clear()
  }

  #event(relative: string | null): void {
    this.events++
    const kinds = routeChange(relative)
    if (kinds.length === 0) return
    for (const k of kinds) this.#dirty.add(k)
    const now = Date.now()
    if (!this.#timer) this.#firstEventAt = now
    else clearTimeout(this.#timer)
    const wait = Math.min(this.#debounceMs, Math.max(0, this.#firstEventAt + this.#maxWaitMs - now))
    this.#timer = setTimeout(() => this.#fire(), wait)
  }

  #fire(): void {
    this.#timer = undefined
    if (this.#dirty.size === 0) return
    const kinds = [...this.#dirty]
    this.#dirty.clear()
    this.#onDirty(kinds)
  }
}
