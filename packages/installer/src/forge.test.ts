/* oxlint-disable no-await-in-loop -- test setup is sequential */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { openZip } from '@amethyst/zip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildZip, bytes, processorJar, sha1, sha256, startServer, tempDir, type TestServer } from './__fixtures__/helpers'
import { publishMiniVersion } from './__fixtures__/mini'
import {
  createMetadataClient,
  installForge,
  installNeoForge,
  LEGACY_FML_LIBRARIES,
  type MetadataClient,
  planInstall,
  type ProcessorInvocation,
  type ProcessorRunner,
  repairVersion,
  runInstall,
} from './index'

let server: TestServer
let http: HttpClient
let root: string
let meta: MetadataClient

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex')

beforeAll(async () => {
  server = await startServer()
  http = createHttpClient({ retry: { retries: 0 } })
})
afterAll(async () => {
  await http.close()
  await server.close()
})
beforeEach(async () => {
  root = await tempDir()
  server.requests.length = 0
  meta = createMetadataClient({
    http,
    endpoints: {
      mojangManifest: `${server.url}/manifest.json`,
      forgeMaven: `${server.url}/forge/`,
      forgeFiles: `${server.url}/forge-files/`,
      neoForgeMaven: `${server.url}/neo/`,
    },
  })
})
afterEach(() => rm(root, { recursive: true, force: true }))

function mavenMetadata(group: string, artifact: string, versions: string[]): string {
  return `<?xml version="1.0"?><metadata><groupId>${group}</groupId><artifactId>${artifact}</artifactId><versioning><versions>${versions
    .map((v) => `<version>${v}</version>`)
    .join('')}</versions></versioning></metadata>`
}

/** Publish a jar on the test maven and return the library entry describing it. */
async function publishLibrary(repo: string, path: string, data: Buffer) {
  server.file(`/${repo}/${path}`, data)
  return { path, url: `${server.url}/${repo}/${path}`, sha1: sha1(data), size: data.length }
}

/**
 * A synthetic NeoForge 21.1.999 installer for Minecraft 1.21.1 with the shape of the real one:
 * processor libraries, an embedded `maven/` artifact, `data/client.lzma`, a server-only processor,
 * a DOWNLOAD_MOJMAPS processor (handled natively) and a patching processor.
 */
async function publishNeoForge(options: { sidecar?: 'sha256' | 'sha1' | 'none' | 'wrong' } = {}) {
  const version = '21.1.999'
  const tool = await publishLibrary('neo', 'net/neoforged/installertools/1.0/installertools-1.0.jar', await processorJar('net.neoforged.installertools.ConsoleTool'))
  const extra = await publishLibrary('neo', 'net/neoforged/extra/1.0/extra-1.0.jar', await buildZip({ 'Extra.class': 'x' }))
  const embedded = await buildZip({ 'Embedded.class': 'e' })
  const lzma = bytes(4000, 42)
  const profile = {
    spec: 1,
    profile: 'NeoForge',
    version: `neoforge-${version}`,
    minecraft: '1.21.1',
    json: '/version.json',
    icon: 'data:image/png;base64,AAAA',
    data: {
      BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
      MOJMAPS: { client: '[net.minecraft:client:1.21.1-1:mappings@txt]', server: '[net.minecraft:server:1.21.1-1:mappings@txt]' },
      PATCHED: { client: `[net.neoforged:neoforge:${version}:client]`, server: `[net.neoforged:neoforge:${version}:server]` },
      MCP_VERSION: { client: "'1.21.1-1'", server: "'1.21.1-1'" },
    },
    processors: [
      { sides: ['server'], jar: 'net.neoforged:installertools:1.0', args: ['--task', 'EXTRACT_FILES', '--archive', '{INSTALLER}'] },
      { jar: 'net.neoforged:installertools:1.0', args: ['--task', 'DOWNLOAD_MOJMAPS', '--version', '1.21.1', '--side', '{SIDE}', '--output', '{MOJMAPS}'] },
      {
        jar: 'net.neoforged:installertools:1.0',
        args: ['--task', 'PROCESS_MINECRAFT_JAR', '--input', '{MINECRAFT_JAR}', '--output', '{PATCHED}', '--apply-patches', '{BINPATCH}', '--mcp', '{MCP_VERSION}'],
      },
    ],
    libraries: [{ name: 'net.neoforged:installertools:1.0', downloads: { artifact: tool } }],
  }
  const versionJson = {
    id: `neoforge-${version}`,
    inheritsFrom: '1.21.1',
    type: 'release',
    mainClass: 'net.neoforged.fml.startup.Client',
    arguments: { game: ['--fml.neoForgeVersion', version], jvm: [] },
    libraries: [
      { name: 'net.neoforged:extra:1.0', downloads: { artifact: extra } },
      { name: 'net.neoforged:embedded:1.0', downloads: { artifact: { path: 'net/neoforged/embedded/1.0/embedded-1.0.jar', url: '', sha1: sha1(embedded), size: embedded.length } } },
    ],
  }
  const installer = await buildZip({
    'install_profile.json': JSON.stringify(profile),
    'version.json': JSON.stringify(versionJson),
    'data/client.lzma': lzma,
    'data/server.lzma': bytes(100, 43),
    'data/run.sh': '#!/bin/sh',
    'maven/net/neoforged/embedded/1.0/embedded-1.0.jar': embedded,
  })
  const base = `/neo/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
  server.file('/neo/net/neoforged/neoforge/maven-metadata.xml', mavenMetadata('net.neoforged', 'neoforge', ['21.1.998', version]))
  server.file(base, installer)
  server.route(`${base}.sha256`, (_req, res) => {
    res.statusCode = 404
    res.end()
  })
  server.route(`${base}.sha1`, (_req, res) => {
    res.statusCode = 404
    res.end()
  })
  const sidecar = options.sidecar ?? 'sha256'
  if (sidecar === 'sha256') server.file(`${base}.sha256`, sha256(installer))
  if (sidecar === 'sha1') server.file(`${base}.sha1`, `${sha1(installer)}  neoforge-${version}-installer.jar`)
  if (sidecar === 'wrong') server.file(`${base}.sha256`, sha256(Buffer.from('something else')))
  return { version, installer, installerPath: base, lzma, embedded }
}

/** A runner standing in for the NeoForge tools: writes `--output` as a zip. */
function recordingRunner(calls: ProcessorInvocation[]): ProcessorRunner {
  return async (inv) => {
    calls.push(inv)
    const out = inv.args[inv.args.indexOf('--output') + 1] as string
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, await buildZip({ 'net/minecraft/client/Main.class': 'patched' }))
    return { exitCode: 0, signal: null, log: 'done' }
  }
}

async function installVanilla121() {
  await publishMiniVersion(server, '1.21.1', { mappings: true })
  return runInstall(await planInstall({ minecraft: '1.21.1' }, { root, meta, http }), { root, http, meta, assetsBaseUrl: `${server.url}/assets/` })
}

describe('NeoForge', () => {
  it('plans and installs through the processor workflow', async () => {
    const neo = await publishNeoForge()
    await publishMiniVersion(server, '1.21.1', { mappings: true })
    const plan = await planInstall({ minecraft: '1.21.1', loader: { kind: 'neoforge', version: neo.version } }, { root, meta, http })
    expect(plan).toMatchObject({ versionId: `neoforge-${neo.version}`, needsJava: true, javaMajor: 21 })
    expect(plan.steps.find((s) => s.id === 'loader')).toMatchObject({ bytes: neo.installer.length })
    expect(plan.steps.find((s) => s.id === 'processors')).toMatchObject({ needsJava: true })

    const calls: ProcessorInvocation[] = []
    const result = await runInstall(plan, {
      root,
      http,
      meta,
      assetsBaseUrl: `${server.url}/assets/`,
      runner: recordingRunner(calls),
      resolveJava: async (major) => `/jdk-${major}/bin/java`,
    })
    expect(result).toEqual({ versionId: 'neoforge-21.1.999', minecraftVersion: '1.21.1', javaMajor: 21, loader: { kind: 'neoforge', version: '21.1.999', format: 'modern' } })

    const lib = (p: string) => join(root, 'libraries', p)
    // The verified installer, the embedded maven artifact and the binary patches are unpacked.
    expect(await readFile(lib('net/neoforged/neoforge/21.1.999/neoforge-21.1.999-installer.jar'))).toEqual(neo.installer)
    expect(await readFile(lib('net/neoforged/embedded/1.0/embedded-1.0.jar'))).toEqual(neo.embedded)
    const lzmaPath = lib('net/neoforged/neoforge/21.1.999/neoforge-21.1.999-clientdata.lzma')
    expect(await readFile(lzmaPath)).toEqual(neo.lzma)
    // DOWNLOAD_MOJMAPS ran natively from the vanilla client_mappings; the server-only processor did not run.
    expect(await readFile(lib('net/minecraft/client/1.21.1-1/client-1.21.1-1-mappings.txt'), 'utf8')).toBe('net.minecraft.Client -> a:\n')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      java: '/jdk-21/bin/java',
      mainClass: 'net.neoforged.installertools.ConsoleTool',
      classpath: [lib('net/neoforged/installertools/1.0/installertools-1.0.jar')],
      cwd: root,
      args: [
        '--task',
        'PROCESS_MINECRAFT_JAR',
        '--input',
        join(root, 'versions/1.21.1/1.21.1.jar'),
        '--output',
        lib('net/neoforged/neoforge/21.1.999/neoforge-21.1.999-client.jar'),
        '--apply-patches',
        lzmaPath,
        '--mcp',
        '1.21.1-1',
      ],
    })

    const versionJson = JSON.parse(await readFile(join(root, 'versions/neoforge-21.1.999/neoforge-21.1.999.json'), 'utf8'))
    expect(versionJson).toMatchObject({ id: 'neoforge-21.1.999', inheritsFrom: '1.21.1', mainClass: 'net.neoforged.fml.startup.Client' })
    const stored = JSON.parse(await readFile(join(root, 'versions/neoforge-21.1.999/install_profile.json'), 'utf8'))
    expect(stored.icon).toBeUndefined()
    expect(stored.data.BINPATCH.client).toBe('[net.neoforged:neoforge:21.1.999:clientdata@lzma]')
    expect(stored.data.INSTALLER.client).toBe('[net.neoforged:neoforge:21.1.999:installer]')
    expect(await exists(lib('net/neoforged/extra/1.0/extra-1.0.jar'))).toBe(true)
    expect(await exists(join(root, 'versions/neoforge-21.1.999/.install-lock'))).toBe(true)

    // Idempotent: valid outputs mean no processor runs again.
    calls.length = 0
    await runInstall(plan, { root, http, meta, assetsBaseUrl: `${server.url}/assets/`, runner: recordingRunner(calls), java: '/jdk/bin/java' })
    expect(calls).toEqual([])

    // Repair: a missing processor product is rebuilt from the stored profile.
    await rm(lib('net/neoforged/neoforge/21.1.999/neoforge-21.1.999-client.jar'))
    let diagnoses = 0
    const repair = await repairVersion('neoforge-21.1.999', {
      root,
      http,
      java: '/jdk/bin/java',
      runner: recordingRunner(calls),
      diagnose: async () => {
        diagnoses++
        const p = lib('net/neoforged/neoforge/21.1.999/neoforge-21.1.999-client.jar')
        return (await exists(p)) ? [] : [{ kind: 'library' as const, name: 'net.neoforged:neoforge:21.1.999:client', path: p, problem: 'missing' as const, expected: {}, url: '' }]
      },
    })
    expect(repair).toMatchObject({ reranProcessors: true, after: [] })
    expect(diagnoses).toBe(2)
    expect(calls.map((c) => c.args[1])).toEqual(['PROCESS_MINECRAFT_JAR'])
  })

  it('accepts a .sha1 sidecar when there is no .sha256', async () => {
    const neo = await publishNeoForge({ sidecar: 'sha1' })
    await installVanilla121()
    const calls: ProcessorInvocation[] = []
    const r = await installNeoForge(neo.version, { root, http, meta, java: '/j', runner: recordingRunner(calls) })
    expect(r.versionId).toBe('neoforge-21.1.999')
    expect(calls).toHaveLength(1)
  })

  it('fails closed when the installer does not match its sidecar', async () => {
    const neo = await publishNeoForge({ sidecar: 'wrong' })
    await installVanilla121()
    const calls: ProcessorInvocation[] = []
    await expect(installNeoForge(neo.version, { root, http, meta, java: '/j', runner: recordingRunner(calls) })).rejects.toMatchObject({ code: 'EDOWNLOAD' })
    expect(calls).toEqual([])
    expect(await exists(join(root, 'libraries/net/neoforged/neoforge/21.1.999/neoforge-21.1.999-installer.jar'))).toBe(false)
    expect(await exists(join(root, 'versions/neoforge-21.1.999'))).toBe(false)
  })

  it('fails closed when no sidecar exists, without downloading the installer', async () => {
    const neo = await publishNeoForge({ sidecar: 'none' })
    await installVanilla121()
    const calls: ProcessorInvocation[] = []
    await expect(installNeoForge(neo.version, { root, http, meta, java: '/j', runner: recordingRunner(calls) })).rejects.toMatchObject({ code: 'EINSTALL_UNVERIFIED' })
    expect(server.hits(neo.installerPath)).toBe(0)
    expect(calls).toEqual([])
  })

  it('replaces a tampered local installer before running anything', async () => {
    const neo = await publishNeoForge()
    await installVanilla121()
    const local = join(root, 'libraries/net/neoforged/neoforge/21.1.999/neoforge-21.1.999-installer.jar')
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, await buildZip({ 'install_profile.json': '{"evil":true}' }))
    await installNeoForge(neo.version, { root, http, meta, java: '/j', runner: recordingRunner([]) })
    expect(await readFile(local)).toEqual(neo.installer)
  })
})

describe('Forge', () => {
  it('installs a legacy (versionInfo) installer, accepting any listed checksum', async () => {
    const av = '1.7.10-10.13.4.1614-1.7.10'
    const universal = await buildZip({ 'cpw/mods/fml/Loader.class': 'fml' })
    const scala = await buildZip({ 'scala/Predef.class': 's' })
    server.file('/forge/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar', scala)
    const wrapper = await publishLibrary('forge', 'net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar', await buildZip({ 'L.class': 'l' }))
    const profile = {
      install: { profileName: 'Forge', target: `1.7.10-Forge10.13.4.1614-1.7.10`, path: `net.minecraftforge:forge:${av}`, filePath: `forge-${av}-universal.jar`, minecraft: '1.7.10' },
      versionInfo: {
        id: '1.7.10-Forge10.13.4.1614-1.7.10',
        type: 'release',
        minecraftArguments: '--username ${auth_player_name} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker',
        mainClass: 'net.minecraft.launchwrapper.Launch',
        inheritsFrom: '1.7.10',
        jar: '1.7.10',
        libraries: [
          { name: `net.minecraftforge:forge:${av}`, url: `${server.url}/forge/` },
          { name: 'net.minecraft:launchwrapper:1.12', url: `${server.url}/forge/`, checksums: [wrapper.sha1] },
          { name: 'org.scala-lang:scala-library:2.11.1', url: `${server.url}/forge/`, checksums: ['0'.repeat(40), sha1(scala)], serverreq: true, clientreq: true },
        ],
      },
    }
    const installer = await buildZip({ 'install_profile.json': JSON.stringify(profile), [`forge-${av}-universal.jar`]: universal })
    server.file('/forge/net/minecraftforge/forge/maven-metadata.xml', mavenMetadata('net.minecraftforge', 'forge', [av, '1.7.10-10.13.4.1558-1.7.10']))
    server.file('/forge-files/promotions_slim.json', { promos: { '1.7.10-latest': '10.13.4.1614' } })
    server.file(`/forge-files/${av}/meta.json`, { classifiers: { installer: { jar: md5(installer) }, universal: { jar: md5(universal) } } })
    server.file(`/forge/net/minecraftforge/forge/${av}/forge-${av}-installer.jar`, installer)
    server.file(`/forge/net/minecraftforge/forge/${av}/forge-${av}-installer.jar.sha1`, sha1(installer))

    const r = await installForge('1.7.10', '10.13.4.1614', { root, http, meta })
    expect(r).toEqual({ versionId: '1.7.10-Forge10.13.4.1614-1.7.10', minecraft: '1.7.10', format: 'legacy' })
    expect(await readFile(join(root, `libraries/net/minecraftforge/forge/${av}/forge-${av}.jar`))).toEqual(universal)
    expect(await readFile(join(root, 'libraries/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar'))).toEqual(scala)
    const json = JSON.parse(await readFile(join(root, 'versions', r.versionId, `${r.versionId}.json`), 'utf8'))
    expect(json).toMatchObject({ id: r.versionId, inheritsFrom: '1.7.10', mainClass: 'net.minecraft.launchwrapper.Launch' })
    // The Forge jar comes from the installer: it is never requested from the maven.
    expect(server.hits(`/forge/net/minecraftforge/forge/${av}/forge-${av}.jar`)).toBe(0)
  })

  it('merges a universal zip into the vanilla jar for pre-installer builds (md5 fallback)', async () => {
    const av = '1.4.7-6.6.2.534'
    const universal = await buildZip({ 'net/minecraft/client/Minecraft.class': 'forge-patched', 'forge/Forge.class': 'f', 'META-INF/FORGE.SF': 'sig' })
    server.file('/forge/net/minecraftforge/forge/maven-metadata.xml', mavenMetadata('net.minecraftforge', 'forge', [av]))
    server.file('/forge-files/promotions_slim.json', { promos: {} })
    server.file(`/forge-files/${av}/meta.json`, { classifiers: { universal: { zip: md5(universal) }, src: { zip: 'x' } } })
    server.file(`/forge/net/minecraftforge/forge/${av}/forge-${av}-universal.zip`, universal)
    const vanillaJar = join(root, 'versions/1.4.7/1.4.7.jar')
    await mkdir(dirname(vanillaJar), { recursive: true })
    await writeFile(vanillaJar, await buildZip({ 'net/minecraft/client/Minecraft.class': 'vanilla', 'a.class': 'a', 'META-INF/MOJANG_C.SF': 'sig' }))
    // The FML runtime libraries are pinned to real artifacts; pretend they are already installed.
    for (const l of LEGACY_FML_LIBRARIES) {
      const [g, a, v] = l.name.split(':') as [string, string, string]
      const p = join(root, 'libraries', g.replaceAll('.', '/'), a, v, `${a}-${v}.jar`)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, 'placeholder')
    }
    const r = await installForge('1.4.7', '6.6.2.534', { root, http, meta, trustedBefore: Date.now() + 60_000 })
    expect(r).toEqual({ versionId: '1.4.7-forge-6.6.2.534', minecraft: '1.4.7', format: 'universal' })
    const merged = await openZip(join(root, `libraries/net/minecraftforge/forge/${av}/forge-${av}.jar`))
    const names = (await merged.entries()).map((e) => e.name).toSorted()
    expect(names).toEqual(['a.class', 'forge/Forge.class', 'net/minecraft/client/Minecraft.class'])
    expect(await merged.readText('net/minecraft/client/Minecraft.class')).toBe('forge-patched')
    await merged.close()
    const json = JSON.parse(await readFile(join(root, 'versions', r.versionId, `${r.versionId}.json`), 'utf8'))
    expect(json).toMatchObject({ inheritsFrom: '1.4.7', mainClass: 'net.minecraft.launchwrapper.Launch' })
    expect(json.libraries.map((l: { name: string }) => l.name)).toEqual([`net.minecraftforge:forge:${av}`, ...LEGACY_FML_LIBRARIES.map((l) => l.name)])
  })

  it('rejects a universal zip whose md5 does not match', async () => {
    const av = '1.4.7-6.6.2.534'
    server.file('/forge/net/minecraftforge/forge/maven-metadata.xml', mavenMetadata('net.minecraftforge', 'forge', [av]))
    server.file('/forge-files/promotions_slim.json', { promos: {} })
    server.file(`/forge-files/${av}/meta.json`, { classifiers: { universal: { zip: '0'.repeat(32) } } })
    server.file(`/forge/net/minecraftforge/forge/${av}/forge-${av}-universal.zip`, await buildZip({ 'x.class': 'x' }))
    const vanillaJar = join(root, 'versions/1.4.7/1.4.7.jar')
    await mkdir(dirname(vanillaJar), { recursive: true })
    await writeFile(vanillaJar, await buildZip({ 'a.class': 'a' }))
    await expect(installForge('1.4.7', '6.6.2.534', { root, http, meta })).rejects.toMatchObject({ code: 'EINSTALL_CHECKSUM' })
    expect(await exists(join(root, `libraries/net/minecraftforge/forge/${av}/forge-${av}-universal.zip`))).toBe(false)
  })

  it('reports unknown builds', async () => {
    server.file('/forge/net/minecraftforge/forge/maven-metadata.xml', mavenMetadata('net.minecraftforge', 'forge', ['1.20.1-47.3.0']))
    server.file('/forge-files/promotions_slim.json', { promos: {} })
    await expect(installForge('1.20.1', '47.9.9', { root, http, meta })).rejects.toMatchObject({ code: 'EINSTALL_NOT_FOUND' })
  })
})
