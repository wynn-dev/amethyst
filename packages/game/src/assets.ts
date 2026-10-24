/* oxlint-disable no-await-in-loop -- candidates are tried in order */
/**
 * Asset indexes and the legacy asset layouts (launch.md §8).
 *
 * Objects live content-addressed under `assets/objects/<hh>/<sha1>`. Versions up to 1.6.4 read
 * a "virtual" tree of real file names instead: `assets/virtual/<id>/<name>` (index flag
 * `virtual`, id `legacy`), and pre-1.6 versions additionally read `<gameDir>/resources/<name>`
 * (index flag `map_to_resources`). {@link prepareLegacyAssets} builds both with hard links (APFS
 * clones as a fallback), so no object data is duplicated.
 */
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { GameError, throwIfAborted } from './errors'
import type { ResolvedVersion } from './resolve'

export interface AssetObject {
  hash: string
  size: number
}

export interface AssetIndex {
  objects: Record<string, AssetObject>
  /** `legacy` index: build `assets/virtual/<id>`. */
  virtual?: boolean
  /** `pre-1.6` index: also populate `<gameDir>/resources`. */
  map_to_resources?: boolean
}

const SHA1 = /^[0-9a-f]{40}$/

/**
 * Parse and validate asset index JSON. Object names are checked for path traversal because they
 * become file paths in the virtual and resources trees.
 *
 * @throws {GameError} `EASSET_INDEX`
 */
export function parseAssetIndex(text: string, name = 'asset index'): AssetIndex {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new GameError('EASSET_INDEX', `${name} is not valid JSON`, { index: name }, { cause: e })
  }
  const fail = (why: string): never => {
    throw new GameError('EASSET_INDEX', `${name}: ${why}`, { index: name })
  }
  if (typeof raw !== 'object' || raw === null) fail('must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.objects !== 'object' || r.objects === null) fail('objects must be an object')
  const objects: Record<string, AssetObject> = {}
  for (const [key, value] of Object.entries(r.objects as Record<string, unknown>)) {
    const o = (value ?? {}) as { hash?: unknown; size?: unknown }
    if (typeof o.hash !== 'string' || !SHA1.test(o.hash.toLowerCase())) return fail(`object ${JSON.stringify(key)} has an invalid hash`)
    if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size < 0) return fail(`object ${JSON.stringify(key)} has an invalid size`)
    objects[key] = { hash: o.hash.toLowerCase(), size: o.size }
  }
  return { objects, virtual: r.virtual === true, map_to_resources: r.map_to_resources === true }
}

/** `assets/objects/<hh>/<hash>`. */
export function assetObjectPath(assetsDir: string, hash: string): string {
  return path.join(assetsDir, 'objects', hash.slice(0, 2), hash)
}

/** Candidate index files, in order: `<assets id>.json`, then `<sha1>.json` (the installer's hash-named copy). */
export function assetIndexCandidates(assetsDir: string, version: Pick<ResolvedVersion, 'assets' | 'assetIndex'>): string[] {
  const out = [path.join(assetsDir, 'indexes', `${version.assets}.json`)]
  const sha1 = version.assetIndex?.sha1
  if (sha1 && SHA1.test(sha1)) out.push(path.join(assetsDir, 'indexes', `${sha1}.json`))
  return out
}

/**
 * Read the version's asset index from the first candidate file that exists.
 *
 * @throws {GameError} `EASSET_INDEX` when no candidate exists or the file is malformed.
 */
export async function readAssetIndex(assetsDir: string, version: Pick<ResolvedVersion, 'assets' | 'assetIndex'>): Promise<{ index: AssetIndex; path: string }> {
  for (const file of assetIndexCandidates(assetsDir, version)) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    return { index: parseAssetIndex(text, file), path: file }
  }
  throw new GameError('EASSET_INDEX', `Asset index ${version.assets} is not installed`, { assets: version.assets })
}

/** True when the version needs the virtual tree (`legacy`, `pre-*`, or an index flagged `virtual`/`map_to_resources`). */
export function isLegacyAssets(assetsId: string, index?: AssetIndex): boolean {
  return assetsId === 'legacy' || assetsId.startsWith('pre-') || !!index?.virtual || !!index?.map_to_resources
}

/** Split an object name into safe relative segments, or `undefined` if it would escape its tree. */
function safeSegments(name: string): string[] | undefined {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) return undefined
  const segments = name.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0 || segments.includes('..')) return undefined
  return segments
}

export interface PrepareLegacyAssetsOptions {
  /** `<root>/assets`. */
  assetsDir: string
  /** The `assets` id (for example `legacy` or `pre-1.6`). */
  assets: string
  /** The asset index; read from `assets/indexes/<assets>.json` when omitted. */
  index?: AssetIndex
  /** Instance game directory; required to honour `map_to_resources`. */
  gameDir?: string
  /** Parallel file operations (default 32). */
  concurrency?: number
  signal?: AbortSignal
  ctx?: TaskContext
}

export interface PrepareLegacyAssetsResult {
  /** `${game_assets}`: `assets/virtual/<id>`, when the version uses the virtual layout. */
  virtualDir?: string
  /** `<gameDir>/resources`, when the index asks for `map_to_resources`. */
  resourcesDir?: string
  /** Files created (or replaced because their size was wrong). */
  linked: number
  /** Files that were already correct. */
  existing: number
  /** Object names whose source object is not downloaded. */
  missing: string[]
  /** Object names skipped because they would escape the target tree. */
  rejected: string[]
}

async function place(src: string, dst: string, size: number): Promise<'linked' | 'existing' | 'missing'> {
  const st = await lstat(dst).catch(() => undefined)
  if (st) {
    if (st.isFile() && st.size === size) return 'existing'
    await unlink(dst)
  }
  try {
    await link(src, dst)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    if (code === 'EEXIST') return 'existing'
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') throw e
    // Different volume or no hard links: clone on APFS, copy elsewhere.
    try {
      await copyFile(src, dst, constants.COPYFILE_FICLONE)
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw e2
    }
  }
  return 'linked'
}

/**
 * Build the legacy asset trees for versions that need them; a no-op returning `{}` paths for
 * modern versions. Runs before every launch and is idempotent: existing files with the right
 * size are kept, wrong-sized ones are replaced.
 */
export async function prepareLegacyAssets(options: PrepareLegacyAssetsOptions): Promise<PrepareLegacyAssetsResult> {
  const { assetsDir, assets, gameDir, signal, ctx } = options
  throwIfAborted(signal)
  const index = options.index ?? (await readAssetIndex(assetsDir, { assets })).index
  const result: PrepareLegacyAssetsResult = { linked: 0, existing: 0, missing: [], rejected: [] }
  if (!isLegacyAssets(assets, index)) return result

  const targets: string[] = [(result.virtualDir = path.join(assetsDir, 'virtual', assets))]
  if (index.map_to_resources && gameDir) targets.push((result.resourcesDir = path.join(gameDir, 'resources')))

  const jobs: { name: string; src: string; dst: string; size: number }[] = []
  const dirs = new Set<string>()
  for (const [name, obj] of Object.entries(index.objects)) {
    const segments = safeSegments(name)
    if (!segments) {
      result.rejected.push(name)
      continue
    }
    const src = assetObjectPath(assetsDir, obj.hash)
    for (const root of targets) {
      const dst = path.join(root, ...segments)
      dirs.add(path.dirname(dst))
      jobs.push({ name, src, dst, size: obj.size })
    }
  }

  const concurrency = options.concurrency ?? 32
  await mapLimit([...dirs], concurrency, (d) => mkdir(d, { recursive: true }), signal)
  const missing = new Set<string>()
  let done = 0
  await mapLimit(
    jobs,
    concurrency,
    async (job) => {
      const r = await place(job.src, job.dst, job.size)
      if (r === 'linked') result.linked++
      else if (r === 'existing') result.existing++
      else missing.add(job.name)
      if (ctx && ++done % 256 === 0) ctx.update(done, jobs.length)
    },
    signal,
  )
  ctx?.update(jobs.length, jobs.length)
  result.missing = [...missing]
  return result
}
