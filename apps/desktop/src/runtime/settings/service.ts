/**
 * Global settings: one `settings.json` document, validated through `schema.ts`. Patches are
 * deep, `null` resets, and every change emits `settings:changed` with only the changed keys.
 */
import { availableParallelism, freemem, totalmem } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import type { Events } from '@shared/events'
import type { DataPaths, Settings, SettingsNotice, SettingsPatch, SettingsService } from '@shared/services'
import type { DataLayout } from '../layout'
import { relativeToRoot } from '../layout'
import { logger } from '../log'
import { JsonDocument, type LoadResult } from '../store/json-store'
import { AppError } from '../util/errors'
import { importMediaFile } from '../util/media'
import { applySettingsPatch, changedKeys, defaultSettings, parseSettings, SETTINGS_VERSION, sparsePatch } from './schema'

const log = logger('settings')
const MAX_BACKGROUND_BYTES = 512 * 1024 * 1024

export type SettingsListener = (keys: string[], settings: Settings) => void

export class SettingsStore {
  readonly #doc: JsonDocument<Settings>
  readonly #layout: DataLayout
  readonly #emit: <K extends keyof Events>(event: K, payload: Events[K]) => void
  readonly #listeners = new Set<SettingsListener>()
  /** Problems found while loading (surfaced in diagnostics). */
  loadResult: LoadResult<Settings> | undefined
  /** Shown once to the user: `settings.json` was moved aside as unreadable. */
  #notice: SettingsNotice | null = null

  constructor(layout: DataLayout, emit: <K extends keyof Events>(event: K, payload: Events[K]) => void) {
    this.#layout = layout
    this.#emit = emit
    this.#doc = new JsonDocument(layout.settings, {
      version: SETTINGS_VERSION,
      parse: parseSettings,
      defaults: defaultSettings,
      serialize: (s) => s as unknown as Record<string, unknown>,
    })
  }

  async load(): Promise<Settings> {
    this.loadResult = await this.#doc.load()
    const { corruptPath, outcome } = this.loadResult
    if (corruptPath) {
      log.warn(`settings.json was unreadable (${this.loadResult.error}); kept as ${corruptPath}, outcome ${outcome}`)
      this.#notice = { kind: outcome === 'recovered' ? 'recovered' : 'reset', corruptPath }
      // Windows already connected look now; later ones ask when they start (takeNotice).
      this.#emit('settings:notice', { at: Date.now() })
    }
    return this.#doc.value
  }

  /** The pending one-time notice; the first caller takes it, so it is shown once. */
  takeNotice(): SettingsNotice | null {
    const notice = this.#notice
    this.#notice = null
    return notice
  }

  get value(): Settings {
    return this.#doc.value
  }

  /** Subscribe to changes inside the runtime (e.g. proxy or connection limits). */
  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async patch(patch: SettingsPatch): Promise<Settings> {
    const result = applySettingsPatch(this.#doc.value, patch)
    if (result.invalid.length > 0) {
      throw new AppError('EINVALID_SETTINGS', `Invalid settings: ${result.invalid.join(', ')}`, { keys: result.invalid })
    }
    return this.#commit(result.next, result.changed)
  }

  async reset(): Promise<Settings> {
    const next = defaultSettings()
    // Keep the consent answer: resetting appearance must not re-prompt for telemetry.
    next.privacy = { ...this.#doc.value.privacy }
    const old = this.#doc.value.appearance.background.file
    const settings = await this.#commit(next, changedKeys(this.#doc.value, next))
    if (old) await this.#deleteMedia(old)
    return settings
  }

  async setBackground(source: { path: string } | null): Promise<Settings> {
    const current = this.#doc.value.appearance.background
    if (source === null) {
      const settings = await this.patch({ appearance: { background: { kind: 'none', file: null } } })
      if (current.file) await this.#deleteMedia(current.file)
      return settings
    }
    if (typeof source?.path !== 'string' || !path.isAbsolute(source.path)) throw new AppError('EINVALID_ARGUMENT', 'An absolute file path is required')
    const media = await importMediaFile(source.path, this.#layout.themeMedia, { kinds: ['image', 'video'], maxBytes: MAX_BACKGROUND_BYTES })
    const file = relativeToRoot(this.#layout, media.path)
    if (!file) throw new AppError('EINTERNAL', 'Media folder is outside the data root')
    const settings = await this.patch({ appearance: { background: { kind: media.type.kind, file } } })
    if (current.file && current.file !== file) await this.#deleteMedia(current.file)
    return settings
  }

  async #deleteMedia(rel: string): Promise<void> {
    const abs = path.join(this.#layout.root, rel)
    if (path.dirname(abs) !== this.#layout.themeMedia) return
    await rm(abs, { force: true }).catch((e: unknown) => log.warn(`cannot delete ${abs}`, e))
  }

  async #commit(next: Settings, changed: string[]): Promise<Settings> {
    if (changed.length === 0) return this.#doc.value
    try {
      await this.#doc.set(next)
    } catch (e) {
      // The in-memory value is already updated; the next change retries the write.
      log.error('cannot write settings.json', e)
    }
    this.#emit('settings:changed', { keys: changed, patch: sparsePatch(next, changed) as Events['settings:changed']['patch'] })
    for (const fn of this.#listeners) {
      try {
        fn(changed, next)
      } catch (e) {
        log.error('settings listener failed', e)
      }
    }
    return next
  }

  async flush(): Promise<void> {
    await this.#doc.flush()
  }
}

/** The RPC facade. */
export function settingsService(store: SettingsStore, layout: DataLayout): SettingsService {
  return {
    get: async () => store.value,
    patch: (patch) => store.patch(patch),
    reset: () => store.reset(),
    setBackground: (source) => store.setBackground(source),
    getPaths: async (): Promise<DataPaths> => ({ dataRoot: layout.root, instances: layout.instances, backups: layout.backups, logs: layout.logs }),
    takeNotice: async () => store.takeNotice(),
    getSystemInfo: async () => ({
      totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(freemem() / 1024 / 1024),
      cpuCount: availableParallelism(),
    }),
  }
}
