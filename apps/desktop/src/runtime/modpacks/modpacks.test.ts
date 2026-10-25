import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { curseforgeFingerprintSync } from '@amethyst/marketplace'
import type { InstallResult, ManualDownload, ModpackManifest, ResolvedModpack } from '@amethyst/modpack'
import type { Events } from '@shared/events'
import { dataLayout, type DataLayout } from '../layout'
import { InstanceManager } from '../instances/service'
import { defaultSettings } from '../settings/schema'
import { TaskRegistry } from '../tasks/registry'
import { ModpackManager, sourceRows, type ModpackApi } from './service'

let root: string
let layout: DataLayout
let downloads: string
let events: { event: keyof Events; payload: unknown }[]
const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  events.push({ event, payload })
}

const BLOCKED = Buffer.from('a blocked mod jar')
const blocked: ManualDownload = {
  name: 'Blocked Mod',
  fileName: 'blocked-1.0.jar',
  websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked/download/42',
  sha1: createHash('sha1').update(BLOCKED).digest('hex'),
  size: BLOCKED.length,
  path: 'mods/blocked-1.0.jar',
  projectId: 7,
  fileId: 42,
}

const manifest = (archive: string): ModpackManifest => ({
  format: 'curseforge',
  archive,
  sha1: 'f'.repeat(40),
  prefix: '',
  name: 'Test Pack',
  version: '1.0.0',
  author: 'someone',
  minecraft: '1.20.1',
  loader: { id: 'forge', version: '47.3.0' },
  files: [
    { kind: 'curseforge', projectId: 1, fileId: 10, required: true },
    { kind: 'curseforge', projectId: 7, fileId: 42, required: true },
  ],
  overridesDirs: ['overrides/'],
  overrides: [],
  warnings: [],
})

const resolved: ResolvedModpack = {
  format: 'curseforge',
  packSha1: 'f'.repeat(40),
  files: [],
  optional: [],
  manualDownloads: [blocked],
  datapacks: [],
  skipped: [],
  externalHosts: [],
}

function installResult(unresolved: ManualDownload[]): InstallResult {
  return { installed: ['mods/free-1.0.jar'], kept: [], backedUp: [], backupId: 'b1', unresolved, rejectedManualFiles: [], deselected: [], lock: {} as never }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-modpacks-'))
  layout = dataLayout(path.join(root, 'data'))
  downloads = path.join(root, 'Downloads')
  await mkdir(downloads, { recursive: true })
  events = []
})
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20))
  await rm(root, { recursive: true, force: true })
})

async function setup(market: { modrinth?: unknown; curseforge?: unknown } = {}) {
  const tasks = new TaskRegistry(() => {}, { intervalMs: 0 })
  const instances = new InstanceManager({ layout, emit, host: { trash: async () => {} }, tasks })
  await instances.load()
  const installModpack = vi.fn<(m: ModpackManifest, r: ResolvedModpack, o: { manualFiles?: readonly string[] }) => Promise<InstallResult>>(async (_m, _r, o) => installResult(o.manualFiles?.length ? [] : [blocked]))
  const api: Partial<ModpackApi> = {
    readModpack: vi.fn<(file: string) => Promise<ModpackManifest>>(async (file) => manifest(file)),
    resolveModpackFiles: vi.fn<() => Promise<ResolvedModpack>>(async () => resolved),
    installModpack: installModpack as never,
  }
  const install = { install: vi.fn<(id: string, o?: object) => Promise<{ versionId: string; durationMs: number; bytes: number }>>(async () => ({ versionId: '1.20.1-forge-47.3.0', durationMs: 1, bytes: 0 })) }
  const captured: unknown[] = []
  const manager = new ModpackManager({
    layout,
    emit,
    tasks,
    settings: { value: defaultSettings() },
    instances,
    install,
    resources: { store: undefined as never, autoBackupWorlds: async () => 0 },
    market: { clients: () => ({ modrinth: (market.modrinth ?? {}) as never, curseforge: (market.curseforge ?? {}) as never }) },
    http: async () => ({}) as never,
    telemetry: { capture: ((...args: unknown[]) => void captured.push(args)) as never },
    api,
    downloadsDir: downloads,
  })
  return { manager, instances, tasks, installModpack, install, captured }
}

describe('ModpackManager import', () => {
  it('imports as one task and returns the blocked CurseForge files', async () => {
    const { manager, instances, tasks, install, captured } = await setup()
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')

    const result = await manager.import({ source: { path: archive } })
    expect(result.manual).toEqual([
      { name: 'Blocked Mod', fileName: 'blocked-1.0.jar', websiteUrl: blocked.websiteUrl, path: 'mods/blocked-1.0.jar', size: BLOCKED.length, projectId: 7, fileId: 42 },
    ])
    expect(result.installed).toBe(1)
    expect(result.runtimeError).toBeNull()
    const detail = instances.get(result.instanceId)
    expect(detail).toMatchObject({ name: 'Test Pack', author: 'someone', runtime: { minecraft: '1.20.1', forge: '47.3.0' } })
    expect(install.install).toHaveBeenCalledWith(result.instanceId, expect.objectContaining({ ctx: expect.anything() }))
    const view = tasks.list().find((t) => t.name === 'modpack.import')
    expect(view?.state).toBe('succeeded')
    expect(captured).toEqual([['modpack_imported', { source: 'file' }]])
    expect(await manager.listManualFiles(result.instanceId)).toHaveLength(1)
  })

  it('accepts a dropped manual file by hash and places it', async () => {
    const { manager, installModpack } = await setup()
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    const { instanceId } = await manager.import({ source: { path: archive } })

    const wrong = path.join(root, 'wrong.jar')
    await writeFile(wrong, 'not it')
    expect(await manager.provideManualFile(wrong)).toMatchObject({ matched: false })

    const right = path.join(root, 'renamed-by-browser.jar')
    await writeFile(right, BLOCKED)
    const r = await manager.provideManualFile(right)
    expect(r).toEqual({ matched: true, instanceId, manual: [] })
    expect(installModpack).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ manualFiles: [right], only: ['mods/blocked-1.0.jar'] }))
    expect(events.find((e) => e.event === 'modpack:manual')?.payload).toMatchObject({ instanceId, matched: ['blocked-1.0.jar'], manual: [] })
    expect(await manager.listManualFiles(instanceId)).toEqual([])
  })

  it('watches ~/Downloads for the missing files', async () => {
    const { manager, installModpack } = await setup()
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    const { instanceId } = await manager.import({ source: { path: archive } })

    const pending = await manager.watchManualDownloads(instanceId)
    expect(pending).toHaveLength(1)
    await writeFile(path.join(downloads, 'blocked-1.0.jar'), BLOCKED)
    await vi.waitFor(
      () => expect(events.some((e) => e.event === 'modpack:manual' && (e.payload as Events['modpack:manual']).matched.includes('blocked-1.0.jar'))).toBe(true),
      { timeout: 5_000 },
    )
    await vi.waitFor(() => expect(events.some((e) => e.event === 'modpack:manual' && !(e.payload as Events['modpack:manual']).watching)).toBe(true))
    expect(installModpack).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ manualFiles: [path.join(downloads, 'blocked-1.0.jar')] }))
    manager.dispose()
  })

  it('keeps the instance when the file install fails, and resumes into it', async () => {
    const { manager, instances, installModpack } = await setup()
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    installModpack.mockRejectedValueOnce(Object.assign(new Error('2 files failed'), { code: 'EINSTALL_INCOMPLETE' }))
    const error = (await manager.import({ source: { path: archive } }).catch((e: unknown) => e)) as { code: string; details: { instanceId: string } }
    expect(error.code).toBe('EINSTALL_INCOMPLETE')
    const id = error.details.instanceId
    expect(instances.get(id).name).toBe('Test Pack')
    const resumed = await manager.import({ source: { path: archive }, instanceId: id })
    expect(resumed.instanceId).toBe(id)
    expect(instances.list()).toHaveLength(1)
  })

  it('resumes an interrupted import of the same pack instead of creating a second instance (#1540)', async () => {
    const { manager, instances, installModpack } = await setup()
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    installModpack.mockRejectedValueOnce(Object.assign(new Error('2 files failed'), { code: 'EINSTALL_INCOMPLETE' }))
    const error = (await manager.import({ source: { path: archive } }).catch((e: unknown) => e)) as { details: { instanceId: string } }
    const id = error.details.instanceId
    // What installModpack leaves behind when staging fails: the operation record.
    const staging = path.join(instances.resolve(id).dir, '.amethyst', 'staging')
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, 'install-ffffffffffffffff.json'), JSON.stringify({ schemaVersion: 1, id: 'install-ffffffffffffffff', kind: 'install', packSha1: 'f'.repeat(40), createdAt: 1, state: 'staging' }))

    // "Import again to resume", without passing the instance id.
    const again = await manager.import({ source: { path: archive } })
    expect(again.instanceId).toBe(id)
    expect(instances.list()).toHaveLength(1)
  })

  it('identifies a local pack file by its fingerprint and records its provenance; memory stays inherited (#1540, #1095)', async () => {
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    const fp = curseforgeFingerprintSync(Buffer.from('zip'))
    const curseforge = { matchFingerprints: async (fps: number[]) => ({ exactMatches: fps.includes(fp) ? [{ id: 555, file: { id: 777, modId: 555, fileFingerprint: fp } }] : [] }) }
    const { manager, instances, installModpack } = await setup({ curseforge })
    const result = await manager.import({ source: { path: archive } })
    const upstream = { kind: 'curseforge', projectId: 555, fileId: 777, packSha1: 'f'.repeat(40) }
    expect(instances.get(result.instanceId).upstream).toMatchObject(upstream)
    expect(installModpack).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ upstream }))
    // The pack's own preferences never override the global memory setting.
    expect(instances.resolve(result.instanceId).config.overrides.memory).toBeUndefined()
  })

  it('imports without provenance when the platforms do not know the file', async () => {
    const { manager, instances } = await setup({ curseforge: { matchFingerprints: async () => Promise.reject(new Error('offline')) } })
    const archive = path.join(root, 'pack.zip')
    await writeFile(archive, 'zip')
    const result = await manager.import({ source: { path: archive } })
    expect(instances.get(result.instanceId).upstream).toBeFalsy()
  })
})

describe('ModpackManager preview', () => {
  it('reads a pack again when the file at the same path was replaced', async () => {
    const read = vi.fn<(file: string) => Promise<ModpackManifest>>(async (file) => manifest(file))
    const fresh = new ModpackManager({
      layout,
      emit,
      tasks: new TaskRegistry(() => {}, { intervalMs: 0 }),
      settings: { value: defaultSettings() },
      instances: { list: () => [] } as never,
      install: {} as never,
      resources: {} as never,
      market: { clients: () => ({ modrinth: {} as never, curseforge: undefined }) },
      http: async () => ({}) as never,
      telemetry: { capture: () => {} },
      api: { readModpack: read as never },
    })
    const archive = path.join(root, 'pack.mrpack')
    await writeFile(archive, 'v1')
    await fresh.preview({ path: archive })
    await fresh.preview({ path: archive })
    expect(read).toHaveBeenCalledTimes(1)
    await writeFile(archive, 'version 2, longer')
    await fresh.preview({ path: archive })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('ModpackManager export files', () => {
  it('lists the top-level entries with sizes and the default selection', async () => {
    const { manager, instances } = await setup()
    const inst = await instances.create({ name: 'Exportable', runtime: { minecraft: '1.21.1', fabric: '0.16.5' } })
    await mkdir(path.join(inst.path, 'mods'), { recursive: true })
    await writeFile(path.join(inst.path, 'mods', 'a.jar'), 'aaaa')
    await mkdir(path.join(inst.path, 'config', 'deep'), { recursive: true })
    await writeFile(path.join(inst.path, 'config', 'deep', 'x.toml'), 'xx')
    await writeFile(path.join(inst.path, 'options.txt'), 'fov:0\n')
    await mkdir(path.join(inst.path, 'logs'), { recursive: true })
    await writeFile(path.join(inst.path, 'logs', 'latest.log'), 'log')
    const rows = await manager.listExportFiles(inst.id)
    expect(rows.map((r) => [r.path, r.size, r.files, r.defaultSelected])).toEqual([
      ['config/', 2, 1, true],
      ['logs/', 3, 1, false],
      ['mods/', 4, 1, true],
      ['options.txt', 6, 1, true],
      ['resourcepacks/', 0, 0, true],
      ['shaderpacks/', 0, 0, true],
    ])
    manager.dispose()
  })
})

describe('sourceRows', () => {
  it('records Modrinth and CurseForge files by hash, and nothing else', () => {
    const rows = sourceRows(
      [
        { hashes: { sha1: 'AA' }, origin: { kind: 'modrinth', projectId: 'P', versionId: 'V' } },
        { hashes: { sha1: 'bb' }, origin: { kind: 'curseforge', projectId: 7, fileId: 42 } },
        { hashes: { sha1: 'cc' }, origin: { kind: 'url' } },
        { hashes: {}, origin: { kind: 'modrinth', projectId: 'P', versionId: 'V' } },
      ],
      5,
    )
    expect(rows).toEqual([
      { sha1: 'aa', platform: 'modrinth', projectId: 'P', versionId: 'V', confidence: 'manifest', resolvedAt: 5 },
      { sha1: 'bb', platform: 'curseforge', projectId: '7', versionId: '42', confidence: 'manifest', resolvedAt: 5 },
    ])
  })
})
