/**
 * The runtime utility process. Owns every domain service (instances, resources, marketplace,
 * accounts, tasks, settings; installs and launch later) so the Electron main thread only ever
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
import type { AccountsService, IndexStatus, InstancesService, MarketplaceService, ReportedError, ResourcesService, SettingsService, TasksService } from '@shared/services'
import type { AccountManager } from './accounts/service'
import type { RuntimeConfig } from './context'
import { DbClient } from './db/client'
import { InstanceManager, instancesService } from './instances/service'
import { dataLayout } from './layout'
import { deferred, once } from './lazy'
import { logger, setLogFile, timed } from './log'
import type { MarketplaceManager } from './marketplace/service'
import type { ResourceManager } from './resources/service'
import type { ResourceWorkerHandlers } from './resources/worker-handlers'
import { attachPort, emit, handleHostResponse, host, registerService } from './rpc'
import { settingsService, SettingsStore } from './settings/service'
import { applyConsent, reportError, shutdownTelemetry, telemetryService, useConsentSource } from './telemetry'
import { TaskRegistry, tasksService } from './tasks/registry'
import { errorMessage } from './util/errors'

const startedAt = Date.now()
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
// Forget index rows of deleted (or moved) instance folders; they would never match again.
instances.addHooks({
  removed: async (_id, dir) => {
    if (index.ok) await db.query('placements.deleteUnder', { prefix: pathKey(path.resolve(dir)) }).catch(() => undefined)
  },
})

let index: IndexStatus = { ok: false, error: 'not opened yet' }
let bootMs = 0

const booted = (async () => {
  await setLogFile(path.join(layout.logs, 'runtime.log')).catch(() => {})
  await timed(log, 'boot', () =>
    Promise.all([
      timed(log, 'settings loaded', () => settings.load()),
      timed(log, 'instance index loaded', async () => log.info(`${await instances.load()} instances`)),
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
  bootMs = Date.now() - startedAt
})()
booted.catch((e: unknown) => log.error('boot failed', e))

// ---------------------------------------------------------------------------------------------
// Lazy services
// ---------------------------------------------------------------------------------------------

// Heavy modules (zip parsing, the marketplace and auth clients, undici) are only parsed on first use.
const pool = once(async () => {
  const { WorkerPool } = await import('./resources/pool')
  const size = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))
  return new WorkerPool<ResourceWorkerHandlers>(() => new Worker(new URL('./scan-worker.js', import.meta.url)), { size })
})

let resourceManager: ResourceManager | undefined
const resources = once(async () => {
  await booted
  const { ResourceManager } = await import('./resources/service')
  resourceManager = new ResourceManager({ layout, emit, host, instances, db: index.ok ? db : undefined, pool: await pool(), tasks, settings })
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
    return { pid: process.pid, uptimeMs: Date.now() - startedAt, memoryRss: process.memoryUsage.rss(), bootMs, index }
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
const instancesImpl = instancesService(instances)
registerService(
  'instances',
  deferred<InstancesService>(
    { list: true, get: true, create: true, update: true, rename: true, duplicate: true, delete: true, inspectFolder: true, import: true, repair: true, setIcon: true, markOpened: true },
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

// ---------------------------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------------------------

process.parentPort.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const data = event.data as { t?: string; error?: ReportedError }
  if (data?.t === 'connect') {
    for (const port of event.ports) attachPort(port)
    emit('runtime:ready', { at: Date.now() })
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
  tasks.dispose()
  const settled = await Promise.allSettled([
    settings.flush(),
    instances.flush(),
    market?.flush(),
    accountManager?.flush(),
  ])
  resourceManager?.dispose()
  for (const s of settled) if (s.status === 'rejected') log.warn('shutdown step failed', s.reason)
  await db.close().catch(() => {})
  // Give consented telemetry a bounded chance to go out.
  await shutdownTelemetry(1_000)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
