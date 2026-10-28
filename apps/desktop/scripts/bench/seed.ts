/* oxlint-disable no-await-in-loop -- the fixture is written sequentially to keep it deterministic */
/**
 * The seeded data root used by the benchmark (`scripts/bench/run.ts`): 60 instances, one of them
 * ("Bench Large") with 400 Fabric mods, 200 resource packs and 50 worlds. Every jar, zip, PNG and
 * level.dat is generated here, deterministically (seeded PRNG), with `@amethyst/zip` and
 * `@amethyst/nbt`.
 *
 * Game files are not generated: when a cache root is given (default `/tmp/amethyst-e2e-root`, the
 * E2E drivers' cache) its `minecraft/`, `runtimes/` and metadata caches are cloned in (APFS clones),
 * so installs verify instead of downloading and Play can spawn a real game.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { nbt, writeNbt } from '@amethyst/nbt'
import { createZip } from '@amethyst/zip'

/** Bump when the generated fixture changes; an existing seed with another version is rebuilt. */
export const SEED_VERSION = 3

export const SEED = {
  instances: 60,
  mods: 400,
  resourcePacks: 200,
  worlds: 50,
  large: 'Bench Large',
  vanilla: 'Bench Vanilla',
} as const

/** Mulberry32: a tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** An RGBA PNG of `size`×`size`: a hue gradient with per-pixel noise, so it compresses like real art. */
export function makePng(size: number, hue: number, rand: () => number): Buffer {
  const row = size * 4 + 1
  const raw = Buffer.alloc(row * size)
  const [r0, g0, b0] = [Math.round(127 + 127 * Math.cos(hue)), Math.round(127 + 127 * Math.cos(hue + 2.1)), Math.round(127 + 127 * Math.cos(hue + 4.2))]
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0
    for (let x = 0; x < size; x++) {
      const o = y * row + 1 + x * 4
      // Pixel-art-ish blocks plus noise.
      const block = ((x >> 3) + (y >> 3)) & 1 ? 30 : 0
      const n = Math.floor(rand() * 40)
      raw[o] = (r0 + block + n) & 255
      raw[o + 1] = (g0 + (x * 255) / size / 4 + n) & 255
      raw[o + 2] = (b0 + (y * 255) / size / 4 + n) & 255
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Typical mod icon sizes on Modrinth/CurseForge: mostly 128–512 px, a few tiny and a few huge. */
function iconSize(rand: () => number): number {
  const r = rand()
  if (r < 0.15) return 64
  if (r < 0.45) return 128
  if (r < 0.75) return 256
  if (r < 0.95) return 512
  return 1024
}

async function zip(file: string, entries: [string, Uint8Array, boolean?][]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const w = createZip(file)
  for (const [name, data, compress] of entries) w.addBuffer(data, name, { compress: compress ?? true, mtime: new Date(1_760_000_000_000) })
  await w.finish()
}

function instanceJson(id: string, name: string, minecraft: string, versionId: string, fabric = '', i = 0) {
  const t = 1_790_000_000_000 + i * 3_600_000
  return {
    schemaVersion: 1,
    id,
    name,
    author: '',
    description: '',
    icon: '',
    homepageUrl: '',
    runtime: { minecraft, forge: '', neoforge: '', fabric, quilt: '' },
    versionId,
    overrides: {},
    upstream: null,
    createdAt: t,
    lastOpenedAt: t,
    lastPlayedAt: i % 3 === 0 ? t + 1000 : 0,
    playTimeMs: i % 3 === 0 ? 60_000 * i : 0,
  }
}

const uuid = (rand: () => number) =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(rand() * 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

async function writeInstance(root: string, config: ReturnType<typeof instanceJson>): Promise<string> {
  const dir = path.join(root, 'instances', config.name)
  await mkdir(path.join(dir, '.amethyst'), { recursive: true })
  for (const sub of ['mods', 'resourcepacks', 'saves', 'shaderpacks']) await mkdir(path.join(dir, sub), { recursive: true })
  await writeFile(path.join(dir, '.amethyst', 'instance.json'), `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

async function writeMods(dir: string, rand: () => number): Promise<void> {
  for (let i = 0; i < SEED.mods; i++) {
    const id = `bench_mod_${String(i).padStart(3, '0')}`
    const name = `Bench Mod ${i}`
    const icon = `assets/${id}/icon.png`
    const meta = {
      schemaVersion: 1,
      id,
      version: `1.${i % 7}.${i % 13}+mc1.20.1`,
      name,
      description: `Benchmark fixture mod number ${i}.`,
      authors: ['Amethyst Bench'],
      license: 'MIT',
      icon,
      environment: '*',
      depends: { fabricloader: '>=0.14.0', minecraft: '~1.20.1', ...(i % 10 === 5 ? { [`bench_mod_${String(i - 1).padStart(3, '0')}`]: '*' } : {}) },
    }
    const classes: [string, Uint8Array, boolean?][] = []
    const classCount = 3 + Math.floor(rand() * 12)
    for (let c = 0; c < classCount; c++) {
      // Class files: half structure (compressible), half noise.
      const n = 1024 + Math.floor(rand() * 12_000)
      const b = Buffer.alloc(n)
      for (let k = 0; k < n; k++) b[k] = k % 2 ? Math.floor(rand() * 256) : k & 0x3f
      classes.push([`dev/amethyst/bench/${id}/C${c}.class`, b])
    }
    await zip(path.join(dir, 'mods', `${id}-${meta.version}.jar`), [
      ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\n\r\n')],
      ['fabric.mod.json', Buffer.from(JSON.stringify(meta, null, 2))],
      [icon, makePng(iconSize(rand), i * 0.37, rand), false],
      ...classes,
    ])
  }
}

async function writeResourcePacks(dir: string, rand: () => number): Promise<void> {
  for (let i = 0; i < SEED.resourcePacks; i++) {
    const textures: [string, Uint8Array, boolean?][] = []
    for (let t = 0; t < 4; t++) textures.push([`assets/minecraft/textures/block/bench_${t}.png`, makePng(16, i + t, rand), false])
    await zip(path.join(dir, 'resourcepacks', `Bench Pack ${String(i).padStart(3, '0')}.zip`), [
      ['pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 15, description: `Benchmark resource pack ${i}` } }))],
      ['pack.png', makePng(i % 4 === 0 ? 256 : 128, i * 0.53, rand), false],
      ...textures,
    ])
  }
}

async function writeWorlds(dir: string, rand: () => number): Promise<void> {
  for (let i = 0; i < SEED.worlds; i++) {
    const world = path.join(dir, 'saves', `Bench World ${String(i).padStart(2, '0')}`)
    await mkdir(path.join(world, 'region'), { recursive: true })
    const data = {
      LevelName: nbt.string(`Bench World ${i}`),
      DataVersion: nbt.int(3465),
      Version: nbt.compound({ Id: nbt.int(3465), Name: nbt.string('1.20.1'), Snapshot: nbt.byte(0) }),
      GameType: nbt.int(i % 4 === 0 ? 1 : 0),
      Difficulty: nbt.byte(2),
      hardcore: nbt.byte(i % 10 === 0 ? 1 : 0),
      allowCommands: nbt.byte(1),
      LastPlayed: nbt.long(BigInt(1_790_000_000_000 + i * 86_400_000)),
      Time: nbt.long(24_000n * BigInt(i + 1)),
      WorldGenSettings: nbt.compound({ seed: nbt.long(BigInt(i) * 7_919_000_003n) }),
      WasModded: nbt.byte(1),
    }
    await writeFile(path.join(world, 'level.dat'), await writeNbt({ root: nbt.compound({ Data: nbt.compound(data) }) }, { compression: 'gzip' }))
    await writeFile(path.join(world, 'icon.png'), makePng(64, i * 0.71, rand))
    const region = Buffer.alloc(64 * 1024)
    for (let k = 0; k < region.length; k += 7) region[k] = Math.floor(rand() * 256)
    await writeFile(path.join(world, 'region', 'r.0.0.mca'), region)
  }
}

export interface SeedOptions {
  /** Where to build the seed. */
  root: string
  /** A data root to clone `minecraft/`, `runtimes/` and metadata caches from (APFS clones). */
  cache?: string
  force?: boolean
}

export interface SeedInfo {
  root: string
  version: number
  largeId: string
  vanillaId: string
  gameFiles: boolean
}

/** Build (or reuse) the seeded data root. */
export async function seedDataRoot(o: SeedOptions): Promise<SeedInfo> {
  const marker = path.join(o.root, '.bench-seed.json')
  if (!o.force && existsSync(marker)) {
    const info = JSON.parse(await readFile(marker, 'utf8')) as SeedInfo
    if (info.version === SEED_VERSION) return info
  }
  await rm(o.root, { recursive: true, force: true })
  await mkdir(o.root, { recursive: true })
  const rand = prng(0xa3e7)

  const cache = o.cache && existsSync(path.join(o.cache, 'minecraft')) ? o.cache : undefined
  if (cache) {
    for (const rel of ['minecraft', 'runtimes', 'cache/meta', 'cache/natives', 'cache/java-probe.json']) {
      const src = path.join(cache, rel)
      if (!existsSync(src)) continue
      await mkdir(path.dirname(path.join(o.root, rel)), { recursive: true })
      execFileSync('/bin/cp', ['-cR', src, path.join(o.root, rel)])
    }
  }
  const has = (v: string) => existsSync(path.join(o.root, 'minecraft', 'versions', v, `${v}.json`))
  const fabricVersion = has('1.20.1-fabric0.20.1') ? '1.20.1-fabric0.20.1' : ''
  const vanillaVersion = has('1.21.1') ? '1.21.1' : ''

  // Settings: developer mode (offline accounts), first run answered, no telemetry, no update checks.
  await writeFile(
    path.join(o.root, 'settings.json'),
    `${JSON.stringify({ schemaVersion: 1, general: { developerMode: true }, privacy: { usageData: false, crashReports: false, prompted: true } }, null, 2)}\n`,
  )
  const accountUuid = uuid(rand)
  await writeFile(
    path.join(o.root, 'accounts.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        accounts: [{ id: `offline:${accountUuid}`, username: 'BenchPlayer', uuid: accountUuid, accessTokenExpiresAt: Number.MAX_SAFE_INTEGER, skins: [], capes: [], kind: 'offline' }],
        selectedId: `offline:${accountUuid}`,
      },
      null,
      2,
    )}\n`,
  )

  const largeId = uuid(rand)
  const large = await writeInstance(o.root, instanceJson(largeId, SEED.large, '1.20.1', fabricVersion, '0.20.1', 0))
  await writeMods(large, rand)
  await writeResourcePacks(large, rand)
  await writeWorlds(large, rand)

  const vanillaId = uuid(rand)
  await writeInstance(o.root, instanceJson(vanillaId, SEED.vanilla, '1.21.1', vanillaVersion, '', 1))
  for (let i = 2; i < SEED.instances; i++) {
    const fabric = i % 4 === 0
    const dir = await writeInstance(
      o.root,
      instanceJson(uuid(rand), `Bench ${String(i).padStart(2, '0')}`, fabric ? '1.20.1' : '1.21.1', fabric ? fabricVersion : vanillaVersion, fabric ? '0.20.1' : '', i),
    )
    // A handful of content in every instance, as real libraries have.
    if (fabric) {
      for (let m = 0; m < 3; m++) {
        await zip(path.join(dir, 'mods', `small-${i}-${m}.jar`), [
          ['fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: `small_${i}_${m}`, version: '1.0.0', name: `Small ${i}.${m}` }))],
        ])
      }
    }
  }

  const info: SeedInfo = { root: o.root, version: SEED_VERSION, largeId, vanillaId, gameFiles: !!(fabricVersion && vanillaVersion) }
  await writeFile(marker, `${JSON.stringify(info, null, 2)}\n`)
  return info
}
