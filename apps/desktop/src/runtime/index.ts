/**
 * The runtime utility process. Owns every domain service (instances, resources, marketplace,
 * accounts, tasks, settings, versions, Java, installs, launch, modpacks) so the Electron main thread only ever
 * handles windows and OS integration. Renderers reach it over direct MessagePorts handed out by
 * the main process.
 *
 * Boot does exactly three things, in parallel: read the settings, load the instance index and
 * open the SQLite index (in its worker). Everything else (the scan worker pool, accounts, the
 * marketplace clients, the HTTP agent) is created on first use. Services are registered before
 * boot finishes; early calls simply wait for it.
 */
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { MessagePortMain } from 'electron'
import { pathKey } from '@amethyst/content'
import type { HttpClient } from '@amethyst/net'
import type { Events } from '@shared/events'
import { RUNTIME_ENV } from '@shared/paths'
import type {
  AccountsService,
  IndexStatus,
  InstallService,
  InstancesService,
  JavaService,
  LaunchService,
  MarketplaceService,
  ModpackService,
  ReportedError,
  ResourcesService,
  SettingsService,
  TasksService,
  VersionsService,
} from '@shared/services'
import type { MetadataClient } from '@amethyst/installer'
import type { AccountManager } from './accounts/service'
import type { InstallManager } from './install/service'
import type { JavaManager } from './java/service'
import type { LaunchManager } from './launch/service'
import type { Lwjgl2NativesSource } from './launch/natives-source'
import type { ModpackManager } from './modpacks/service'
import type { VersionsManager } from './versions/service'
import type { RuntimeConfig } from './context'
import { DbClient } from './db/client'
import { InstanceManager, instancesService } from './instances/service'
import { LibraryStore, libraryService } from './instances/library'
import { dataLayout } from './layout'
import { deferred, once } from './lazy'
import { logger, setLogFile, timed } from './log'
import type { MarketplaceManager } from './marketplace/service'
import type { ResourceManager } from './resources/service'
import type { ResourceWorkerHandlers } from './resources/worker-handlers'
import { attachPort, emit, handleHostResponse, host, registerService } from './rpc'
import { settingsService, SettingsStore } from './settings/service'
import { applyConsent, capture, redactFromReports, reportError, shutdownTelemetry, telemetryService, useConsentSource, type TelemetryHooks } from './telemetry'
import { TaskRegistry, tasksService } from './tasks/registry'
import { errorMessage } from './util/errors'

const startedAt = Date.now()
// Dev flag: profile the runtime from here to shutdown (see cpu-profile.ts).
if (process.env.AMETHYST_RUNTIME_CPU_PROF) void import('./cpu-profile').then((p) => p.startCpuProfile())
const log = logger('runtime')

const userData = process.env[RUNTIME_ENV.userData]
if (!userData) throw new Error(`${RUNTIME_ENV.userData} is not set`)
const layout = dataLayout(userData, process.env[RUNTIME_ENV.logs])
const config: RuntimeConfig = {
  version: process.env[RUNTIME_ENV.version] ?? '0.0.0',
  ...(import.meta.env.AMETHYST_MSA_CLIENT_ID ? { msaClientId: import.meta.env.AMETHYST_MSA_CLIENT_ID } : {}),
  ...(import.meta.env.AMETHYST_CURSEFORGE_API_KEY ? { curseforgeApiKey: import.meta.env.AMETHYST_CURSEFORGE_API_KEY } : {}),
}

// ---------------------------------------------------------------------------------------------
// Core objects (cheap to construct; nothing touches the disk until boot)
// ---------------------------------------------------------------------------------------------

const tasks = new TaskRegistry((payload) => emit('tasks:update', payload))
const settings = new SettingsStore(layout, (event, payload) => {
  emit(event, payload)
  // The settings are the single source of truth for telemetry consent.
  if (event === 'settings:changed' && (payload as Events['settings:changed']).keys.some((k) => k.startsWith('privacy.'))) {
    void applyConsent(privacyConsent())
  }
})
const privacyConsent = () => ({ usage: settings.value.privacy.usageData, crashes: settings.value.privacy.crashReports })
const db = new DbClient(() => new Worker(new URL('./db-worker.js', import.meta.url), { workerData: { file: layout.database } }), {
  onCrash: (e) => log.error('the index worker crashed; restarting it', e),
})

/** The shared HTTP client (and its module), loaded on first use with the configured connection limit. */
const httpClient = once(async (): Promise<HttpClient> => {
  const { createHttpClient, setDefaultHttpClient } = await import('@amethyst/net')
  const client = createHttpClient({ version: config.version, connectionsPerHost: settings.value.network.maxConnectionsPerHost })
  setDefaultHttpClient(client)
  return client
})
const fetchBytes = async (url: string, options: { maxBytes: number; signal?: AbortSignal }) => (await httpClient()).bytes(url, options)

const instances = new InstanceManager({ layout, emit, host, tasks, fetchBytes })
const library = new LibraryStore(layout.library, { emit, exists: (id) => instances.has(id) })
// Forget index rows of deleted (or moved) instance folders; they would never match again.
instances.addHooks({
  removed: async (_id, dir) => {
    if (index.ok) await db.query('placements.deleteUnder', { prefix: pathKey(path.resolve(dir)) }).catch(() => undefined)
  },
})
// Instances cannot be renamed or deleted while a game runs from them or an install writes into them.
let installManager: InstallManager | undefined
let launchManager: LaunchManager | undefined
let javaManager: JavaManager | undefined
let modpackManager: ModpackManager | undefined
instances.addHooks({
  isBusy: (id) => (installManager?.isBusy(id) ?? false) || (launchManager?.isActive(id) ?? false) || (modpackManager?.isBusy(id) ?? false),
})
const telemetryHooks: TelemetryHooks = { capture, redact: redactFromReports, reportError }

let index: IndexStatus = { ok: false, error: 'not opened yet' }
let bootMs = 0
let bootedAt = 0

const booted = (async () => {
  await setLogFile(path.join(layout.logs, 'runtime.log')).catch(() => {})
  await timed(log, 'boot', () =>
    Promise.all([
      timed(log, 'settings loaded', () => settings.load()),
      timed(log, 'instance index loaded', async () => log.info(`${await instances.load()} instances`)),
      library.load().catch((e: unknown) => log.warn('cannot read the sidebar layout', e)),
      timed(log, 'database opened', async () => {
        try {
          const ready = await db.open()
          index = { ok: true, schemaVersion: ready.schemaVersion }
          if (ready.healed.length > 0) log.warn(`moved a corrupt index aside: ${ready.healed.join(', ')}`)
        } catch (e) {
          // The index is a cache: keep going without it.
          index = { ok: false, error: errorMessage(e) }
          log.error('cannot open the resource index', e)
        }
      }),
    ]),
  )
  bootedAt = Date.now()
  bootMs = bootedAt - startedAt
})()
booted.catch((e: unknown) => log.error('boot failed', e))

// ---------------------------------------------------------------------------------------------
// Lazy services
// ---------------------------------------------------------------------------------------------

// Heavy modules (zip parsing, the marketplace and auth clients, undici) are only parsed on first use.
const pool = once(async () => {
  const { WorkerPool } = await import('./resources/pool')
  const size = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))
  // Scans and hashes time out (default 10 min); world zips run as cancellable tasks of any length.
  // Workers grow while they hash and make icon thumbnails; stop them soon after the last job
  // (respawning one costs ~30 ms) so an idle launcher does not keep their heaps resident.
  return new WorkerPool<ResourceWorkerHandlers>(() => new Worker(new URL('./scan-worker.js', import.meta.url)), {
    size,
    idleMs: 30_000,
    timeouts: { importWorld: 0, exportWorld: 0 },
  })
})

let resourceManager: ResourceManager | undefined
const resources = once(async () => {
  await booted
  const { ResourceManager } = await import('./resources/service')
  resourceManager = new ResourceManager({
    layout,
    emit,
    host,
    instances,
    db: index.ok ? db : undefined,
    pool: await pool(),
    tasks,
    settings,
    isRunning: (id) => launchManager?.isActive(id) ?? false,
  })
  return resourceManager
})

let accountManager: AccountManager | undefined
const accounts = once(async () => {
  await booted
  const { AccountManager } = await import('./accounts/service')
  const manager = new AccountManager({ layout, emit, host, settings, fetchBytes, ...(config.msaClientId ? { msaClientId: config.msaClientId } : {}) })
  await timed(log, 'accounts loaded', () => manager.load())
  accountManager = manager
  return manager
})

let market: MarketplaceManager | undefined
const marketplace = once(async () => {
  await booted
  await httpClient()
  const { MarketplaceManager } = await import('./marketplace/service')
  market = new MarketplaceManager({
    version: config.version,
    ...(config.curseforgeApiKey ? { curseforgeApiKey: config.curseforgeApiKey } : {}),
    db: index.ok ? db : undefined,
    instances,
    resources: await resources(),
    pool: await pool(),
    tasks,
    host,
  })
  return market
})

/** Version-list metadata, cached under `cache/meta/`. Lists are revalidated by the versions service, never at boot. */
const metadata = once(async (): Promise<MetadataClient> => {
  const [{ createMetadataClient }, http] = await Promise.all([import('@amethyst/installer'), httpClient()])
  return createMetadataClient({ cacheDir: layout.metaCache, maxAgeMs: Number.POSITIVE_INFINITY, http })
})

const nativesSource = once(async (): Promise<Lwjgl2NativesSource> => {
  const [{ Lwjgl2NativesSource }, { DEFAULT_LWJGL2_ARM64_SOURCE }] = await Promise.all([import('./launch/natives-source'), import('@amethyst/game')])
  return new Lwjgl2NativesSource({
    cacheDir: layout.nativesCache,
    fallback: DEFAULT_LWJGL2_ARM64_SOURCE,
    fetchJson: async (url, o) => (await httpClient()).json(url, o.signal ? { signal: o.signal } : {}),
  })
})
const lazyNatives: Pick<Lwjgl2NativesSource, 'get'> = { get: async (signal) => (await nativesSource()).get(signal) }

const java = once(async () => {
  await booted
  const { JavaManager } = await import('./java/service')
  javaManager = new JavaManager({ layout, emit, settings, tasks, instances, http: httpClient })
  return javaManager
})

const versions = once(async (): Promise<VersionsManager> => {
  await booted
  const { VersionsManager } = await import('./versions/service')
  return new VersionsManager({
    layout,
    emit,
    instances,
    meta: metadata,
    versionInUse: (id) => (installManager?.isVersionBusy(id) ?? false) || (launchManager?.isVersionRunning(id) ?? false),
  })
})

const installs = once(async () => {
  const [{ InstallManager }, javaImpl] = await Promise.all([import('./install/service'), java()])
  installManager = new InstallManager({ layout, emit, tasks, settings, instances, java: javaImpl, meta: metadata, http: httpClient, natives: lazyNatives, telemetry: telemetryHooks })
  return installManager
})

const launcher = once(async () => {
  const [{ LaunchManager }, installImpl, javaImpl] = await Promise.all([import('./launch/service'), installs(), java()])
  const osVersion = process.env[RUNTIME_ENV.osVersion]
  launchManager = new LaunchManager({
    layout,
    emit,
    settings,
    tasks,
    version: config.version,
    ...(osVersion ? { osVersion } : {}),
    instances,
    install: installImpl,
    java: javaImpl,
    accounts,
    natives: lazyNatives,
    http: httpClient,
    host,
    telemetry: telemetryHooks,
  })
  return launchManager
})

const modpacks = once(async () => {
  const [{ ModpackManager }, installImpl, resourcesImpl, marketImpl] = await Promise.all([import('./modpacks/service'), installs(), resources(), marketplace()])
  modpackManager = new ModpackManager({
    layout,
    emit,
    tasks,
    settings,
    instances,
    install: installImpl,
    resources: resourcesImpl,
    market: marketImpl,
    http: httpClient,
    telemetry: telemetryHooks,
    ...(index.ok ? { db } : {}),
  })
  return modpackManager
})

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/** Give consented telemetry a bounded chance to go out, then exit. */
async function exitAfterFlush(code: number, timeoutMs: number): Promise<never> {
  await shutdownTelemetry(timeoutMs)
  process.exit(code)
}

// An uncaught exception leaves the runtime in an unknown state: report it (if the user allows
// crash reports), give the report a moment to go out, then exit so main restarts us.
let exiting = false
process.on('uncaughtException', (error) => {
  log.error('uncaught exception', error)
  reportError(error, { source: 'runtime', handled: false, fatal: true })
  if (exiting) return
  exiting = true
  void exitAfterFlush(1, 2_000)
})
// A stray rejection is reported but not fatal.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason)
  reportError(reason, { source: 'runtime', handled: false })
})

registerService('runtime', {
  async ping() {
    await booted.catch(() => {})
    return {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      memoryRss: process.memoryUsage.rss(),
      heapUsed: process.memoryUsage().heapUsed,
      bootMs,
      processStartedAt: Math.round(performance.timeOrigin),
      bootedAt,
      index,
    }
  },
})
useConsentSource({
  load: async () => {
    await booted
    return privacyConsent()
  },
  save: async (consent) => {
    await booted
    await settings.patch({ privacy: { usageData: consent.usage, crashReports: consent.crashes, prompted: true } })
  },
})
registerService('telemetry', telemetryService)

const ready = async <T>(value: T) => {
  await booted
  return value
}

const settingsImpl = settingsService(settings, layout)
registerService(
  'settings',
  deferred<SettingsService>({ get: true, patch: true, reset: true, setBackground: true, getPaths: true, getSystemInfo: true }, () => ready(settingsImpl)),
)
const instancesImpl: InstancesService = { ...instancesService(instances), ...libraryService(library) }
registerService(
  'instances',
  deferred<InstancesService>(
    {
      list: true,
      get: true,
      create: true,
      update: true,
      rename: true,
      duplicate: true,
      delete: true,
      inspectFolder: true,
      import: true,
      repair: true,
      setIcon: true,
      markOpened: true,
      getLayout: true,
      setPinned: true,
      createFolder: true,
      updateFolder: true,
      deleteFolder: true,
      moveToFolder: true,
    },
    () => ready(instancesImpl),
  ),
)
registerService(
  'resources',
  deferred<ResourcesService>(
    {
      list: true,
      get: true,
      watch: true,
      unwatch: true,
      refresh: true,
      cancelScans: true,
      setEnabled: true,
      delete: true,
      add: true,
      addFromInstance: true,
      createBackup: true,
      listBackups: true,
      restoreBackup: true,
      deleteBackup: true,
      pruneBackups: true,
      undoDelete: true,
      setPackOrder: true,
      analyze: true,
      exportWorld: true,
    },
    async () => {
      const [{ resourcesService }, manager] = await Promise.all([import('./resources/service'), resources()])
      return resourcesService(manager)
    },
  ),
)
registerService(
  'marketplace',
  deferred<MarketplaceService>(
    { getStatus: true, search: true, getProject: true, getVersions: true, getChangelog: true, install: true, checkUpdates: true },
    async () => {
      const [{ marketplaceService }, manager] = await Promise.all([import('./marketplace/service'), marketplace()])
      return marketplaceService(() => manager)
    },
  ),
)
registerService(
  'accounts',
  deferred<AccountsService>(
    { getStatus: true, list: true, get: true, loginMicrosoft: true, cancelLogin: true, addOffline: true, remove: true, select: true, refresh: true, setSkin: true, resetSkin: true, setCape: true },
    async () => {
      const [{ accountsService }, manager] = await Promise.all([import('./accounts/service'), accounts()])
      return accountsService(manager)
    },
  ),
)
const tasksImpl = tasksService(tasks)
registerService(
  'tasks',
  deferred<TasksService>({ list: true, cancel: true, dismiss: true, clearFinished: true }, () => tasksImpl),
)
registerService(
  'versions',
  deferred<VersionsService>({ listMinecraft: true, listLoaders: true, refresh: true, listInstalled: true, deleteInstalled: true }, async () => {
    const [{ versionsService }, manager] = await Promise.all([import('./versions/service'), versions()])
    return versionsService(manager)
  }),
)
registerService(
  'java',
  deferred<JavaService>({ list: true, rescan: true, addPath: true, removePath: true, installRuntime: true, recommend: true }, async () => {
    const [{ javaService }, manager] = await Promise.all([import('./java/service'), java()])
    // Recommend from the installed version JSON when the instance has one.
    const resolveForRecommend = async (instanceId: string) => {
      const versionId = instances.resolve(instanceId).config.versionId
      if (!versionId) return undefined
      const { resolveVersion } = await import('@amethyst/game')
      return resolveVersion(path.join(layout.minecraft, 'versions'), versionId)
    }
    return javaService(manager, resolveForRecommend)
  }),
)
registerService(
  'install',
  deferred<InstallService>({ plan: true, status: true, install: true, repair: true, changeVersion: true }, async () => {
    const [{ installService }, { changeVersion }, manager] = await Promise.all([import('./install/service'), import('./install/change-version'), installs()])
    const deps = {
      instances,
      install: manager,
      isRunning: (id: string) => launchManager?.isActive(id) ?? false,
      backupWorlds: async (id: string) => (await resources()).autoBackupWorlds(id, 'pre-version-change'),
    }
    return { ...installService(manager), changeVersion: (id, runtime) => changeVersion(deps, id, runtime) }
  }),
)
registerService(
  'launch',
  deferred<LaunchService>(
    { launch: true, kill: true, listRunning: true, getLog: true, subscribeLog: true, unsubscribeLog: true, openCrashReport: true },
    async () => {
      const [{ launchService }, manager] = await Promise.all([import('./launch/service'), launcher()])
      return launchService(manager)
    },
  ),
)
registerService(
  'modpacks',
  deferred<ModpackService>(
    {
      preview: true,
      import: true,
      installFromMarket: true,
      watchManualDownloads: true,
      stopWatchingManualDownloads: true,
      provideManualFile: true,
      listManualFiles: true,
      checkUpdate: true,
      planUpdate: true,
      applyUpdate: true,
      rollback: true,
      export: true,
      listExportFiles: true,
    },
    async () => {
      const [{ modpackService }, manager] = await Promise.all([import('./modpacks/service'), modpacks()])
      return modpackService(manager)
    },
  ),
)

// ---------------------------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------------------------

process.parentPort.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const data = event.data as { t?: string; error?: ReportedError }
  if (data?.t === 'connect') {
    for (const port of event.ports) attachPort(port)
    emit('runtime:ready', { at: Date.now() })
    // Java discovery runs once, a little after the first window painted (never at boot).
    void java()
      .then((j) => j.scheduleInitialScan(3_000))
      .catch((e: unknown) => log.warn('cannot schedule Java discovery', e))
    return
  }
  if (data?.t === 'error' && data.error) {
    reportError(data.error, { source: 'main', handled: false })
    return
  }
  if (data?.t === 'shutdown') {
    void shutdown()
    return
  }
  handleHostResponse(event.data as never)
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  // Abort running tasks first so the helper processes they spawned are stopped, not orphaned;
  // give their cleanup a brief, bounded moment (main kills the runtime after 1.5 s).
  await Promise.race([tasks.cancelAll(), new Promise((r) => setTimeout(r, 400))])
  tasks.dispose()
  launchManager?.dispose()
  javaManager?.dispose()
  modpackManager?.dispose()
  const settled = await Promise.allSettled([
    settings.flush(),
    instances.flush(),
    library.flush(),
    market?.flush(),
    accountManager?.flush(),
    javaManager?.flush(),
  ])
  resourceManager?.dispose()
  for (const s of settled) if (s.status === 'rejected') log.warn('shutdown step failed', s.reason)
  await db.close().catch(() => {})
  if (process.env.AMETHYST_RUNTIME_CPU_PROF) await import('./cpu-profile').then((p) => p.stopCpuProfile()).catch(() => {})
  // Give consented telemetry a bounded chance to go out.
  await shutdownTelemetry(1_000)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
