import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_VERSIONS, tempDir } from './__fixtures__/helpers'
import { GameError } from './errors'
import { compareVersions, libraryKey, mavenPath, parseMavenName, pathToMaven } from './maven'
import { resolveLibraries } from './libraries'
import { LEGACY_JVM_ARGUMENTS, resolveVersion } from './resolve'
import type { Platform } from './rules'

const arm64: Platform = { name: 'osx', version: '14.4', arch: 'arm64' }
const names = (v: Parameters<typeof resolveLibraries>[0], p = arm64) => resolveLibraries(v, p).libraries.map((l) => l.name)

describe('maven helpers', () => {
  it('maps coordinates to paths and back', () => {
    expect(mavenPath('org.lwjgl:lwjgl:3.3.1:natives-macos-arm64')).toBe('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-macos-arm64.jar')
    expect(mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip')).toBe('de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip')
    expect(mavenPath('net.minecraftforge:forge:1.12.2-14.23.5.2859')).toBe('net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859.jar')
    expect(pathToMaven('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-macos-arm64.jar')).toEqual({
      group: 'org.lwjgl',
      artifact: 'lwjgl',
      version: '3.3.1',
      classifier: 'natives-macos-arm64',
      extension: 'jar',
    })
    expect(pathToMaven('com/google/guava/guava/32.1.2-jre/guava-32.1.2-jre.jar')).toMatchObject({ group: 'com.google.guava', version: '32.1.2-jre' })
    expect(pathToMaven('a/b/c.jar')).toBeUndefined()
  })

  it('rejects coordinates that would escape the library directory', () => {
    expect(() => parseMavenName('org.evil:..:1')).toThrow(TypeError)
    expect(() => parseMavenName('org.evil:x:../../etc')).toThrow(TypeError)
    expect(() => parseMavenName('only:two')).toThrow(TypeError)
  })

  it('keys libraries without the version', () => {
    expect(libraryKey(parseMavenName('org.ow2.asm:asm:9.8'))).toBe('org.ow2.asm:asm')
    expect(libraryKey(parseMavenName('org.lwjgl:lwjgl:3.3.1:natives-macos'))).toBe('org.lwjgl:lwjgl:natives-macos')
  })

  it('compares library versions', () => {
    expect(compareVersions('3.2.1', '3.3.0')).toBeLessThan(0)
    expect(compareVersions('3.3.0-SNAPSHOT', '3.3.0')).toBeLessThan(0)
    expect(compareVersions('3.3.1', '3.3.0')).toBeGreaterThan(0)
    expect(compareVersions('2.9.2-nightly-20140822', '2.9.2')).toBeLessThan(0)
    expect(compareVersions('5.10.0', '5.7.0')).toBeGreaterThan(0)
  })
})

describe('resolveVersion', () => {
  it('resolves a vanilla modern version', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    expect(v).toMatchObject({ id: '1.21', minecraftVersion: '1.21', inheritances: ['1.21'], assets: '17', mainClass: 'net.minecraft.client.main.Main', legacyArguments: false })
    expect(v.javaVersion).toEqual({ component: 'java-runtime-delta', majorVersion: 21 })
    expect(v.logging?.client?.file.id).toBe('client-1.12.xml')
    expect(v.pathChain).toEqual([path.join(FIXTURE_VERSIONS, '1.21')])
  })

  it('turns legacy minecraftArguments into argument lists', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10')
    expect(v.legacyArguments).toBe(true)
    expect(v.arguments.jvm).toEqual(LEGACY_JVM_ARGUMENTS)
    expect(v.arguments.game.slice(0, 4)).toEqual(['--username', '${auth_player_name}', '--version', '${version_name}'])
  })

  it('merges Fabric over vanilla 1.21', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, 'fabric-loader-0.16.14-1.21')
    expect(v.inheritances).toEqual(['fabric-loader-0.16.14-1.21', '1.21'])
    expect(v.minecraftVersion).toBe('1.21')
    expect(v.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(v.assets).toBe('17')
    expect(v.javaVersion.majorVersion).toBe(21)
    // JVM arguments are appended: vanilla first, then Fabric's.
    expect(v.arguments.jvm.at(-1)).toBe('-DFabricMcEmu= net.minecraft.client.main.Main ')
    expect(v.arguments.jvm[0]).toMatchObject({ value: ['-XstartOnFirstThread'] })
    const libs = resolveLibraries(v, arm64).libraries
    // Vanilla libraries keep their positions, Fabric-only ones follow.
    expect(libs[0]?.name).toBe('ca.weblite:java-objc-bridge:1.1')
    const asm = libs.find((l) => l.name === 'org.ow2.asm:asm:9.8')
    expect(asm?.download).toEqual({
      path: 'org/ow2/asm/asm/9.8/asm-9.8.jar',
      url: 'https://maven.fabricmc.net/org/ow2/asm/asm/9.8/asm-9.8.jar',
      sha1: 'dc19ecb3f7889b7860697215cae99c0f9b6f6b4b',
      sha256: '876eab6a83daecad5ca67eb9fcabb063c97b5aeb8cf1fca7a989ecde17522051',
      size: 126113,
    })
    expect(libs.findIndex((l) => l.name.startsWith('net.fabricmc:fabric-loader'))).toBeGreaterThan(libs.findIndex((l) => l.name.startsWith('org.lwjgl:lwjgl:')))
  })

  it('merges Forge 1.20.1 over vanilla, honouring the empty logging override', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.20.1-forge-47.4.28')
    expect(v.minecraftVersion).toBe('1.20.1')
    expect(v.mainClass).toBe('cpw.mods.bootstraplauncher.BootstrapLauncher')
    expect(v.logging).toEqual({})
    expect(v.downloads.client?.sha1).toBeTruthy()
    expect(v.arguments.game.slice(-10, -8)).toEqual(['--launchTarget', 'forgeclient'])
    expect(v.arguments.jvm.some((a) => typeof a === 'string' && a.includes('-DignoreList=') && a.includes('${version_name}.jar'))).toBe(true)
  })

  it('merges NeoForge over vanilla 1.21.1, with the child winning duplicate libraries', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, 'neoforge-21.1.264')
    expect(v.inheritances).toEqual(['neoforge-21.1.264', '1.21.1'])
    expect(v.logging?.client?.file.id).toBe('client-1.12.xml')
    const libs = resolveLibraries(v, arm64).libraries
    const guava = libs.filter((l) => l.coordinate.artifact === 'guava')
    expect(guava).toHaveLength(1)
    expect(guava[0]?.source).toBe('neoforge-21.1.264')
    expect(v.arguments.game).toContain('--fml.neoForgeVersion')
  })

  it('lets a legacy Forge child replace arguments and override library versions', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.12.2-forge-14.23.5.2859')
    expect(v.mainClass).toBe('net.minecraft.launchwrapper.Launch')
    expect(v.arguments.game).toContain('--tweakClass')
    expect(v.arguments.game.filter((a) => a === '--username')).toHaveLength(1)
    expect(v.logging).toEqual({})
    const libs = resolveLibraries(v, arm64).libraries
    const core = libs.find((l) => l.coordinate.artifact === 'log4j-core')
    expect(core?.coordinate.version).toBe('2.15.0')
    // Position of the parent's entry, value of the child's.
    expect(libs.indexOf(core as never)).toBeLessThan(libs.findIndex((l) => l.coordinate.artifact === 'forge'))
    const forge = libs.find((l) => l.coordinate.artifact === 'forge')
    expect(forge?.download.url).toBe('')
  })

  it('handles the 1.7.10 Forge versionInfo shape (maven-only libraries with checksums)', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10-Forge10.13.4.1614-1.7.10')
    expect(v.minecraftVersion).toBe('1.7.10')
    expect(v.assets).toBe('1.7.10')
    const libs = resolveLibraries(v, arm64).libraries
    const akka = libs.find((l) => l.coordinate.artifact === 'akka-actor_2.11')
    expect(akka?.download).toMatchObject({
      url: 'https://maven.minecraftforge.net/com/typesafe/akka/akka-actor_2.11/2.3.3/akka-actor_2.11-2.3.3.jar',
      sha1: 'ed62e9fc709ca0f2ff1a3220daa8b70a2870078e',
      sha1Alternatives: ['25a86ccfdb6f6dfe08971f4825d0a01be83a6f2e'],
    })
    expect(libs.find((l) => l.coordinate.artifact === 'launchwrapper')?.download.url).toBe('https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar')
  })

  it('lists old-style natives after classpath libraries and resolves their classifiers', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10')
    const libs = resolveLibraries(v, arm64).libraries
    const firstNative = libs.findIndex((l) => l.isNative)
    expect(libs.slice(firstNative).every((l) => l.isNative)).toBe(true)
    expect(libs.slice(firstNative).map((l) => l.name)).toEqual([
      'org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx',
      'net.java.jinput:jinput-platform:2.0.5:natives-osx',
      'tv.twitch:twitch-platform:5.16:natives-osx',
    ])
    expect(libs[firstNative]?.extractExclude).toEqual(['META-INF/'])
    // twitch-external-platform has no osx classifier.
    expect(names(v)).not.toContain('tv.twitch:twitch-external-platform:4.5:natives-osx')
  })

  describe('errors', () => {
    let root: string
    let cleanup: () => Promise<void>
    beforeEach(async () => ({ dir: root, cleanup } = await tempDir()))
    afterEach(() => cleanup())

    const put = async (id: string, json: unknown) => {
      await mkdir(path.join(root, id), { recursive: true })
      await writeFile(path.join(root, id, `${id}.json`), typeof json === 'string' ? json : JSON.stringify(json))
    }

    it('reports the missing parent id', async () => {
      await put('child', { id: 'child', inheritsFrom: 'parent', mainClass: 'x' })
      const e = await resolveVersion(root, 'child').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(GameError)
      expect(e).toMatchObject({ code: 'EVERSION_MISSING', details: { version: 'parent', requestedBy: 'child' } })
    })

    it('detects cycles', async () => {
      await put('a', { id: 'a', inheritsFrom: 'b', mainClass: 'x' })
      await put('b', { id: 'b', inheritsFrom: 'a' })
      await expect(resolveVersion(root, 'a')).rejects.toMatchObject({ code: 'EVERSION_CYCLE', details: { chain: ['a', 'b', 'a'] } })
    })

    it('rejects corrupt JSON, bad shapes, missing mainClass and unsafe ids', async () => {
      await put('corrupt', '{ nope')
      await expect(resolveVersion(root, 'corrupt')).rejects.toMatchObject({ code: 'EVERSION_CORRUPT' })
      await put('bad', { id: 'bad', libraries: [{ name: 5 }] })
      await expect(resolveVersion(root, 'bad')).rejects.toMatchObject({ code: 'EVERSION_INVALID', details: { field: 'libraries[0].name' } })
      await put('nomain', { id: 'nomain' })
      await expect(resolveVersion(root, 'nomain')).rejects.toMatchObject({ code: 'EVERSION_INVALID', details: { missing: 'mainClass' } })
      await put('escape', { id: 'escape', inheritsFrom: '../escape', mainClass: 'x' })
      await expect(resolveVersion(root, 'escape')).rejects.toMatchObject({ code: 'EVERSION_INVALID' })
    })

    it('drops malformed libraries with a warning instead of failing', async () => {
      await put('w', { id: 'w', mainClass: 'x', libraries: [{ name: 'a:b:1', downloads: { classifiers: {} } }, { name: 'c:d:2' }] })
      const v = await resolveVersion(root, 'w')
      const r = resolveLibraries(v, arm64)
      expect(r.libraries.map((l) => l.name)).toEqual(['c:d:2'])
      expect(r.warnings[0]).toContain('a:b:1')
    })
  })
})
