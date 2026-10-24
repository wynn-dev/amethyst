/**
 * Modpacks through `@amethyst/modpack`: preview, import (from a file, a URL or the marketplace),
 * blocked CurseForge files (the compliant manual-download flow), updates with a reviewable
 * plan and rollback, and export to `.mrpack` / CurseForge zips.
 *
 * An import is one `modpack.import` task: read → resolve the file list (CurseForge ids through the
 * API; files without a download URL become manual downloads, never guessed URLs) → create the
 * instance → install its game version and the pack files in parallel. A failed or cancelled
 * file install keeps the instance; importing again with `instanceId` resumes it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  applyModpackUpdate,
  exportCurseForge,
  exportModrinth,
  installModpack,
  matchManualFiles,
  planModpackUpdate,
  readModpack,
  readModpackLock,
  resolveModpackFiles,
  rollbackModpackUpdate,
  watchForManualFiles,
  type ManualDownload,
  type ManualFileWatcher,
  type ModpackManifest,
  type ModpackUpdatePlan,
  type ModpackUpstream,
  type ResolvedModpack,
} from '@amethyst/modpack'
import type { CurseForgeClient, ModrinthClient } from '@amethyst/marketplace'
import { download, type HttpClient } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import type {
  InstanceDetail,
  InstanceUpstream,
  LoaderKind,
  MarketPlatform,
  ModpackExportInput,
  ModpackExportResult,
  ModpackImportInput,
  ModpackImportResult,
  ModpackManualFile,
  ModpackPreview,
  ModpackService,
  ModpackSource,
  ModpackUpdateInfo,
  ModpackUpdatePlanView,
  ModpackUpdateResult,
  Settings,
} from '@shared/services'
import type { Emit } from '../context'
import type { InstallManager } from '../install/service'
import type { InstanceManager } from '../instances/service'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import type { MarketplaceManager } from '../marketplace/service'
import type { ResourceManager } from '../resources/service'
import type { TaskRegistry } from '../tasks/registry'
import type { TelemetryHooks } from '../telemetry'
import { AppError, errorCode, errorMessage, invalid, isAbortError } from '../util/errors'

const log = logger('modpacks')

/** The `@amethyst/modpack` functions used here (replaceable in tests). */
export interface ModpackApi {
  readModpack: typeof readModpack
  resolveModpackFiles: typeof resolveModpackFiles
  installModpack: typeof installModpack
  matchManualFiles: typeof matchManualFiles
  watchForManualFiles: typeof watchForManualFiles
  planModpackUpdate: typeof planModpackUpdate
  applyModpackUpdate: typeof applyModpackUpdate
  rollbackModpackUpdate: typeof rollbackModpackUpdate
  exportModrinth: typeof exportModrinth
  exportCurseForge: typeof exportCurseForge
  readModpackLock: typeof readModpackLock
}

const defaultApi: ModpackApi = {
  readModpack,
  resolveModpackFiles,
  installModpack,
  matchManualFiles,
  watchForManualFiles,
  planModpackUpdate,
  applyModpackUpdate,
  rollbackModpackUpdate,
  exportModrinth,
  exportCurseForge,
  readModpackLock,
}

export interface ModpackDeps {
  layout: DataLayout
  emit: Emit
  tasks: TaskRegistry
  settings: { readonly value: Settings }
  instances: Pick<InstanceManager, 'create' | 'resolve' | 'update' | 'list' | 'get'>
  install: Pick<InstallManager, 'install'>
  resources: Pick<ResourceManager, 'store' | 'autoBackupWorlds'>
  market: Pick<MarketplaceManager, 'clients'>
  http: () => Promise<HttpClient>
  telemetry: Pick<TelemetryHooks, 'capture'>
  api?: Partial<ModpackApi>
  /** Folder watched for manual downloads (default `~/Downloads`). */
  downloadsDir?: string
  /** How long a manual-download watcher runs (default 30 minutes). */
  watchTimeoutMs?: number
}

/** What is needed to place manual files later (kept in memory; bounded). */
interface PendingPack {
  manifest: ModpackManifest
  resolved: ResolvedModpack
  upstream?: ModpackUpstream
  selectedOptional?: string[]
  manual: ManualDownload[]
}

interface StoredPlan {
  plan: ModpackUpdatePlan
  instanceId: string
  upstream: ModpackUpstream
  target: { versionId: string; name: string }
  createdAt: number
}

const MAX_PENDING = 32
const PLAN_TTL_MS = 30 * 60_000
const DEFAULT_EXPORT_INCLUDE = ['mods/', 'resourcepacks/', 'shaderpacks/', 'config/', 'defaultconfigs/', 'kubejs/', 'scripts/', 'options.txt']

function manualRow(m: ManualDownload): ModpackManualFile {
  return { name: m.name, fileName: m.fileName, websiteUrl: m.websiteUrl, path: m.path, size: m.size, projectId: m.projectId, fileId: m.fileId }
}

function loaderRow(l: ModpackManifest['loader']): { kind: LoaderKind; version: string } | null {
  return l ? { kind: l.id, version: l.version } : null
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

/** Typed errors keep their code; others become `EMODPACK_FAILED`. */
function mapError(e: unknown): unknown {
  if (e instanceof AppError || isAbortError(e)) return e
  const code = errorCode(e)
  if (!code) return e
  const details = (e as { details?: unknown }).details
  return new AppError(code, errorMessage(e), details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined, { cause: e })
}

export class ModpackManager {
  readonly #d: ModpackDeps
  readonly #api: ModpackApi
  readonly #pending = new Map<string, PendingPack>()
  readonly #watchers = new Map<string, ManualFileWatcher>()
  readonly #plans = new Map<string, StoredPlan>()
  readonly #busy = new Set<string>()
  readonly #previews = new Map<string, Promise<ModpackManifest>>()

  constructor(deps: ModpackDeps) {
    this.#d = deps
    this.#api = { ...defaultApi, ...deps.api }
  }

  /** An import or update writes into this instance. */
  isBusy(instanceId: string): boolean {
    return this.#busy.has(instanceId)
  }

  #clients(): { modrinth: ModrinthClient; curseforge: CurseForgeClient | undefined } {
    return this.#d.market.clients()
  }

  // -------------------------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------------------------

  /** A local archive for a source: the file itself, or a cached download of the URL. */
  async #archive(source: ModpackSource, ctx?: TaskContext, expected?: { sha1?: string; size?: number }): Promise<string> {
    if (source && 'path' in source && typeof source.path === 'string') {
      if (!path.isAbsolute(source.path)) throw invalid('An absolute file path is required')
      return source.path
    }
    const url = source && 'url' in source ? source.url : undefined
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw invalid('An https: URL or a file path is required')
    await mkdir(this.#d.layout.modpackCache, { recursive: true })
    const dest = path.join(this.#d.layout.modpackCache, `${sha1(url)}${/\.mrpack(\?|$)/i.test(url) ? '.mrpack' : '.zip'}`)
    const client = await this.#d.http()
    const run = (c?: TaskContext) =>
      download(
        { url, dest, ...(expected?.size ? { size: expected.size } : {}), ...(expected?.sha1 ? { checksum: { algorithm: 'sha1', value: expected.sha1 } } : {}) },
        { client, ...(c ? { ctx: c } : {}), existing: expected?.sha1 ? 'verify' : 'replace' },
      )
    if (ctx) await ctx.child('modpack.download', (c) => run(c))
    else await run()
    return dest
  }

  /** Read a pack once per archive (shared by concurrent callers). */
  #read(archive: string): Promise<ModpackManifest> {
    let p = this.#previews.get(archive)
    if (!p) {
      p = this.#api.readModpack(archive)
      p.catch(() => this.#previews.delete(archive))
      this.#previews.set(archive, p)
      while (this.#previews.size > 8) this.#previews.delete(this.#previews.keys().next().value as string)
    }
    return p
  }

  #existingInstance(manifest: ModpackManifest, upstream?: ModpackUpstream): string | null {
    const rows = this.#d.instances.list()
    if (upstream) {
      for (const row of rows) {
        let detail: InstanceDetail
        try {
          detail = this.#d.instances.get(row.id)
        } catch {
          continue
        }
        const u = detail.upstream
        if (u && u.kind === upstream.kind && String(u.projectId) === String(upstream.projectId)) return row.id
      }
    }
    return rows.find((r) => r.name.toLowerCase() === manifest.name.toLowerCase())?.id ?? null
  }

  async preview(source: ModpackSource): Promise<ModpackPreview> {
    try {
      const manifest = await this.#read(await this.#archive(source))
      return {
        format: manifest.format,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author ?? null,
        summary: manifest.summary ?? null,
        minecraft: manifest.minecraft,
        loader: loaderRow(manifest.loader),
        fileCount: manifest.files.length,
        overrideCount: manifest.overrides.length,
        warnings: manifest.warnings.map((w) => w.message),
        existingInstanceId: this.#existingInstance(manifest),
      }
    } catch (e) {
      throw mapError(e)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------------------------

  async import(input: ModpackImportInput, origin: { upstream?: ModpackUpstream; expected?: { sha1?: string; size?: number } } = {}): Promise<ModpackImportResult> {
    if (!input || typeof input !== 'object' || !input.source) throw invalid('A modpack source is required')
    const sourceKind: 'file' | 'modrinth' | 'curseforge' = origin.upstream?.kind ?? 'file'
    let instanceId = input.instanceId
    try {
      return await this.#d.tasks.runAndWait({ name: 'modpack.import', params: { name: input.name ?? '' }, ...(instanceId ? { instanceId } : {}) }, async (ctx) => {
        const archive = await this.#archive(input.source, ctx, origin.expected)
        const manifest = await this.#read(archive)
        const { modrinth, curseforge } = this.#clients()
        if (manifest.format === 'curseforge' && !curseforge) {
          throw new AppError('EMARKET_UNAVAILABLE', 'CurseForge is not available in this build, so CurseForge modpacks cannot be imported', { platform: 'curseforge' })
        }
        const resolved = await ctx.child('modpack.resolve', (c) => this.#api.resolveModpackFiles(manifest, { modrinth, ...(curseforge ? { curseforge } : {}), ctx: c }))
        const upstream = origin.upstream ? { ...origin.upstream, packSha1: manifest.sha1 } : undefined

        // The instance (or the one being resumed).
        if (instanceId) {
          this.#d.instances.resolve(instanceId)
        } else {
          const runtime: Record<string, string> = { minecraft: manifest.minecraft }
          if (manifest.loader) runtime[manifest.loader.id] = manifest.loader.version
          const created = await this.#d.instances.create({
            name: input.name?.trim() || manifest.name,
            runtime: runtime as { minecraft: string },
            ...(manifest.author ? { author: manifest.author } : {}),
            ...(manifest.summary ? { description: manifest.summary } : {}),
            ...(upstream ? { upstream: upstream as InstanceUpstream } : {}),
          })
          instanceId = created.id
        }
        const id = instanceId
        this.#busy.add(id)
        try {
          const dir = this.#d.instances.resolve(id).dir
          const client = await this.#d.http()
          // The game version and the files are independent: install both at once.
          const [runtime, files] = await Promise.allSettled([
            this.#d.install.install(id, { ctx }),
            ctx.child('modpack.files', (c) =>
              this.#api.installModpack(manifest, resolved, {
                instanceDir: dir,
                store: this.#d.resources.store,
                download: { client },
                ctx: c,
                ...(input.selectedOptional ? { selectedOptional: input.selectedOptional } : {}),
                ...(upstream ? { upstream } : {}),
              }),
            ),
          ])
          if (files.status === 'rejected') {
            const e = files.reason
            if (isAbortError(e) || ctx.signal.aborted) throw e
            throw new AppError(errorCode(e) ?? 'EINSTALL_INCOMPLETE', `The modpack files could not be installed: ${errorMessage(e)}. Import again to resume.`, { instanceId: id, ...(e as { details?: object }).details }, { cause: e })
          }
          const manual = files.value.unresolved
          this.#remember(id, { manifest, resolved, ...(upstream ? { upstream } : {}), ...(input.selectedOptional ? { selectedOptional: input.selectedOptional } : {}), manual })
          this.#d.telemetry.capture('modpack_imported', { source: sourceKind })
          const runtimeError = runtime.status === 'rejected' ? { code: errorCode(runtime.reason) ?? 'EINSTALL_FAILED', message: errorMessage(runtime.reason) } : null
          if (runtimeError) log.warn(`the game version of “${manifest.name}” could not be installed: ${runtimeError.message}`)
          log.info(`imported “${manifest.name}” ${manifest.version}: ${files.value.installed.length} installed, ${manual.length} manual`)
          return { instanceId: id, installed: files.value.installed.length + files.value.kept.length, skipped: resolved.skipped.length, manual: manual.map(manualRow), runtimeError }
        } finally {
          this.#busy.delete(id)
        }
      })
    } catch (e) {
      throw mapError(e)
    }
  }

  async installFromMarket(input: { platform: MarketPlatform; projectId: string; versionId: string; name?: string }): Promise<ModpackImportResult> {
    if (!input || (input.platform !== 'modrinth' && input.platform !== 'curseforge')) throw invalid('Unknown platform')
    const { modrinth, curseforge } = this.#clients()
    if (input.platform === 'modrinth') {
      const version = await modrinth.getVersion(String(input.versionId)).catch((e: unknown) => Promise.reject(mapError(e)))
      const file = version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ?? version.files.find((f) => f.filename.endsWith('.mrpack')) ?? version.files[0]
      if (!file) throw new AppError('ENOT_FOUND', 'This version has no modpack file')
      return this.import(
        { source: { url: file.url }, ...(input.name ? { name: input.name } : {}) },
        { upstream: { kind: 'modrinth', projectId: version.project_id, versionId: version.id }, expected: { ...(file.hashes.sha1 ? { sha1: file.hashes.sha1 } : {}), size: file.size } },
      )
    }
    if (!curseforge) throw new AppError('EUNAVAILABLE', 'CurseForge is not available in this build', { platform: 'curseforge' })
    const modId = Number(input.projectId)
    const fileId = Number(input.versionId)
    if (!Number.isInteger(modId) || !Number.isInteger(fileId)) throw invalid('CurseForge ids must be numbers')
    const file = await curseforge.getFile(modId, fileId).catch((e: unknown) => Promise.reject(mapError(e)))
    if (!file.downloadUrl) {
      throw new AppError('EMANUAL_DOWNLOAD_REQUIRED', 'The author of this modpack does not allow launchers to download it. Download it from CurseForge and import the file.', {
        websiteUrl: `https://www.curseforge.com/projects/${modId}`,
        fileName: file.fileName,
      })
    }
    const sha = file.hashes.find((h) => h.algo === 1)?.value
    return this.import(
      { source: { url: file.downloadUrl }, ...(input.name ? { name: input.name } : {}) },
      { upstream: { kind: 'curseforge', projectId: modId, fileId }, expected: { ...(sha ? { sha1: sha } : {}), size: file.fileLength } },
    )
  }

  #remember(instanceId: string, pack: PendingPack): void {
    this.#pending.delete(instanceId)
    if (pack.manual.length === 0) return
    this.#pending.set(instanceId, pack)
    while (this.#pending.size > MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value as string)
  }

  // -------------------------------------------------------------------------------------------
  // Manual downloads
  // -------------------------------------------------------------------------------------------

  async listManualFiles(instanceId: string): Promise<ModpackManualFile[]> {
    const pending = this.#pending.get(instanceId)
    if (pending) return pending.manual.map(manualRow)
    const dir = this.#d.instances.resolve(instanceId).dir
    try {
      const raw = JSON.parse(await readFile(path.join(dir, '.amethyst', 'unresolved.json'), 'utf8')) as { files?: ManualDownload[] }
      return (Array.isArray(raw.files) ? raw.files : []).filter((f) => f && typeof f.fileName === 'string').map(manualRow)
    } catch {
      return []
    }
  }

  /** Place matched manual files by re-running the (resumable, idempotent) install with them. */
  async #placeManual(instanceId: string, files: string[]): Promise<ManualDownload[]> {
    const pending = this.#pending.get(instanceId)
    if (!pending) return []
    const dir = this.#d.instances.resolve(instanceId).dir
    const client = await this.#d.http()
    const result = await this.#d.tasks.runAndWait({ name: 'modpack.manual', params: { files: files.length }, instanceId }, (ctx) =>
      this.#api.installModpack(pending.manifest, pending.resolved, {
        instanceDir: dir,
        store: this.#d.resources.store,
        download: { client },
        ctx,
        manualFiles: files,
        ...(pending.selectedOptional ? { selectedOptional: pending.selectedOptional } : {}),
        ...(pending.upstream ? { upstream: pending.upstream } : {}),
      }),
    )
    pending.manual = result.unresolved
    if (pending.manual.length === 0) this.#pending.delete(instanceId)
    return pending.manual
  }

  async watchManualDownloads(instanceId: string): Promise<ModpackManualFile[]> {
    const pending = this.#pending.get(instanceId)
    if (!pending || pending.manual.length === 0) return []
    if (this.#watchers.has(instanceId)) return pending.manual.map(manualRow)
    const signal = AbortSignal.timeout(this.#d.watchTimeoutMs ?? 30 * 60_000)
    const watcher = this.#api.watchForManualFiles(this.#d.downloadsDir ?? path.join(homedir(), 'Downloads'), pending.manual, { signal, includeExisting: true })
    this.#watchers.set(instanceId, watcher)
    void (async () => {
      try {
        for await (const match of watcher) {
          try {
            const left = await this.#placeManual(instanceId, [match.file])
            this.#d.emit('modpack:manual', { instanceId, matched: [match.expected.fileName], manual: left.map(manualRow), watching: left.length > 0 })
            if (left.length === 0) break
          } catch (e) {
            log.warn(`cannot place ${match.file}`, e)
          }
        }
      } catch (e) {
        log.warn('the Downloads watcher stopped', e)
      } finally {
        watcher.close()
        if (this.#watchers.get(instanceId) === watcher) this.#watchers.delete(instanceId)
        this.#d.emit('modpack:manual', { instanceId, matched: [], manual: (this.#pending.get(instanceId)?.manual ?? []).map(manualRow), watching: false })
      }
    })()
    await watcher.ready
    return pending.manual.map(manualRow)
  }

  async stopWatchingManualDownloads(instanceId: string): Promise<void> {
    this.#watchers.get(instanceId)?.close()
  }

  async provideManualFile(file: string, instanceId?: string): Promise<{ matched: boolean; instanceId: string | null; manual: ModpackManualFile[] }> {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid('An absolute file path is required')
    const candidates = instanceId ? [instanceId] : [...this.#pending.keys()]
    for (const id of candidates) {
      const pending = this.#pending.get(id)
      if (!pending) continue
      // oxlint-disable-next-line no-await-in-loop -- a handful of instances at most
      const { matched } = await this.#api.matchManualFiles([file], pending.manual)
      if (matched.length === 0) continue
      // oxlint-disable-next-line no-await-in-loop
      const left = await this.#placeManual(id, [file])
      this.#d.emit('modpack:manual', { instanceId: id, matched: matched.map((m) => m.expected.fileName), manual: left.map(manualRow), watching: this.#watchers.has(id) })
      return { matched: true, instanceId: id, manual: left.map(manualRow) }
    }
    const manual = instanceId ? await this.listManualFiles(instanceId) : []
    return { matched: false, instanceId: instanceId ?? null, manual }
  }

  // -------------------------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------------------------

  async checkUpdate(instanceId: string): Promise<ModpackUpdateInfo | null> {
    const upstream = this.#d.instances.resolve(instanceId).config.upstream
    if (!upstream) return null
    const { modrinth, curseforge } = this.#clients()
    try {
      if (upstream.kind === 'modrinth') {
        const versions = await modrinth.getProjectVersions(upstream.projectId)
        const current = versions.find((v) => v.id === upstream.versionId)
        const latest = versions[0]
        if (!latest || latest.id === upstream.versionId) return null
        if (current && Date.parse(latest.date_published) <= Date.parse(current.date_published)) return null
        return {
          instanceId,
          platform: 'modrinth',
          projectId: upstream.projectId,
          currentVersionId: upstream.versionId,
          latest: { versionId: latest.id, name: latest.name, versionNumber: latest.version_number, publishedAt: latest.date_published, gameVersions: latest.game_versions },
        }
      }
      if (!curseforge) return null
      const page = await curseforge.getModFiles(upstream.projectId, { pageSize: 50 })
      const files = page.data.filter((f) => f.isAvailable !== false).toSorted((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))
      const latest = files[0]
      const current = files.find((f) => f.id === upstream.fileId)
      if (!latest || latest.id === upstream.fileId) return null
      if (current && Date.parse(latest.fileDate) <= Date.parse(current.fileDate)) return null
      return {
        instanceId,
        platform: 'curseforge',
        projectId: String(upstream.projectId),
        currentVersionId: String(upstream.fileId),
        latest: { versionId: String(latest.id), name: latest.displayName, versionNumber: latest.displayName, publishedAt: latest.fileDate, gameVersions: latest.gameVersions },
      }
    } catch (e) {
      throw mapError(e)
    }
  }

  /** Download one version of the instance's pack: its archive, target upstream and display name. */
  async #targetPack(instanceId: string, versionId: string, ctx: TaskContext): Promise<{ archive: string; upstream: ModpackUpstream; name: string }> {
    const upstream = this.#d.instances.resolve(instanceId).config.upstream
    if (!upstream) throw new AppError('EINVALID_ARGUMENT', 'This instance does not follow a modpack')
    const { modrinth, curseforge } = this.#clients()
    if (upstream.kind === 'modrinth') {
      const version = await modrinth.getVersion(versionId)
      if (version.project_id !== upstream.projectId) throw new AppError('EDIFFERENT_UPSTREAM', 'This instance follows a different modpack')
      const file = version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ?? version.files.find((f) => f.filename.endsWith('.mrpack'))
      if (!file) throw new AppError('ENOT_FOUND', 'This version has no modpack file')
      const archive = await this.#archive({ url: file.url }, ctx, { ...(file.hashes.sha1 ? { sha1: file.hashes.sha1 } : {}), size: file.size })
      return { archive, upstream: { kind: 'modrinth', projectId: upstream.projectId, versionId: version.id }, name: version.name }
    }
    if (!curseforge) throw new AppError('EUNAVAILABLE', 'CurseForge is not available in this build', { platform: 'curseforge' })
    const fileId = Number(versionId)
    const file = await curseforge.getFile(upstream.projectId, fileId)
    if (file.modId !== upstream.projectId) throw new AppError('EDIFFERENT_UPSTREAM', 'This instance follows a different modpack')
    if (!file.downloadUrl) throw new AppError('EMANUAL_DOWNLOAD_REQUIRED', 'The author of this modpack does not allow launchers to download it', { fileName: file.fileName })
    const sha = file.hashes.find((h) => h.algo === 1)?.value
    const archive = await this.#archive({ url: file.downloadUrl }, ctx, { ...(sha ? { sha1: sha } : {}), size: file.fileLength })
    return { archive, upstream: { kind: 'curseforge', projectId: upstream.projectId, fileId }, name: file.displayName }
  }

  async planUpdate(instanceId: string, versionId: string): Promise<ModpackUpdatePlanView> {
    if (typeof versionId !== 'string' || versionId === '') throw invalid('A version id is required')
    const inst = this.#d.instances.resolve(instanceId)
    try {
      return await this.#d.tasks.runAndWait({ name: 'modpack.plan-update', params: { name: inst.config.name }, instanceId }, async (ctx) => {
        const target = await this.#targetPack(instanceId, versionId, ctx)
        const manifest = await this.#read(target.archive)
        const { modrinth, curseforge } = this.#clients()
        const resolved = await ctx.child('modpack.resolve', (c) => this.#api.resolveModpackFiles(manifest, { modrinth, ...(curseforge ? { curseforge } : {}), ctx: c }))
        const lock = await this.#api.readModpackLock(inst.dir)
        const plan = await this.#api.planModpackUpdate(lock, manifest, resolved, inst.dir, { signal: ctx.signal })
        const planId = randomUUID()
        this.#prunePlans()
        const upstream = { ...target.upstream, packSha1: manifest.sha1 } as ModpackUpstream
        this.#plans.set(planId, { plan, instanceId, upstream, target: { versionId, name: target.name }, createdAt: Date.now() })
        const row = (action: 'add' | 'update' | 'remove' | 'conflict') => (c: (typeof plan.add)[number]) => ({ path: c.path, action, conflict: c.conflict ?? null })
        const from = plan.runtime.from
        const to = plan.runtime.to
        const runtimeChanged = !from || from.minecraft !== to.minecraft || JSON.stringify(from.loader) !== JSON.stringify(to.loader)
        return {
          planId,
          instanceId,
          target: { versionId, name: target.name },
          changes: [...plan.add.map(row('add')), ...plan.update.map(row('update')), ...plan.remove.map(row('remove')), ...plan.conflicts.map(row('conflict'))],
          unchanged: plan.keep.length,
          manual: plan.manualDownloads.map(manualRow),
          runtime: runtimeChanged ? { from: from ? { minecraft: from.minecraft, loader: loaderRow(from.loader) } : null, to: { minecraft: to.minecraft, loader: loaderRow(to.loader) } } : null,
        }
      })
    } catch (e) {
      throw mapError(e)
    }
  }

  #prunePlans(): void {
    const now = Date.now()
    for (const [id, p] of this.#plans) if (now - p.createdAt > PLAN_TTL_MS) this.#plans.delete(id)
    while (this.#plans.size >= 8) this.#plans.delete(this.#plans.keys().next().value as string)
  }

  async applyUpdate(planId: string, options: { exclude?: string[] } = {}): Promise<ModpackUpdateResult> {
    this.#prunePlans()
    const stored = this.#plans.get(planId)
    if (!stored) throw new AppError('ENOT_FOUND', 'The update plan expired; check for updates again')
    const { plan, instanceId, upstream } = stored
    const inst = this.#d.instances.resolve(instanceId)
    if (this.#busy.has(instanceId)) throw new AppError('EBUSY', 'An import or update of this instance is running')
    this.#busy.add(instanceId)
    try {
      const result = await this.#d.tasks.runAndWait({ name: 'modpack.update', params: { name: inst.config.name, version: stored.target.name }, instanceId }, async (ctx) => {
        await ctx.child('modpack.backup-worlds', (c) => this.#d.resources.autoBackupWorlds(instanceId, 'pre-modpack-update', c))
        const client = await this.#d.http()
        const applied = await ctx.child('modpack.apply', (c) =>
          this.#api.applyModpackUpdate(plan, { store: this.#d.resources.store, download: { client }, ctx: c, upstream, ...(options?.exclude ? { exclude: options.exclude } : {}) }),
        )
        // The new runtime and upstream; the version id is cleared so the next install links the right one.
        const runtime: Record<string, string> = { minecraft: plan.runtime.to.minecraft, forge: '', neoforge: '', fabric: '', quilt: '' }
        if (plan.runtime.to.loader) runtime[plan.runtime.to.loader.id] = plan.runtime.to.loader.version
        await this.#d.instances.update(instanceId, { runtime, upstream: upstream as InstanceUpstream, versionId: null })
        const installed = await this.#d.install.install(instanceId, { ctx }).then(
          () => null,
          (e: unknown) => ({ code: errorCode(e) ?? 'EINSTALL_FAILED', message: errorMessage(e) }),
        )
        return { applied, runtimeError: installed }
      })
      this.#plans.delete(planId)
      const { applied, runtimeError } = result
      this.#remember(instanceId, { manifest: plan.manifest, resolved: plan.resolved, upstream, manual: applied.unresolved })
      return { backupId: applied.backupId, added: applied.added.length, updated: applied.updated.length, removed: applied.removed.length, manual: applied.unresolved.map(manualRow), runtimeError }
    } catch (e) {
      throw mapError(e)
    } finally {
      this.#busy.delete(instanceId)
    }
  }

  async rollback(instanceId: string, backupId: string): Promise<void> {
    if (typeof backupId !== 'string' || !/^[\w.-]+$/.test(backupId)) throw invalid('Invalid backup id')
    const inst = this.#d.instances.resolve(instanceId)
    if (this.#busy.has(instanceId)) throw new AppError('EBUSY', 'An import or update of this instance is running')
    this.#busy.add(instanceId)
    try {
      await this.#d.tasks.runAndWait({ name: 'modpack.rollback', params: { name: inst.config.name }, instanceId }, async (ctx) => {
        await this.#api.rollbackModpackUpdate(inst.dir, backupId, { signal: ctx.signal })
        // Follow the restored lock: its pack version and runtime are what the files now are.
        const lock = await this.#api.readModpackLock(inst.dir)
        if (lock) {
          const runtime: Record<string, string> = { minecraft: lock.pack.minecraft, forge: '', neoforge: '', fabric: '', quilt: '' }
          if (lock.pack.loader) runtime[lock.pack.loader.id] = lock.pack.loader.version
          await this.#d.instances.update(instanceId, { runtime, ...(lock.upstream ? { upstream: lock.upstream as InstanceUpstream } : {}), versionId: null })
        }
      })
    } catch (e) {
      throw mapError(e)
    } finally {
      this.#busy.delete(instanceId)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------------------------

  async export(instanceId: string, input: ModpackExportInput): Promise<ModpackExportResult> {
    if (!input || (input.format !== 'mrpack' && input.format !== 'curseforge')) throw invalid('format must be mrpack or curseforge')
    if (typeof input.output !== 'string' || !path.isAbsolute(input.output)) throw invalid('An absolute output path is required')
    const inst = this.#d.instances.resolve(instanceId)
    const runtime = inst.config.runtime
    const loader = (['forge', 'neoforge', 'fabric', 'quilt'] as const).find((k) => runtime[k])
    const include =
      input.include ??
      (
        await Promise.all(
          DEFAULT_EXPORT_INCLUDE.map(async (rel) => ((await stat(path.join(inst.dir, rel)).catch(() => undefined)) ? rel : undefined)),
        )
      ).filter((r): r is string => r !== undefined)
    const { modrinth, curseforge } = this.#clients()
    try {
      const result = await this.#d.tasks.runAndWait({ name: 'modpack.export', params: { name: inst.config.name, format: input.format }, instanceId }, (ctx) => {
        const common = {
          output: input.output,
          name: input.name?.trim() || inst.config.name,
          version: input.version?.trim() || '1.0.0',
          ...(inst.config.author ? { author: inst.config.author } : {}),
          ...(inst.config.description ? { summary: inst.config.description.slice(0, 500) } : {}),
          minecraft: runtime.minecraft,
          loader: loader ? { id: loader, version: runtime[loader] } : null,
          include,
          ...(input.exclude ? { exclude: input.exclude } : {}),
          ctx,
        }
        return input.format === 'mrpack' ? this.#api.exportModrinth(inst.dir, { ...common, modrinth }) : this.#api.exportCurseForge(inst.dir, { ...common, ...(curseforge ? { curseforge } : {}) })
      })
      return { path: result.path, linked: result.linked.length, embedded: result.embedded.length, warnings: result.warnings }
    } catch (e) {
      throw mapError(e)
    }
  }

  dispose(): void {
    for (const w of this.#watchers.values()) w.close()
    this.#watchers.clear()
  }
}

/** The RPC facade. */
export function modpackService(manager: ModpackManager): ModpackService {
  return {
    preview: (source) => manager.preview(source),
    import: (input) => manager.import(input),
    installFromMarket: (input) => manager.installFromMarket(input),
    watchManualDownloads: (id) => manager.watchManualDownloads(id),
    stopWatchingManualDownloads: (id) => manager.stopWatchingManualDownloads(id),
    provideManualFile: (file, id) => manager.provideManualFile(file, id),
    listManualFiles: (id) => manager.listManualFiles(id),
    checkUpdate: (id) => manager.checkUpdate(id),
    planUpdate: (id, versionId) => manager.planUpdate(id, versionId),
    applyUpdate: (planId, options) => manager.applyUpdate(planId, options),
    rollback: (id, backupId) => manager.rollback(id, backupId),
    export: (id, input) => manager.export(id, input),
  }
}
