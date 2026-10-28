/**
 * Pre-launch diagnosis (install.md §10.2): which files of a resolved version are missing or
 * corrupt, with what the installer needs to repair them (URL, expected hashes and size).
 *
 * Cheap by default: sizes are always compared, but full hashes are streamed only when asked
 * (`hash: 'always'`) or when a file is *suspect*. Libraries, natives and the client jar are
 * suspect unless they are older than the install timestamp (`trustBefore`); the client jar is
 * always hashed (Forge processors consume it); asset objects are trusted by size unless they
 * changed after `trustBefore`. Small metadata files (asset index, log config) are always hashed.
 * File checks run with bounded concurrency, so thousands of assets take milliseconds.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { assetIndexCandidates, assetObjectPath, parseAssetIndex, type AssetIndex } from './assets'
import { resolveDirs, type GameDirs } from './command'
import { throwIfAborted } from './errors'
import { hashFile } from './hash'
import { libraryFile, type ResolvedLibrary } from './libraries'
import { planNatives, type NativesPlan, type PlanNativesOptions } from './natives/plan'
import type { ResolvedVersion } from './resolve'

export type DiagnoseKind = 'client' | 'library' | 'native' | 'assetIndex' | 'asset' | 'logConfig'
export type DiagnoseProblem = 'missing' | 'size' | 'hash' | 'corrupt' | 'unavailable'

export interface DiagnoseIssue {
  kind: DiagnoseKind
  /** Library coordinate, asset name, or file id. */
  name: string
  /** Absolute expected location. */
  path: string
  problem: DiagnoseProblem
  expected: { sha1?: string; sha1Alternatives?: string[]; sha256?: string; size?: number }
  actual?: { size?: number; sha1?: string; sha256?: string }
  /** Where to download it from. Empty for files produced by a loader installer. */
  url?: string
  message?: string
}

export interface DiagnoseOptions {
  /** Plan to check (normally the one used for the launch). Otherwise computed from `jvmArch`. */
  natives?: NativesPlan
  /** Required when `natives` is not given. */
  jvmArch?: PlanNativesOptions['jvmArch']
  lwjgl2?: PlanNativesOptions['lwjgl2']
  glfw?: PlanNativesOptions['glfw']
  /** `suspect` (default): see the module doc. `always`: hash everything. `never`: sizes only. */
  hash?: 'never' | 'suspect' | 'always'
  /** Install timestamp (epoch ms, from `.install-lock`). Files not modified since are trusted by size. */
  trustBefore?: number
  /** Check asset objects (default true). */
  assets?: boolean
  /** Parallel file checks (default 64). */
  concurrency?: number
  signal?: AbortSignal
  ctx?: TaskContext
}

interface Expect {
  kind: DiagnoseKind
  name: string
  path: string
  url?: string
  sha1?: string
  sha1Alternatives?: string[]
  sha256?: string
  size?: number
  /** Hash policy for this file in `suspect` mode. */
  policy: 'always' | 'unlessTrusted' | 'onlyIfChanged'
}

async function check(e: Expect, mode: NonNullable<DiagnoseOptions['hash']>, trustBefore: number | undefined, signal?: AbortSignal): Promise<DiagnoseIssue | undefined> {
  const expected: DiagnoseIssue['expected'] = {}
  if (e.sha1) expected.sha1 = e.sha1
  if (e.sha1Alternatives?.length) expected.sha1Alternatives = e.sha1Alternatives
  if (e.sha256) expected.sha256 = e.sha256
  if (e.size !== undefined) expected.size = e.size
  const issue = (problem: DiagnoseProblem, actual?: DiagnoseIssue['actual']): DiagnoseIssue => {
    const out: DiagnoseIssue = { kind: e.kind, name: e.name, path: e.path, problem, expected }
    if (actual) out.actual = actual
    if (e.url !== undefined) out.url = e.url
    return out
  }
  const st = await stat(e.path).catch(() => undefined)
  if (!st?.isFile()) return issue('missing')
  if (e.size !== undefined && st.size !== e.size) return issue('size', { size: st.size })
  if (e.size === undefined && st.size === 0) return issue('size', { size: 0 })
  if (!e.sha1 && !e.sha256) return undefined

  let hash: boolean
  if (mode === 'always') hash = true
  else if (mode === 'never') hash = false
  else if (e.policy === 'always') hash = true
  else if (e.policy === 'unlessTrusted') hash = trustBefore === undefined || st.mtimeMs > trustBefore
  else hash = trustBefore !== undefined && st.mtimeMs > trustBefore
  if (!hash) return undefined

  if (e.sha1) {
    const sha1 = await hashFile(e.path, 'sha1', signal)
    if (sha1 !== e.sha1 && !e.sha1Alternatives?.includes(sha1)) return issue('hash', { size: st.size, sha1 })
  } else if (e.sha256) {
    const sha256 = await hashFile(e.path, 'sha256', signal)
    if (sha256 !== e.sha256) return issue('hash', { size: st.size, sha256 })
  }
  return undefined
}

function libraryExpect(lib: ResolvedLibrary, librariesDir: string): Expect {
  const native = lib.isNative || !!lib.coordinate.classifier?.startsWith('natives-')
  const e: Expect = { kind: native ? 'native' : 'library', name: lib.name, path: libraryFile(librariesDir, lib), url: lib.download.url, policy: 'unlessTrusted' }
  if (lib.download.sha1) e.sha1 = lib.download.sha1
  if (lib.download.sha1Alternatives) e.sha1Alternatives = lib.download.sha1Alternatives
  if (lib.download.sha256) e.sha256 = lib.download.sha256
  if (lib.download.size !== undefined) e.size = lib.download.size
  return e
}

/**
 * List every missing or corrupt file the launch of `version` needs. An empty list means the
 * version is complete. Natives the plan cannot provide are reported as `kind: 'native'`,
 * `problem: 'unavailable'`.
 */
export async function diagnose(version: ResolvedVersion, dirs: GameDirs | string, options: DiagnoseOptions = {}): Promise<DiagnoseIssue[]> {
  const d = resolveDirs(dirs)
  const { signal, ctx, trustBefore } = options
  const mode = options.hash ?? 'suspect'
  const concurrency = options.concurrency ?? 64
  throwIfAborted(signal)
  const issues: DiagnoseIssue[] = []

  let plan = options.natives
  if (!plan) {
    if (!options.jvmArch) throw new TypeError('diagnose needs options.natives or options.jvmArch')
    plan = planNatives(version, { jvmArch: options.jvmArch, lwjgl2: options.lwjgl2, glfw: options.glfw })
  }
  for (const i of plan.issues) issues.push({ kind: 'native', name: i.library, path: '', problem: 'unavailable', expected: {}, message: i.message })

  const files: Expect[] = []
  const client = version.downloads.client
  const mc = version.minecraftVersion
  files.push({
    kind: 'client',
    name: mc,
    path: path.join(d.versions, mc, `${mc}.jar`),
    url: client?.url,
    sha1: client?.sha1?.toLowerCase(),
    size: client?.size,
    policy: 'always',
  })
  for (const lib of plan.libraries) files.push(libraryExpect(lib, d.libraries))
  const logging = version.logging?.client
  if (logging) {
    files.push({
      kind: 'logConfig',
      name: logging.file.id,
      path: path.join(d.assets, 'log_configs', path.basename(logging.file.id)),
      url: logging.file.url,
      sha1: logging.file.sha1?.toLowerCase(),
      size: logging.file.size,
      policy: 'always',
    })
  }

  // Asset index: prefer `<id>.json`, accept the hash-named copy.
  let index: AssetIndex | undefined
  if (version.assetIndex || version.assets) {
    const candidates = assetIndexCandidates(d.assets, version)
    let found: string | undefined
    for (const c of candidates) if ((await stat(c).catch(() => undefined))?.isFile()) {
      found = c
      break
    }
    const ref = version.assetIndex
    const e: Expect = { kind: 'assetIndex', name: version.assets, path: found ?? (candidates[0] as string), url: ref?.url, sha1: ref?.sha1?.toLowerCase(), size: ref?.size, policy: 'always' }
    const problem = await check(e, mode, trustBefore, signal)
    if (problem) issues.push(problem)
    else if (options.assets !== false) {
      try {
        index = parseAssetIndex(await readFile(e.path, 'utf8'), e.path)
      } catch (err) {
        issues.push({ kind: 'assetIndex', name: version.assets, path: e.path, problem: 'corrupt', expected: { sha1: e.sha1, size: e.size }, url: e.url, message: (err as Error).message })
      }
    }
  }
  if (index) {
    const seen = new Set<string>()
    for (const [name, obj] of Object.entries(index.objects)) {
      if (seen.has(obj.hash)) continue
      seen.add(obj.hash)
      const hh = obj.hash.slice(0, 2)
      files.push({ kind: 'asset', name, path: assetObjectPath(d.assets, obj.hash), url: `https://resources.download.minecraft.net/${hh}/${obj.hash}`, sha1: obj.hash, size: obj.size, policy: 'onlyIfChanged' })
    }
  }

  let done = 0
  const results = await mapLimit(
    files,
    concurrency,
    async (e) => {
      const r = await check(e, mode, trustBefore, signal)
      if (ctx && (++done % 256 === 0 || done === files.length)) ctx.update(done, files.length)
      return r
    },
    signal,
  )
  for (const r of results) if (r) issues.push(r)
  return issues
}
