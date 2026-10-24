/**
 * The on-disk layout of the data root (`~/Library/Application Support/Amethyst`). Documented in
 * `docs/STORAGE.md`; keep the two in sync.
 */
import path from 'node:path'

export interface DataLayout {
  root: string
  logs: string
  /** Launcher settings. */
  settings: string
  /** Instance registry: external (imported in place) instances. */
  registry: string
  /** Account records (no secrets). */
  accounts: string
  /** One encrypted blob per account. */
  secrets: string
  /** SQLite resource index and marketplace cache. */
  database: string
  /** Managed instances, one folder each. */
  instances: string
  /** Shared game files (versions, libraries, assets), used by the installer. */
  minecraft: string
  /** Java runtimes downloaded by Amethyst. */
  runtimes: string
  /** Content-addressed blob store. */
  store: string
  /** World backups: `backups/<instance id>/<world>/<stamp>.zip`. */
  backups: string
  /** Worlds moved out of deleted instances. */
  rescuedWorlds: string
  /** Background images and videos. */
  themeMedia: string
  /** Launcher-only skins of offline accounts. */
  skins: string
  /** Disposable caches. */
  cache: string
  /** Icons extracted from mods, packs, worlds and external instances. */
  icons: string
}

export function dataLayout(root: string, logs?: string): DataLayout {
  const r = path.resolve(root)
  return {
    root: r,
    logs: logs ?? path.join(r, 'logs'),
    settings: path.join(r, 'settings.json'),
    registry: path.join(r, 'instances.json'),
    accounts: path.join(r, 'accounts.json'),
    secrets: path.join(r, 'secrets'),
    database: path.join(r, 'index.sqlite'),
    instances: path.join(r, 'instances'),
    minecraft: path.join(r, 'minecraft'),
    runtimes: path.join(r, 'runtimes'),
    store: path.join(r, 'store'),
    backups: path.join(r, 'backups'),
    rescuedWorlds: path.join(r, 'rescued-worlds'),
    themeMedia: path.join(r, 'theme-media'),
    skins: path.join(r, 'skins'),
    cache: path.join(r, 'cache'),
    icons: path.join(r, 'cache', 'icons'),
  }
}

/** `file` relative to the data root with POSIX separators, or `undefined` when it is outside. */
export function relativeToRoot(layout: DataLayout, file: string): string | undefined {
  const rel = path.relative(layout.root, path.resolve(file))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join('/')
}
