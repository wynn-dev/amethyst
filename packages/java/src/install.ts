import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { download, DownloadError, downloadMany, hashFile, type DownloadItem, type HttpClient } from '@amethyst/net'
import { mapLimit, type TaskContext } from '@amethyst/task'
import { abortError, type InstallAttempt, InstallError, isFatal, JavaError } from './errors'
import { decodeLzmaFile } from './lzma'
import { machOArch, readMachO } from './macho'
import {
  clearQuarantine,
  commitDir,
  type InstalledFile,
  type InstalledRuntime,
  type ManagedRuntime,
  readInstalledRuntime,
  verifyRuntime,
  withLock,
  writeInstalledRuntime,
} from './managed'
import {
  fetchRuntimeIndex,
  MAC_ARM64_PLATFORM,
  type PlannedFile,
  parseRuntimeManifest,
  planRuntime,
  type RuntimeIndex,
  type RuntimeIndexEntry,
  runtimeFor,
  type RuntimePlan,
} from './mojang'
import { probeJava } from './probe'
import { readReleaseFile } from './release'
import { extractTarGz } from './tar'
import { type ResolveOptions, resolveRuntimeFor, type RuntimeChoice } from './resolve'
import type { JavaRecord } from './types'
import { findZuluPackage, type ZuluPackage, type ZuluPackageType } from './zulu'

/** Options shared by every install and repair function. */
export interface InstallOptions {
  /** Managed runtimes directory, e.g. `<appData>/runtimes`. Created when missing. */
  runtimesDir: string
  client?: HttpClient
  /** Progress and cancellation. */
  ctx?: TaskContext
  signal?: AbortSignal
  /** Files downloaded at once (default 8). */
  concurrency?: number
  /** Remove `com.apple.quarantine` from the extracted runtime before it is moved into place (default `true`). */
  clearQuarantine?: boolean
  /** Spawn the installed `java` to confirm it starts and is arm64 (default `true`). */
  probe?: boolean
  /** Reinstall even if a valid install of the same build exists. */
  force?: boolean
}

/** Outcome of an install. */
export interface InstallResult {
  runtime: ManagedRuntime & { javaPath: string; installed: InstalledRuntime }
  /** The probed runtime; `verified` when `probe` was on. */
  java: JavaRecord
  /** An existing valid install of the same build was kept. */
  reused: boolean
  /** Mojang installs: how many files came via lzma, raw (no lzma or fallback), or a previous install. */
  transfer?: TransferStats
}

/** File sources of a Mojang install. */
export interface TransferStats {
  lzma: number
  raw: number
  reused: number
}

const STAGING_PREFIX = '.staging-'

function signalOf(options: InstallOptions): AbortSignal | undefined {
  if (options.signal && options.ctx) return AbortSignal.any([options.signal, options.ctx.signal])
  return options.signal ?? options.ctx?.signal
}

/** Run `fn` as a child task when a context is present. */
function step<T>(ctx: TaskContext | undefined, name: string, weight: number, fn: (ctx?: TaskContext) => Promise<T>): Promise<T> {
  return ctx ? ctx.child(name, (c) => fn(c), { weight }) : fn(undefined)
}

function relJoin(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

async function ensureArm64(javaPath: string): Promise<void> {
  const info = await readMachO(javaPath)
  if (!info || machOArch(info, 'arm64') !== 'arm64') {
    throw new JavaError('EBADARCH', `installed runtime is not arm64 (${info ? info.archs.join(', ') : 'not a Mach-O binary'})`)
  }
}

async function probeInstalled(dir: string, installed: InstalledRuntime, options: InstallOptions, signal?: AbortSignal): Promise<JavaRecord> {
  const javaPath = relJoin(dir, installed.javaPath)
  const record = await probeJava(javaPath, { spawn: options.probe === false ? 'never' : 'always', managedDir: options.runtimesDir, source: 'managed', timeoutMs: 20_000, signal })
  if (!record.valid) throw new JavaError('EJAVA_PROBE', `installed runtime ${installed.name} does not start (${record.invalidReason ?? 'unknown'})`)
  if (record.arch !== 'arm64') throw new JavaError('EBADARCH', `installed runtime ${installed.name} runs as ${record.arch}`)
  return record
}

async function result(dir: string, installed: InstalledRuntime, options: InstallOptions, reused: boolean, signal?: AbortSignal): Promise<InstallResult> {
  const java = await probeInstalled(dir, installed, options, signal)
  return { runtime: { name: installed.name, dir, javaPath: relJoin(dir, installed.javaPath), installed }, java, reused }
}

/** Snapshot sizes/mtimes of planned files after they are in their final place in `tree`. */
async function snapshotFiles(tree: string, files: readonly PlannedFile[]): Promise<Record<string, InstalledFile>> {
  const out: Record<string, InstalledFile> = {}
  await mapLimit(files, 16, async (f) => {
    const st = await lstat(relJoin(tree, f.path))
    out[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha1: f.raw.sha1, executable: f.executable }
  })
  return out
}

interface PlaceOptions {
  client?: HttpClient
  ctx?: TaskContext
  signal?: AbortSignal
  concurrency: number
  /** Directory for downloaded `.lzma` blobs. */
  scratch: string
  /** A previous install to copy unchanged files from (APFS clone when possible). */
  previous?: { dir: string; installed: InstalledRuntime }
}

/**
 * Put every planned file into `tree`, verified against its raw sha1/size: reuse unchanged files
 * from a previous install, otherwise download the lzma variant and stream-decode it, falling
 * back to the raw download when the lzma download, decode or verification fails.
 */
async function placeFiles(files: readonly PlannedFile[], tree: string, options: PlaceOptions): Promise<TransferStats> {
  const { signal } = options
  const stats = { lzma: 0, raw: 0, reused: 0 }
  let todo = [...files]

  if (options.previous) {
    const prev = options.previous
    const reused = await mapLimit(
      todo,
      16,
      async (f) => {
        const old = prev.installed.files[f.path]
        if (!old || old.sha1 !== f.raw.sha1 || old.size !== f.raw.size) return false
        const src = relJoin(prev.dir, f.path)
        const st = await lstat(src).catch(() => undefined)
        if (!st?.isFile() || st.size !== old.size || st.mtimeMs !== old.mtimeMs) return false
        await copyFile(src, relJoin(tree, f.path), constants.COPYFILE_FICLONE)
        return true
      },
      signal,
    )
    stats.reused = reused.filter(Boolean).length
    todo = todo.filter((_, i) => !reused[i])
  }

  const rawItem = (f: PlannedFile): DownloadItem => ({ url: f.raw.url, dest: relJoin(tree, f.path), size: f.raw.size, checksum: { algorithm: 'sha1', value: f.raw.sha1 } })
  const lzmaPath = (f: PlannedFile) => join(options.scratch, `${f.lzma?.sha1}.lzma`)
  const withLzma = todo.filter((f) => f.lzma)
  const fallback: PlannedFile[] = []
  const failedDests = new Set<string>()

  const items: DownloadItem[] = [
    ...todo.filter((f) => !f.lzma).map(rawItem),
    ...withLzma.map((f) => ({ url: f.lzma!.url, dest: lzmaPath(f), size: f.lzma!.size, checksum: { algorithm: 'sha1' as const, value: f.lzma!.sha1 } })),
  ]
  await step(options.ctx, 'download', 8, async (ctx) => {
    try {
      await downloadMany(items, { client: options.client, ctx, signal, concurrency: options.concurrency, existing: 'replace', resume: false })
    } catch (e) {
      if (!(e instanceof DownloadError) || signal?.aborted) throw e
      for (const failure of e.failures) {
        if (isFatal(failure.error, signal)) throw failure.error
        failedDests.add(failure.item.dest)
      }
    }
  })
  for (const f of todo) {
    if (!f.lzma && failedDests.has(relJoin(tree, f.path))) throw new JavaError('EINSTALL', `could not download ${f.path}`)
  }

  await step(options.ctx, 'decompress', 2, async (ctx) => {
    ctx?.update(0, withLzma.length)
    let done = 0
    await mapLimit(
      withLzma,
      4,
      async (f) => {
        try {
          if (failedDests.has(lzmaPath(f))) throw new JavaError('ELZMA', 'lzma download failed')
          await decodeLzmaFile(lzmaPath(f), relJoin(tree, f.path), { size: f.raw.size, sha1: f.raw.sha1, signal })
          stats.lzma++
        } catch (e) {
          if (isFatal(e, signal)) throw e
          fallback.push(f)
        }
        ctx?.update(++done)
      },
      signal,
    )
  })

  if (fallback.length > 0) {
    await step(options.ctx, 'download-raw', 1, (ctx) => downloadMany(fallback.map(rawItem), { client: options.client, ctx, signal, concurrency: options.concurrency, existing: 'replace' }))
  }
  stats.raw = todo.length - stats.lzma
  return stats
}

/** Create directories, set modes and create symlinks (relative, exactly as in the manifest). */
async function applyLayout(tree: string, plan: RuntimePlan): Promise<void> {
  for (const d of plan.directories) {
    // oxlint-disable-next-line no-await-in-loop -- parents first
    await mkdir(relJoin(tree, d), { recursive: true })
  }
  await mapLimit(plan.files, 16, (f) => chmod(relJoin(tree, f.path), f.executable ? 0o755 : 0o644))
  for (const l of plan.links) {
    const abs = relJoin(tree, l.path)
    // oxlint-disable-next-line no-await-in-loop -- links are few and cheap
    await unlink(abs).catch(() => {})
    // oxlint-disable-next-line no-await-in-loop
    await symlink(l.target, abs)
  }
}

export interface MojangInstallOptions extends InstallOptions {
  /** A pre-fetched runtime index (cache it; it rarely changes). */
  index?: RuntimeIndex
  indexUrl?: string
  /** The exact index entry to install (skips the index lookup). */
  entry?: RuntimeIndexEntry
}

/**
 * Install Mojang's `mac-os-arm64` build of `component` into `<runtimesDir>/<component>/`.
 *
 * The component manifest is downloaded and verified against the index's sha1/size, then every
 * file is fetched (lzma where offered, decoded and verified against the raw sha1, raw otherwise)
 * into a staging folder, laid out (directories, `0755` executables including `jspawnhelper`,
 * relative symlinks), recorded in {@link INSTALLED_MANIFEST}, de-quarantined, checked to be an
 * arm64 Mach-O, and atomically renamed into place. An existing valid install of the same build
 * is kept (`reused`); a different build reuses unchanged files from it.
 */
export async function installMojangRuntime(component: string, options: MojangInstallOptions): Promise<InstallResult> {
  const signal = signalOf(options)
  const dest = join(options.runtimesDir, component)
  return withLock(dest, async () => {
    await mkdir(options.runtimesDir, { recursive: true })
    const entry =
      options.entry ?? runtimeFor(options.index ?? (await fetchRuntimeIndex({ client: options.client, signal, url: options.indexUrl })), component, MAC_ARM64_PLATFORM)
    if (!entry) throw new JavaError('ENORUNTIME', `Mojang ships no ${MAC_ARM64_PLATFORM} build of ${component}`)

    const previous = await readInstalledRuntime(dest)
    if (!options.force && previous?.source === 'mojang' && previous.mojang?.manifestSha1 === entry.manifest.sha1) {
      const report = await verifyRuntime(dest, { signal })
      if (report.ok) return result(dest, previous, options, true, signal)
    }

    const staging = await mkdtemp(join(options.runtimesDir, `${STAGING_PREFIX}${component}-`))
    try {
      const tree = join(staging, 'tree')
      const scratch = join(staging, 'lzma')
      await mkdir(tree)
      await mkdir(scratch)
      const manifestFile = join(tree, 'manifest.json')
      await download(
        { url: entry.manifest.url, dest: manifestFile, size: entry.manifest.size, checksum: { algorithm: 'sha1', value: entry.manifest.sha1 } },
        { client: options.client, signal },
      )
      let manifestJson: unknown
      try {
        manifestJson = JSON.parse(await readFile(manifestFile, 'utf8'))
      } catch (e) {
        throw new JavaError('EBADMANIFEST', `runtime manifest for ${component} is not JSON`, { cause: e })
      }
      const plan = planRuntime(parseRuntimeManifest(manifestJson))
      if (!plan.javaPath) throw new JavaError('EBADMANIFEST', `runtime manifest for ${component} has no bin/java`)
      for (const d of plan.directories) {
        // oxlint-disable-next-line no-await-in-loop -- parents first
        await mkdir(relJoin(tree, d), { recursive: true })
      }
      const transfer = await placeFiles(plan.files, tree, {
        client: options.client,
        ctx: options.ctx,
        signal,
        concurrency: options.concurrency ?? 8,
        scratch,
        ...(previous?.source === 'mojang' ? { previous: { dir: dest, installed: previous } } : {}),
      })
      await step(options.ctx, 'layout', 1, async () => {
        await applyLayout(tree, plan)
      })
      const javaAbs = relJoin(tree, plan.javaPath)
      await ensureArm64(javaAbs)
      const release = await readReleaseFile(dirname(dirname(javaAbs)))
      const installed: InstalledRuntime = {
        schema: 1,
        source: 'mojang',
        name: component,
        component,
        majorVersion: entry.majorVersion,
        version: release?.JAVA_VERSION ?? entry.version,
        arch: 'arm64',
        javaPath: plan.javaPath,
        installedAt: new Date().toISOString(),
        mojang: { platform: MAC_ARM64_PLATFORM, manifestSha1: entry.manifest.sha1, manifestSize: entry.manifest.size, manifestUrl: entry.manifest.url },
        files: await snapshotFiles(tree, plan.files),
        links: Object.fromEntries(plan.links.map((l) => [l.path, l.target])),
      }
      await writeInstalledRuntime(tree, installed)
      if (options.clearQuarantine !== false) await clearQuarantine(tree, signal)
      if (signal?.aborted) throw abortError(signal)
      await commitDir(tree, dest, staging)
      return { ...(await result(dest, installed, options, false, signal)), transfer }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}

/** A regular file is reachable from `root` without following any symlink. */
async function realFile(root: string, rel: string): Promise<boolean> {
  let cur = root
  const parts = rel.split('/')
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i] as string)
    // oxlint-disable-next-line no-await-in-loop -- a handful of components
    const st = await lstat(cur).catch(() => undefined)
    if (!st || st.isSymbolicLink()) return false
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return false
  }
  return true
}

/**
 * Find the runtime inside an extracted Azul archive. Newer archives are the bundle itself
 * (`<top>/Contents/Home`); older ones nest `zulu-N.jre/Contents/Home` next to convenience
 * symlinks. Returns a directory holding `Contents/Home/bin/java` (a bundle) or `bin/java` (a bare
 * home), reached without following symlinks.
 */
export async function locateJavaBundle(root: string, maxDepth = 3): Promise<{ kind: 'bundle' | 'home'; dir: string } | undefined> {
  let level = [root]
  let home: string | undefined
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      // oxlint-disable-next-line no-await-in-loop -- breadth-first over a tiny tree
      if (await realFile(dir, 'Contents/Home/bin/java')) return { kind: 'bundle', dir }
      // oxlint-disable-next-line no-await-in-loop
      if (!home && (await realFile(dir, 'bin/java'))) home = dir
      // oxlint-disable-next-line no-await-in-loop
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const c of children) if (c.isDirectory() && c.name !== 'Contents' && !c.name.startsWith('.')) next.push(join(dir, c.name))
    }
    level = next
  }
  return home ? { kind: 'home', dir: home } : undefined
}

/** Record every file (with sha1) and symlink of a tree for later verification. */
async function describeTree(root: string, signal?: AbortSignal): Promise<{ files: Record<string, InstalledFile>; links: Record<string, string> }> {
  const files: Record<string, InstalledFile> = {}
  const links: Record<string, string> = {}
  const regular: { rel: string; abs: string }[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const abs = join(dir, e.name)
      // oxlint-disable-next-line no-await-in-loop -- a depth-first walk of one runtime
      if (e.isDirectory()) await walk(abs, rel)
      // oxlint-disable-next-line no-await-in-loop
      else if (e.isSymbolicLink()) links[rel] = await readlink(abs)
      else if (e.isFile()) regular.push({ rel, abs })
    }
  }
  await walk(root, '')
  await mapLimit(
    regular,
    8,
    async ({ rel, abs }) => {
      const [st, sha1] = await Promise.all([lstat(abs), hashFile(abs, 'sha1', signal)])
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha1, executable: (st.mode & 0o111) !== 0 }
    },
    signal,
  )
  return { files, links }
}

export interface ZuluInstallOptions extends InstallOptions {
  /** A pre-fetched package (skips the API lookup). */
  package?: ZuluPackage
  /** Azul API base (tests). */
  apiBase?: string
  packageType?: ZuluPackageType
  javafx?: boolean
}

/**
 * Install the newest GA Azul Zulu build of `major` for macOS aarch64 into
 * `<runtimesDir>/zulu-<major>/`. The archive is verified by sha256 and size, extracted with the
 * safe tar reader, and normalised so the runtime folder is a bundle: `Contents/Home/bin/java`.
 */
export async function installZuluRuntime(major: number, options: ZuluInstallOptions): Promise<InstallResult> {
  const signal = signalOf(options)
  const name = `zulu-${major}`
  const dest = join(options.runtimesDir, name)
  return withLock(dest, async () => {
    await mkdir(options.runtimesDir, { recursive: true })
    const pkg =
      options.package ??
      (await findZuluPackage(major, { client: options.client, signal, apiBase: options.apiBase, javafx: options.javafx, allowJdk: options.packageType !== 'jre' }))
    const previous = await readInstalledRuntime(dest)
    if (!options.force && previous?.source === 'zulu' && previous.zulu?.sha256 === pkg.sha256) {
      const report = await verifyRuntime(dest, { signal })
      if (report.ok) return result(dest, previous, options, true, signal)
    }

    const staging = await mkdtemp(join(options.runtimesDir, `${STAGING_PREFIX}${name}-`))
    try {
      const archive = join(staging, basename(pkg.name).replace(/[^\w.+-]/g, '_') || 'zulu.tar.gz')
      // Azul's `size` is rounded (e.g. 40166300 for a 40166281-byte archive), so only the
      // sha256 is enforced; the size merely bounds what we accept.
      await step(options.ctx, 'download', 8, async (ctx) => {
        await download({ url: pkg.downloadUrl, dest: archive, checksum: { algorithm: 'sha256', value: pkg.sha256 } }, { client: options.client, ctx, signal })
        const actual = (await lstat(archive)).size
        if (Math.abs(actual - pkg.size) > Math.max(4096, pkg.size * 0.01)) {
          throw new JavaError('EBADARCHIVE', `${pkg.name} is ${actual} bytes, Azul reports about ${pkg.size}`)
        }
      })
      const extracted = join(staging, 'x')
      await step(options.ctx, 'extract', 2, () => extractTarGz(archive, extracted, { signal }))
      await rm(archive, { force: true })

      const found = await locateJavaBundle(extracted)
      if (!found) throw new JavaError('EBADARCHIVE', `${pkg.name} contains no bin/java`)
      const tree = join(staging, 'tree')
      if (found.kind === 'bundle') await rename(found.dir, tree)
      else {
        await mkdir(join(tree, 'Contents'), { recursive: true })
        await rename(found.dir, join(tree, 'Contents', 'Home'))
      }
      const javaPath = 'Contents/Home/bin/java'
      await chmod(relJoin(tree, javaPath), 0o755)
      await ensureArm64(relJoin(tree, javaPath))
      const release = await readReleaseFile(join(tree, 'Contents', 'Home'))
      const { files, links } = await step(options.ctx, 'record', 1, () => describeTree(tree, signal))
      const installed: InstalledRuntime = {
        schema: 1,
        source: 'zulu',
        name,
        majorVersion: major,
        version: release?.JAVA_VERSION ?? pkg.javaVersion.join('.'),
        arch: 'arm64',
        javaPath,
        installedAt: new Date().toISOString(),
        zulu: { packageUuid: pkg.packageUuid, name: pkg.name, url: pkg.downloadUrl, sha256: pkg.sha256, size: pkg.size, packageType: pkg.packageType, javaVersion: pkg.javaVersion },
        files,
        links,
      }
      await writeInstalledRuntime(tree, installed)
      if (options.clearQuarantine !== false) await clearQuarantine(tree, signal)
      if (signal?.aborted) throw abortError(signal)
      await commitDir(tree, dest, staging)
      return result(dest, installed, options, false, signal)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}

export interface JavaInstallRequest {
  majorVersion: number
  /** The Mojang component from the version JSON, if any. */
  component?: string
}

export interface InstallJavaOptions extends InstallOptions, Omit<ResolveOptions, 'index' | 'component'> {
  index?: RuntimeIndex
  indexUrl?: string
  apiBase?: string
}

/**
 * Install a native runtime for a requirement: {@link resolveRuntimeFor} picks Mojang or Zulu
 * from the live index, and if the Mojang install fails, Zulu is tried. Every failed candidate is
 * collected; when all fail an {@link InstallError} lists them, so the install never ends silently.
 */
export async function installJavaRuntime(request: JavaInstallRequest, options: InstallJavaOptions): Promise<InstallResult & { choice: RuntimeChoice }> {
  const signal = signalOf(options)
  const attempts: InstallAttempt[] = []
  let index = options.index
  if (!index && !options.forceZulu) {
    try {
      index = await fetchRuntimeIndex({ client: options.client, signal, url: options.indexUrl })
    } catch (e) {
      if (isFatal(e, signal)) throw e
      attempts.push({ source: 'mojang', target: 'runtime index', error: e as Error })
    }
  }
  const choice = resolveRuntimeFor(request.majorVersion, { ...options, index, component: request.component })
  if (choice.source === 'mojang') {
    try {
      const r = await step(options.ctx, `mojang:${choice.component}`, 1, (ctx) => installMojangRuntime(choice.component, { ...options, ctx, signal, entry: choice.entry }))
      return { ...r, choice }
    } catch (e) {
      if (isFatal(e, signal)) throw e
      attempts.push({ source: 'mojang', target: choice.component, error: e as Error })
    }
  }
  const zuluMajor = choice.majorVersion
  try {
    const r = await step(options.ctx, `zulu:${zuluMajor}`, 1, (ctx) => installZuluRuntime(zuluMajor, { ...options, ctx, signal }))
    return { ...r, choice: choice.source === 'zulu' ? choice : { source: 'zulu', majorVersion: zuluMajor, reason: `${choice.reason} The Mojang install failed, so Azul Zulu is used.` } }
  } catch (e) {
    if (isFatal(e, signal)) throw e
    attempts.push({ source: 'zulu', target: `zulu-${zuluMajor}`, error: e as Error })
  }
  throw new InstallError(attempts)
}

/** Outcome of {@link repairRuntime}. */
export interface RepairResult {
  /** Paths that were re-downloaded, re-moded or re-linked. */
  repaired: string[]
  /** The whole runtime was reinstalled (Zulu archives cannot be patched per file). */
  reinstalled: boolean
  java: JavaRecord
}

/**
 * Fully verify a managed runtime (hashing every file) and fix what is wrong. Mojang runtimes are
 * patched per file from their manifest (lzma first, raw fallback), with modes and symlinks
 * restored; each repaired file is renamed into place atomically. Zulu runtimes are reinstalled.
 * Throws `EVERIFY` when the folder has no install record (reinstall it instead).
 */
export async function repairRuntime(dir: string, options: InstallOptions): Promise<RepairResult> {
  const signal = signalOf(options)
  const report = await step(options.ctx, 'verify', 1, () => verifyRuntime(dir, { full: true, signal }))
  const installed = report.installed
  if (!installed) throw new JavaError('EVERIFY', `${dir} has no install record; reinstall it`)
  if (report.ok) return { repaired: [], reinstalled: false, java: await probeInstalled(dir, installed, options, signal) }

  if (installed.source === 'zulu') {
    const z = installed.zulu
    if (!z) throw new JavaError('EVERIFY', `${dir} has an incomplete install record; reinstall it`)
    // Reinstall the exact recorded build; its sha256 is already known.
    const pkg: ZuluPackage = {
      packageUuid: z.packageUuid,
      name: z.name,
      downloadUrl: z.url,
      javaVersion: z.javaVersion,
      distroVersion: [],
      latest: false,
      sha256: z.sha256,
      size: z.size,
      packageType: z.packageType,
      archiveType: 'tar.gz',
      os: 'macos',
      arch: 'aarch64',
      javafx: false,
    }
    const r = await installZuluRuntime(installed.majorVersion, { ...options, runtimesDir: dirname(dir), force: true, package: pkg })
    return { repaired: report.problems.map((p) => p.path), reinstalled: true, java: r.java }
  }

  const mojang = installed.mojang
  if (!mojang) throw new JavaError('EVERIFY', `${dir} has an incomplete install record; reinstall it`)
  return withLock(dir, async () => {
    const staging = await mkdtemp(join(dirname(dir), `${STAGING_PREFIX}repair-${installed.name}-`))
    try {
      const manifestFile = join(staging, 'manifest.json')
      await download({ url: mojang.manifestUrl, dest: manifestFile, size: mojang.manifestSize, checksum: { algorithm: 'sha1', value: mojang.manifestSha1 } }, { client: options.client, signal })
      const plan = planRuntime(parseRuntimeManifest(JSON.parse(await readFile(manifestFile, 'utf8'))))
      const broken = new Set(report.problems.filter((p) => p.problem !== 'mode' && p.problem !== 'link').map((p) => p.path))
      const toFetch = plan.files.filter((f) => broken.has(f.path))
      const tree = join(staging, 'tree')
      const scratch = join(staging, 'lzma')
      await mkdir(scratch, { recursive: true })
      for (const f of toFetch) {
        // oxlint-disable-next-line no-await-in-loop -- parents of a few files
        await mkdir(dirname(relJoin(tree, f.path)), { recursive: true })
      }
      await placeFiles(toFetch, tree, { client: options.client, ctx: options.ctx, signal, concurrency: options.concurrency ?? 8, scratch })
      for (const d of plan.directories) {
        // oxlint-disable-next-line no-await-in-loop -- parents first
        await mkdir(relJoin(dir, d), { recursive: true })
      }
      for (const f of toFetch) {
        const finalPath = relJoin(dir, f.path)
        // oxlint-disable-next-line no-await-in-loop -- replace one file at a time
        await rm(finalPath, { recursive: true, force: true })
        // oxlint-disable-next-line no-await-in-loop
        await rename(relJoin(tree, f.path), finalPath)
      }
      await applyLayout(dir, plan)
      installed.files = await snapshotFiles(dir, plan.files)
      installed.links = Object.fromEntries(plan.links.map((l) => [l.path, l.target]))
      await writeInstalledRuntime(dir, installed)
      return { repaired: report.problems.map((p) => p.path), reinstalled: false, java: await probeInstalled(dir, installed, options, signal) }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}
