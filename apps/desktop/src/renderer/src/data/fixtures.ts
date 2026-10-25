/**
 * Placeholder data for screens whose services are not wired yet. Deterministic, so screenshots
 * and tests are stable. Delete this file once every hook in `data/` calls the real `api`.
 */
import type { InstanceSummary, ModFile, ProjectDetail, ProjectHit, ProjectType, ResourcePack, ShaderPack, World } from './types'

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
