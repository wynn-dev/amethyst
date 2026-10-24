import { join } from 'node:path'
import type { DiagnoseIssue } from '@amethyst/game'
import { ensureFiles, type FileSpec } from './files'
import { pathExists } from './fs-util'
import type { ForgeInstallOptions } from './forge/common'
import { forgeMutex } from './forge/common'
import { rerunStoredProfile } from './forge/modern'
import { resolveInstalled, secureUrl } from './libraries'
import { type InstallOptions, signalOf, step } from './options'

/**
 * A file that a diagnose pass found missing or corrupt. This is `@amethyst/game`'s
 * `DiagnoseIssue`; only the fields the installer needs are required.
 */
export type MissingFile = Pick<DiagnoseIssue, 'kind' | 'name' | 'path' | 'expected'> & Partial<Pick<DiagnoseIssue, 'url' | 'problem'>>

/** Result of {@link installMissing}. */
export interface InstallMissingResult {
  /** Paths that were downloaded and verified. */
  repaired: string[]
  /**
   * Issues that cannot be fixed by downloading: files without a URL (produced by Forge/NeoForge
   * processors) and natives with no known arm64 build.
   */
  unresolved: MissingFile[]
}

/** Turn a diagnose issue into a download spec (`undefined` when it has no URL or path). */
export function issueFileSpec(issue: MissingFile): FileSpec | undefined {
  if (!issue.url || !issue.path) return undefined
  const spec: FileSpec = { path: issue.path, urls: [secureUrl(issue.url)], name: issue.name }
  const e = issue.expected
  if (e.sha1Alternatives?.length) spec.sha1Any = [...(e.sha1 ? [e.sha1] : []), ...e.sha1Alternatives]
  else if (e.sha1) spec.sha1 = e.sha1
  if (e.sha256) spec.sha256 = e.sha256
  if (e.size !== undefined) spec.size = e.size
  if (!spec.sha1 && !spec.sha1Any && !spec.sha256) spec.validator = /\.(jar|zip)$/i.test(issue.path) ? 'zip' : issue.kind === 'assetIndex' ? 'json' : undefined
  if (!spec.validator) delete spec.validator
  return spec
}

/**
 * Re-download exactly the files a diagnose step reported (`install.md` §10.3), replacing whatever
 * is on disk and verifying the new bytes. Issues without a URL are returned as `unresolved`.
 */
export async function installMissing(issues: readonly MissingFile[], options: InstallOptions): Promise<InstallMissingResult> {
  const specs: FileSpec[] = []
  const unresolved: MissingFile[] = []
  for (const issue of issues) {
    const spec = issueFileSpec(issue)
    if (spec) specs.push(spec)
    else unresolved.push(issue)
  }
  if (specs.length > 0) {
    await ensureFiles(specs, { signal: signalOf(options), ctx: options.ctx, http: options.http, concurrency: options.concurrency, replace: true })
  }
  return { repaired: specs.map((s) => s.path), unresolved }
}

/** Options for {@link repairVersion}. */
export interface RepairOptions extends ForgeInstallOptions {
  /**
   * The diagnose step, normally `@amethyst/game`'s `diagnose(resolved, root, {...})` bound to the
   * version and the selected JVM. Called before and after the repair.
   */
  diagnose: (signal?: AbortSignal) => Promise<readonly MissingFile[]>
}

/** Result of {@link repairVersion}. */
export interface RepairResult {
  /** Issues found before repairing. */
  before: readonly MissingFile[]
  /** Issues left afterwards (empty when the version is healthy). */
  after: readonly MissingFile[]
  repaired: string[]
  /** True when Forge/NeoForge processors were re-run from the stored install profile. */
  reranProcessors: boolean
}

/**
 * Diagnose a version, re-download what is broken, and re-run the Forge/NeoForge processors when a
 * file without a URL (a processor product) is missing — the stored
 * `versions/<id>/install_profile.json` of the chain is used. Diagnoses again at the end.
 */
export async function repairVersion(versionId: string, options: RepairOptions): Promise<RepairResult> {
  const signal = signalOf(options)
  const before = await step(options.ctx, 'diagnose', 1, () => options.diagnose(signal))
  if (before.length === 0) return { before, after: before, repaired: [], reranProcessors: false }
  const { repaired, unresolved } = await step(options.ctx, 'download', Math.max(1, before.length), (ctx) => installMissing(before, { ...options, ctx }))
  let reranProcessors = false
  if (unresolved.some((i) => i.problem !== 'unavailable')) {
    const chain = await resolveInstalled(options.root, versionId, signal)
    for (const id of chain.inheritances) {
      // oxlint-disable-next-line no-await-in-loop -- at most a few layers
      if (!(await pathExists(join(options.root, 'versions', id, 'install_profile.json')))) continue
      // oxlint-disable-next-line no-await-in-loop -- see above
      await step(options.ctx, 'processors', 4, (ctx) => forgeMutex.run('forge', () => rerunStoredProfile(id, { ...options, ctx }), signal))
      reranProcessors = true
      break
    }
  }
  const after = await step(options.ctx, 'verify', 1, () => options.diagnose(signal))
  return { before, after, repaired, reranProcessors }
}
