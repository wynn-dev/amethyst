/**
 * Placeholder data for screens whose services are not wired yet. Deterministic, so screenshots
 * and tests are stable. Delete this file once every hook in `data/` calls the real `api`.
 */
import type {
  Account,
  GameVersion,
  HomeUpdate,
  InstanceDetail,
  InstanceFolder,
  InstanceSummary,
  JavaRuntime,
  LogFile,
  LogLevel,
  LogLine,
  ModFile,
  ProjectDetail,
  ProjectHit,
  ProjectType,
  ResourcePack,
  ShaderPack,
  TaskSnapshot,
  World,
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

export function fixtureInstanceDetail(id: string): InstanceDetail | undefined {
  const base = fixtureInstances.find((i) => i.id === id)
  if (!base) return undefined
  const vanilla = base.loader.kind === 'vanilla'
  const mods = vanilla ? [] : fixtureMods(id)
  const issues: InstanceDetail['issues'] = []
  if (id === 'atm') issues.push({ id: 'java', severity: 'error', title: 'Java 21 is required', action: { label: 'Download', command: 'java.download' } })
  if (id === 'survival' || id === 'atm') {
    issues.push({ id: 'updates', severity: 'warning', title: `${mods.filter((m) => m.update).length} mod updates available`, action: { label: 'Review', command: 'mods.updates' } })
  }
  if (id === 'create') issues.push({ id: 'missing', severity: 'warning', title: '2 files are missing', action: { label: 'Repair', command: 'instance.repair' } })
  return {
    ...base,
    path: `~/Library/Application Support/Amethyst/instances/${id}`,
    notes: '',
    diskBytes: (vanilla ? 0.4 : 2.6) * 1024 ** 3,
    counts: {
      modsEnabled: mods.filter((m) => m.enabled).length,
      modsTotal: mods.length,
      resourcePacks: fixtureResourcePacks(id).length,
      shaders: fixtureShaders(id).length,
      worlds: fixtureWorlds(id).length,
    },
    issues,
    screenshots: Array.from({ length: vanilla ? 3 : 7 }, (_, i) => ({ id: `s${i}`, takenAt: NOW - i * 2 * DAY, hue: (base.iconHue + i * 37) % 360 })),
  }
}

const modNames = [
  ['Sodium', 'CaffeineMC', 'The fastest rendering optimisation mod for Minecraft.'],
  ['Iris Shaders', 'coderbot', 'A modern shader pack loader compatible with existing OptiFine shader packs.'],
  ['Fabric API', 'modmuss50', 'Lightweight and modular API providing common hooks and intercompatibility measures.'],
  ['Lithium', 'CaffeineMC', 'No-compromises game logic optimisation mod.'],
  ['Mod Menu', 'Prospector', 'Adds a mod menu to view the list of mods you have installed.'],
  ['Xaero’s Minimap', 'xaero96', 'Displays the map of the area around you.'],
  ['JourneyMap', 'techbrew', 'Real-time mapping in game or in a web browser as you explore.'],
  ['Cloth Config API', 'shedaniel', 'Configuration library for Minecraft mods.'],
  ['Entity Culling', 'tr7zw', 'Uses async path-tracing to hide block entities that are not visible.'],
  ['Continuity', 'PepperCode1', 'A Fabric mod that allows for efficient connected textures.'],
  ['YetAnotherConfigLib', 'isXander', 'A builder-based configuration library for Minecraft.'],
  ['ferritecore', 'malte0811', 'Memory usage optimisations.'],
  ['Zoomify', 'isXander', 'A zoom mod with infinite customisability.'],
  ['AppleSkin', 'squeek502', 'Food and hunger information in the HUD.'],
  ['Jade', 'Snownee', 'Shows information about what you are looking at.'],
  ['ModernFix', 'embeddedt', 'All-in-one mod that improves performance and load times.'],
  ['Indium', 'comp500', 'Sodium addon providing support for the Fabric Rendering API.'],
  ['Dynamic FPS', 'juliand665', 'Reduce resource usage while Minecraft is in the background.'],
  ['Debugify', 'isXander', 'Fixes Minecraft bugs found on the bug tracker.'],
  ['Clumps', 'Jaredlll08', 'Clumps XP orbs together to reduce lag.'],
]

const modCache = new Map<string, ModFile[]>()

/** Mods for an instance. The Survival instance gets a large list, to exercise virtualisation. */
export function fixtureMods(instanceId: string): ModFile[] {
  const cached = modCache.get(instanceId)
  if (cached) return cached
  const inst = fixtureInstances.find((i) => i.id === instanceId)
  if (!inst || inst.loader.kind === 'vanilla') return []
  const rand = rng(instanceId.length * 7919)
  const count = instanceId === 'atm' ? 412 : instanceId === 'survival' ? 186 : 64
  const out: ModFile[] = []
  for (let i = 0; i < count; i++) {
    const [baseName, author, description] = modNames[i % modNames.length]!
    const name = i < modNames.length ? baseName! : `${baseName} ${['Addon', 'Extras', 'Compat', 'Tweaks', 'Plus', 'Lib'][i % 6]} ${Math.floor(i / modNames.length)}`
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const v = `${1 + Math.floor(rand() * 4)}.${Math.floor(rand() * 12)}.${Math.floor(rand() * 9)}`
    const r = rand()
    out.push({
      id: `${slug}-${i}`,
      name,
      version: v,
      fileName: `${slug}-${v}+${inst.minecraft}.jar`,
      author: author!,
      description: description!,
      enabled: rand() > 0.08,
      source: r < 0.62 ? 'modrinth' : r < 0.9 ? 'curseforge' : 'local',
      update: rand() < 0.07 ? { version: `${v.split('.')[0]}.${Number(v.split('.')[1]) + 1}.0` } : undefined,
      side: rand() < 0.15 ? 'client' : rand() < 0.1 ? 'server' : 'both',
      sizeBytes: Math.floor(40_000 + rand() * 4_000_000),
      addedAt: NOW - Math.floor(rand() * 90) * DAY,
      hue: Math.floor(rand() * 360),
      sha1: Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join(''),
      dependencies: i % 5 === 0 ? [{ id: 'fabric-api', name: 'Fabric API', satisfied: true }] : i === 7 ? [{ id: 'architectury', name: 'Architectury API', satisfied: false }] : [],
      dependents: i === 2 ? ['Sodium', 'Iris Shaders', 'Mod Menu'] : [],
      problem: i === 7 ? 'missing-dependency' : i === 23 || i === 43 ? 'duplicate' : i === 31 ? 'incompatible' : undefined,
    })
  }
  modCache.set(instanceId, out)
  return out
}

export function fixtureResourcePacks(instanceId: string): ResourcePack[] {
  if (instanceId === 'beta') return []
  const packs: [string, string, boolean, string | undefined][] = [
    ['Faithful 32x', 'The classic look, twice the resolution.', true, undefined],
    ['Fresh Animations', 'Breathes new life into vanilla mobs.', true, undefined],
    ['Stay True', 'A vanilla-plus resource pack.', true, '1.20'],
    ['Bare Bones', 'Simplified textures inspired by the trailers.', false, undefined],
    ['Default Dark Mode', 'Dark GUI for every screen.', false, undefined],
    ['Low On Fire', 'Lowers the fire overlay.', false, '1.19'],
  ]
  return packs.map(([name, description, enabled, madeFor], i) => ({
    id: `rp-${i}`,
    name,
    description,
    enabled,
    order: enabled ? i : undefined,
    packFormat: madeFor ? 15 : 34,
    compatible: !madeFor,
    madeFor,
    sizeBytes: 1_200_000 + i * 3_400_000,
    source: i % 3 === 2 ? 'curseforge' : 'modrinth',
    hue: (i * 53 + 20) % 360,
  }))
}

export function fixtureShaders(instanceId: string): ShaderPack[] {
  if (instanceId === 'vanilla' || instanceId === 'beta') return []
  return [
    ['Complementary Reimagined', true],
    ['BSL Shaders', false],
    ['Sildur’s Vibrant', false],
    ['MakeUp Ultra Fast', false],
  ].map(([name, active], i) => ({
    id: `sh-${i}`,
    name: name as string,
    active: active as boolean,
    sizeBytes: 600_000 + i * 900_000,
    source: 'modrinth' as const,
    hue: (i * 71 + 200) % 360,
  }))
}

export function fixtureWorlds(instanceId: string): World[] {
  if (instanceId === 'skyblock') return []
  const rand = rng(instanceId.length * 31)
  const names = ['New World', 'Hardcore Attempt 3', 'Creative Builds', 'Seed Hunting', 'Server Backup', 'Redstone Lab']
  return names.map((name, i) => ({
    id: `w-${i}`,
    name,
    gameMode: (['survival', 'hardcore', 'creative', 'survival', 'adventure', 'creative'] as const)[i]!,
    lastPlayedAt: NOW - i * 3 * DAY - HOUR,
    version: fixtureInstances.find((x) => x.id === instanceId)?.minecraft ?? '1.21.1',
    sizeBytes: Math.floor(8_000_000 + rand() * 400_000_000),
    seed: String(Math.floor(rand() * 9e18) - 4.5e18),
    difficulty: (['normal', 'hard', 'peaceful', 'easy', 'normal', 'peaceful'] as const)[i]!,
    cheats: i === 2 || i === 5,
    datapacks: i === 0 ? [{ id: 'dp1', name: 'Terralith', enabled: true }, { id: 'dp2', name: 'Incendium', enabled: false }] : [],
    hue: Math.floor(rand() * 360),
  }))
}

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

const projectSeeds: [string, string, string, ProjectType, string[]][] = [
  ['Fabulously Optimized', 'robotkoer', 'Improved performance, better graphics and more options with a simple install.', 'modpack', ['optimization']],
  ['Cobblemon Official', 'Cobblemon', 'The official Cobblemon modpack, curated by the team.', 'modpack', ['adventure']],
  ['Better MC [FABRIC]', 'SharkieFPS', 'Vanilla+ experience with over 250 mods.', 'modpack', ['adventure', 'quests']],
  ['All the Mods 10', 'ATMTeam', 'Kitchen-sink pack with tech, magic and exploration.', 'modpack', ['technology', 'magic']],
  ['Create: Above and Beyond', 'simibubi', 'A Create-themed expert pack with a focus on automation.', 'modpack', ['technology', 'quests']],
  ['Simply Optimized', 'Cupra', 'Performance pack without changing the vanilla look.', 'modpack', ['optimization']],
  ['Sodium', 'jellysquid3', 'The fastest and most compatible rendering optimisation mod.', 'mod', ['optimization']],
  ['Iris Shaders', 'coderbot', 'A modern shader pack loader.', 'mod', ['decoration']],
  ['Lithium', 'jellysquid3', 'No-compromises game logic optimisation.', 'mod', ['optimization']],
  ['Faithful 32x', 'Faithful Resource Pack', 'The classic look, twice the resolution.', 'resourcepack', ['32x']],
  ['Complementary Reimagined', 'EminGT', 'Shaderpack focused on quality and compatibility.', 'shader', ['realistic']],
  ['Terralith', 'Stardust Labs', 'Explore almost 100 new biomes with vanilla blocks.', 'datapack', ['worldgen']],
]

export function fixtureProjects(type: ProjectType, query: string): ProjectHit[] {
  const rand = rng(type.length * 17 + query.length)
  const base = projectSeeds.filter(([, , , t]) => t === type)
  const list: ProjectHit[] = []
  const total = query ? 40 : 24
  for (let i = 0; i < total; i++) {
    const seed = base[i % Math.max(1, base.length)] ?? projectSeeds[i % projectSeeds.length]!
    const [title, author, summary, , categories] = seed
    const name = i < base.length ? title : `${query ? capitalise(query) + ' ' : ''}${['Plus', 'Reloaded', 'Lite', 'Remastered', 'Essentials', 'Expanded'][i % 6]} ${title.split(' ')[0]}`
    list.push({
      id: `${type}-${i}`,
      source: i % 3 === 1 ? 'curseforge' : 'modrinth',
      type,
      title: name,
      author,
      summary,
      downloads: Math.floor(rand() * 40_000_000),
      follows: Math.floor(rand() * 90_000),
      updatedAt: NOW - Math.floor(rand() * 60) * DAY,
      categories,
      gameVersions: ['1.21.1', '1.20.1'],
      loaders: type === 'mod' ? ['fabric', 'quilt'] : type === 'modpack' ? [i % 2 ? 'forge' : 'fabric'] : [],
      hue: Math.floor(rand() * 360),
      installed: i === 0 ? 'installed' : i === 3 ? 'update' : undefined,
    })
  }
  return list
}

export function fixtureProject(id: string): ProjectDetail | undefined {
  const type = id.split('-').slice(0, -1).join('-') as ProjectType
  const hit = fixtureProjects(type, '').find((p) => p.id === id)
  if (!hit) return undefined
  const rand = rng(id.length)
  return {
    ...hit,
    body:
      `${hit.title} ${hit.summary}\n\n` +
      'This description is placeholder text. When the marketplace service is wired, the project body is rendered from Markdown in a lazily loaded renderer.\n\n' +
      'Features\n• Works out of the box\n• Compatible with popular mods\n• Regular updates',
    links: [
      { label: 'Website', url: 'https://modrinth.com' },
      { label: 'Issues', url: 'https://github.com' },
      { label: 'Source', url: 'https://github.com' },
    ],
    versions: Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`,
      name: `${6 - Math.floor(i / 6)}.${5 - (i % 6)}.0`,
      channel: i % 7 === 3 ? 'beta' : i % 11 === 5 ? 'alpha' : 'release',
      gameVersions: [i < 10 ? '1.21.1' : '1.20.1'],
      loaders: hit.loaders,
      publishedAt: NOW - i * 9 * DAY,
      downloads: Math.floor(rand() * 2_000_000),
    })),
    gallery: Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, hue: (hit.hue + i * 40) % 360, title: `Screenshot ${i + 1}` })),
    alsoOn: hit.source === 'modrinth' ? 'curseforge' : undefined,
    license: 'MIT',
  }
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
