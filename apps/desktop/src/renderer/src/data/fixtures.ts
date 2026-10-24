/**
 * Placeholder data for screens whose services are not wired yet. Deterministic, so screenshots
 * and tests are stable. Delete this file once every hook in `data/` calls the real `api`.
 */
import type {
  Account,
  GameVersion,
  HomeUpdate,
  InstanceFolder,
  InstanceSummary,
  JavaRuntime,
  LogFile,
  LogLevel,
  LogLine,
  TaskSnapshot,
} from './types'

const DAY = 86_400_000
const HOUR = 3_600_000
/** Fixture timestamps are relative to app start, so "2 hours ago" always reads that way. */
export const NOW = Math.floor(Date.now() / 60_000) * 60_000

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export const fixtureInstances: InstanceSummary[] = [
  {
    id: 'survival',
    name: 'Survival 1.21',
    iconHue: 140,
    minecraft: '1.21.1',
    loader: { kind: 'fabric', version: '0.16.5' },
    pinned: true,
    state: { kind: 'running', pid: 48211, since: NOW - 42 * 60_000 },
    lastPlayedAt: NOW - 2 * HOUR,
    playTimeMs: 86 * HOUR,
    createdAt: NOW - 120 * DAY,
  },
  {
    id: 'fabulously',
    name: 'Fabulously Optimized',
    iconHue: 200,
    minecraft: '1.21.1',
    loader: { kind: 'fabric', version: '0.16.5' },
    pinned: true,
    state: { kind: 'idle' },
    lastPlayedAt: NOW - 1 * DAY,
    playTimeMs: 12 * HOUR,
    createdAt: NOW - 60 * DAY,
    upstream: { source: 'modrinth', projectId: '1KVo5zza', projectName: 'Fabulously Optimized', version: '6.2.1', latestVersion: '6.3.0' },
  },
  {
    id: 'create',
    name: 'Create: Above and Beyond',
    iconHue: 30,
    minecraft: '1.20.1',
    loader: { kind: 'forge', version: '47.3.0' },
    folderId: 'tech',
    pinned: false,
    state: { kind: 'installing', progress: 0.42, taskId: 't-install' },
    lastPlayedAt: NOW - 6 * DAY,
    playTimeMs: 31 * HOUR,
    createdAt: NOW - 30 * DAY,
    upstream: { source: 'curseforge', projectId: '542763', projectName: 'Create: Above and Beyond', version: '1.4.2' },
  },
  {
    id: 'atm',
    name: 'All the Mods 10',
    iconHue: 280,
    minecraft: '1.21.1',
    loader: { kind: 'neoforge', version: '21.1.77' },
    folderId: 'tech',
    pinned: false,
    state: { kind: 'problem', message: 'Needs Java 21' },
    lastPlayedAt: NOW - 14 * DAY,
    playTimeMs: 4 * HOUR,
    createdAt: NOW - 20 * DAY,
  },
  {
    id: 'vanilla',
    name: 'Vanilla',
    iconHue: 100,
    minecraft: '1.21.4',
    loader: { kind: 'vanilla' },
    pinned: false,
    state: { kind: 'idle' },
    lastPlayedAt: NOW - 3 * DAY,
    playTimeMs: 9 * HOUR,
    createdAt: NOW - 200 * DAY,
  },
  {
    id: 'skyblock',
    name: 'Skyblock',
    iconHue: 190,
    minecraft: '1.20.4',
    loader: { kind: 'quilt', version: '0.26.4' },
    folderId: 'minigames',
    pinned: false,
    state: { kind: 'idle' },
    lastPlayedAt: NOW - 21 * DAY,
    playTimeMs: 2 * HOUR,
    createdAt: NOW - 40 * DAY,
  },
  {
    id: 'beta',
    name: 'Beta 1.7.3 Nostalgia',
    iconHue: 45,
    minecraft: 'b1.7.3',
    loader: { kind: 'vanilla' },
    folderId: 'minigames',
    pinned: false,
    state: { kind: 'idle' },
    lastPlayedAt: NOW - 90 * DAY,
    playTimeMs: 1 * HOUR,
    createdAt: NOW - 300 * DAY,
  },
]

export const fixtureFolders: InstanceFolder[] = [
  { id: 'tech', name: 'Tech Packs', expanded: true },
  { id: 'minigames', name: 'Experiments', expanded: false },
]

export function fixtureLogFiles(instanceId: string): LogFile[] {
  const running = fixtureInstances.find((i) => i.id === instanceId)?.state.kind === 'running'
  const files: LogFile[] = []
  if (running) files.push({ id: 'live', kind: 'live', name: 'Live', createdAt: NOW, sizeBytes: 0 })
  files.push(
    { id: 'latest', kind: 'log', name: 'latest.log', createdAt: NOW - 2 * HOUR, sizeBytes: 812_000 },
    { id: 'crash-1', kind: 'crash', name: 'crash-2026-10-23_21.14.02-client.txt', createdAt: NOW - DAY, sizeBytes: 22_000 },
    { id: '2026-10-23-2', kind: 'log', name: '2026-10-23-2.log.gz', createdAt: NOW - DAY - HOUR, sizeBytes: 420_000 },
    { id: '2026-10-23-1', kind: 'log', name: '2026-10-23-1.log.gz', createdAt: NOW - DAY - 3 * HOUR, sizeBytes: 380_000 },
    { id: '2026-10-19-1', kind: 'log', name: '2026-10-19-1.log.gz', createdAt: NOW - 5 * DAY, sizeBytes: 510_000 },
  )
  return files
}

const logTemplates: [LogLevel, string, string][] = [
  ['info', 'Render thread', 'Setting user: Steve'],
  ['info', 'Render thread', 'Backend library: LWJGL version 3.3.3-snapshot'],
  ['info', 'Worker-Main-1', 'Loaded 1286 recipes'],
  ['info', 'Render thread', 'Reloading ResourceManager: vanilla, fabric, Faithful 32x'],
  ['debug', 'Worker-Main-3', 'Baking 4932 models'],
  ['warn', 'Render thread', 'Shader rendertype_entity_translucent_emissive could not find sampler named Sampler2'],
  ['info', 'Sound engine', 'OpenAL initialized on device CoreAudio Default'],
  ['info', 'Render thread', 'Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas'],
  ['warn', 'Worker-Main-2', 'Missing model for variant: create:copper_backtank'],
  ['error', 'Render thread', 'Failed to load texture minecraft:textures/entity/broken.png'],
  ['info', 'Server thread', 'Preparing spawn area: 84%'],
  ['info', 'Server thread', 'Saving chunks for level ServerLevel[New World]/minecraft:overworld'],
]

const logCache = new Map<string, LogLine[]>()

/** A long log (5k lines) so the viewer's virtualisation and search are exercised. */
export function fixtureLogLines(fileId: string): LogLine[] {
  const cached = logCache.get(fileId)
  if (cached) return cached
  const rand = rng(fileId.length * 97)
  const count = fileId.startsWith('crash') ? 0 : 5000
  const out: LogLine[] = []
  let t = 9 * 3600 + 12 * 60
  for (let n = 0; n < count; n++) {
    // Repeat some lines so the ×N collapsing shows.
    const tpl = n % 40 < 3 ? logTemplates[5]! : logTemplates[Math.floor(rand() * logTemplates.length)]!
    t += rand() < 0.2 ? 1 : 0
    const hh = String(Math.floor(t / 3600) % 24).padStart(2, '0')
    const mm = String(Math.floor(t / 60) % 60).padStart(2, '0')
    const ss = String(t % 60).padStart(2, '0')
    out.push({ n, time: `${hh}:${mm}:${ss}`, level: tpl[0], thread: tpl[1], source: tpl[0] === 'warn' ? 'ShaderInstance' : 'Minecraft', text: tpl[2] })
  }
  logCache.set(fileId, out)
  return out
}

export const fixtureCrashText = `---- Minecraft Crash Report ----
// Who set us up the TNT?

Time: 2026-10-23 21:14:02
Description: Mod loading failed

java.lang.NoClassDefFoundError: dev/architectury/event/events/client/ClientLifecycleEvent
\tat com.example.waystones.client.WaystonesClient.onInitializeClient(WaystonesClient.java:41)
\tat net.fabricmc.loader.impl.entrypoint.EntrypointUtils.invoke0(EntrypointUtils.java:47)
\tat net.fabricmc.loader.impl.game.minecraft.Hooks.startClient(Hooks.java:52)
\tat net.minecraft.client.MinecraftClient.<init>(MinecraftClient.java:470)
Caused by: java.lang.ClassNotFoundException: dev.architectury.event.events.client.ClientLifecycleEvent
\t... 4 more

-- System Details --
Minecraft Version: 1.21.1
Operating System: Mac OS X (aarch64) version 15.1
Java Version: 21.0.5, Eclipse Adoptium
Memory: 2147483648 bytes (2048 MiB) / 4294967296 bytes (4096 MiB)
Fabric Mods: 186 loaded`

export const fixtureAccounts: Account[] = [
  { id: 'a1', kind: 'microsoft', name: 'Steve', uuid: '8667ba71-b85a-4004-af54-457a9734eed7', status: 'ok', active: true, hue: 210 },
  { id: 'a2', kind: 'microsoft', name: 'Alex_Builds', uuid: 'ec561538-f3fd-461d-aff5-086b22154bce', status: 'expired', active: false, hue: 25 },
  { id: 'a3', kind: 'offline', name: 'TestPlayer', uuid: '0f5a9c2e-0000-3000-8000-000000000001', status: 'ok', active: false, hue: 120 },
]

export const fixtureTasks: TaskSnapshot[] = [
  {
    id: 't-install',
    title: 'Installing Create: Above and Beyond',
    subtitle: 'Downloading mods (142 of 214)',
    kind: 'modpack',
    state: 'running',
    progress: 0.42,
    bytesDone: 143 * 1024 ** 2,
    bytesTotal: 340 * 1024 ** 2,
    etaMs: 125_000,
    startedAt: NOW - 90_000,
    instanceId: 'create',
    children: [
      { id: 'c1', title: 'Resolve modpack manifest', state: 'succeeded' },
      { id: 'c2', title: 'Install Forge 47.3.0', state: 'succeeded' },
      { id: 'c3', title: 'Download mods', state: 'running', progress: 0.66 },
      { id: 'c4', title: 'Apply overrides', state: 'queued' },
    ],
  },
  {
    id: 't-java',
    title: 'Downloading Java 21',
    subtitle: 'Mojang runtime · java-runtime-delta',
    kind: 'java',
    state: 'paused',
    progress: 0.18,
    bytesDone: 31 * 1024 ** 2,
    bytesTotal: 172 * 1024 ** 2,
    startedAt: NOW - 300_000,
    children: [],
  },
  {
    id: 't-export',
    title: 'Exporting “Survival 1.21”',
    kind: 'export',
    state: 'failed',
    startedAt: NOW - 40 * 60_000,
    finishedAt: NOW - 39 * 60_000,
    error: { message: 'The destination folder is read-only.', details: 'EACCES: permission denied, open /Volumes/Backup/Survival 1.21.mrpack' },
    children: [],
  },
  {
    id: 't-mods',
    title: 'Updated 6 mods in “Fabulously Optimized”',
    kind: 'download',
    state: 'succeeded',
    startedAt: NOW - 3 * HOUR,
    finishedAt: NOW - 3 * HOUR + 20_000,
    children: [],
  },
]

export const fixtureHomeUpdates: HomeUpdate[] = [
  { id: 'u1', text: '13 mod updates in “Survival 1.21”', instanceId: 'survival', tab: 'mods' },
  { id: 'u2', text: 'Fabulously Optimized 6.3.0 is available', instanceId: 'fabulously', tab: 'overview' },
]

export const fixtureJava: JavaRuntime[] = [
  { id: 'j21', version: '21.0.5', major: 21, vendor: 'Mojang (Microsoft)', arch: 'arm64', path: '~/Library/Application Support/Amethyst/runtime/java-runtime-delta', source: 'managed' },
  { id: 'j17', version: '17.0.13', major: 17, vendor: 'Eclipse Temurin', arch: 'arm64', path: '/Library/Java/JavaVirtualMachines/temurin-17.jdk', source: 'system' },
  { id: 'j8', version: '1.8.0_432', major: 8, vendor: 'Azul Zulu', arch: 'arm64', path: '~/Library/Application Support/Amethyst/runtime/zulu-8', source: 'managed' },
  { id: 'j8x', version: '1.8.0_301', major: 8, vendor: 'Oracle', arch: 'x86_64', path: '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin', source: 'system' },
]

export const fixtureGameVersions: GameVersion[] = (() => {
  const out: GameVersion[] = []
  const releases = [
    '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21', '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19', '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17', '1.16.5', '1.16.4',
    '1.16.3', '1.16.2', '1.16.1', '1.16', '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.11.2', '1.10.2', '1.9.4', '1.8.9', '1.7.10',
  ]
  let t = NOW - 40 * DAY
  out.push({ id: '24w46a', type: 'snapshot', releasedAt: NOW - 10 * DAY }, { id: '24w45a', type: 'snapshot', releasedAt: NOW - 17 * DAY })
  for (const id of releases) {
    out.push({ id, type: 'release', releasedAt: t })
    t -= 45 * DAY
  }
  out.push({ id: 'b1.7.3', type: 'old_beta', releasedAt: Date.UTC(2011, 6, 8) })
  return out
})()
