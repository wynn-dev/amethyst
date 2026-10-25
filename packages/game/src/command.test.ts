/* oxlint-disable no-await-in-loop -- fixtures are written sequentially */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_ASSETS, FIXTURE_VERSIONS, TEST_GLFW_SOURCE, TEST_LWJGL2_SOURCE, tempDir } from './__fixtures__/helpers'
import { parseArgs, redactArgs, redactCommand } from './argv'
import { autoMemory, buildLaunchCommand, expandArguments, isLog4ShellAffected, sanitizeEnv, substitute, type BuildLaunchOptions } from './command'
import { resolveVersion } from './resolve'
import type { Platform } from './rules'

let root: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ dir: root, cleanup } = await tempDir())
  await mkdir(path.join(root, 'assets', 'log_configs'), { recursive: true })
  for (const f of ['client-1.7.xml', 'client-1.12.xml']) await writeFile(path.join(root, 'assets', 'log_configs', f), '<Configuration/>')
})
afterEach(() => cleanup())

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-token'
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5'

const base = (over: Partial<BuildLaunchOptions> = {}): BuildLaunchOptions => ({
  java: { path: '/jvm/bin/java', arch: 'arm64' },
  dirs: root,
  gameDir: path.join(root, 'instances', 'test'),
  auth: { username: 'Steve', uuid: UUID, accessToken: TOKEN, userType: 'msa', xuid: '2535400000000000', clientId: 'client-abc' },
  lwjgl2: TEST_LWJGL2_SOURCE,
  glfw: TEST_GLFW_SOURCE,
  launcherVersion: '1.2.3',
  baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/steve', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: '/x.dylib', JAVA_TOOL_OPTIONS: '-Dx=y' },
  ...over,
})

/** Replace the temp root so golden lists are stable. */
const norm = (args: readonly string[]) => args.map((a) => a.replaceAll(root, '<root>'))

describe('buildLaunchCommand', () => {
  it('builds the legacy 1.7.10 command (golden)', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10')
    const cmd = await buildLaunchCommand(
      v,
      base({
        memory: { minMB: 1024, maxMB: 4096 },
        jvmArgs: '-XX:+UseG1GC -Dfoo="a b"',
        quickPlay: { type: 'multiplayer', host: 'example.org', port: 25566 },
        resolution: { width: 854, height: 480 },
      }),
    )
    const cp = cmd.classpath.map((c) => c.replaceAll(root, '<root>'))
    expect(cp).toEqual([
      '<root>/libraries/com/mojang/netty/1.8.8/netty-1.8.8.jar',
      '<root>/libraries/com/mojang/realms/1.3.5/realms-1.3.5.jar',
      '<root>/libraries/org/apache/commons/commons-compress/1.8.1/commons-compress-1.8.1.jar',
      '<root>/libraries/net/sf/jopt-simple/jopt-simple/4.5/jopt-simple-4.5.jar',
      '<root>/libraries/com/paulscode/librarylwjglopenal/20100824/librarylwjglopenal-20100824.jar',
      '<root>/libraries/com/google/guava/guava/15.0/guava-15.0.jar',
      '<root>/libraries/org/apache/commons/commons-lang3/3.1/commons-lang3-3.1.jar',
      '<root>/libraries/net/java/jinput/jinput/2.0.5/jinput-2.0.5.jar',
      '<root>/libraries/net/java/jutils/jutils/1.0.0/jutils-1.0.0.jar',
      '<root>/libraries/org/apache/logging/log4j/log4j-api/2.0-beta9/log4j-api-2.0-beta9.jar',
      '<root>/libraries/org/apache/logging/log4j/log4j-core/2.0-beta9/log4j-core-2.0-beta9.jar',
      '<root>/libraries/org/lwjgl/lwjgl/lwjgl/2.9.1/lwjgl-2.9.1.jar',
      '<root>/libraries/org/lwjgl/lwjgl/lwjgl_util/2.9.1/lwjgl_util-2.9.1.jar',
      '<root>/libraries/tv/twitch/twitch/5.16/twitch-5.16.jar',
      '<root>/versions/1.7.10/1.7.10.jar',
    ])
    const natives = '<root>/versions/1.7.10/1.7.10-natives-arm64'
    expect(norm(cmd.args)).toEqual([
      '-Xdock:name=Minecraft',
      '-Xms1024M',
      '-Xmx4096M',
      `-Djava.library.path=${natives}`,
      '-Dminecraft.launcher.brand=amethyst',
      '-Dminecraft.launcher.version=1.2.3',
      '-cp',
      cp.join(':'),
      '-Dlog4j.configurationFile=<root>/assets/log_configs/client-1.7.xml',
      '-DlibraryDirectory=<root>/libraries',
      '-XX:+UseG1GC',
      '-Dfoo=a b',
      'net.minecraft.client.main.Main',
      '--username',
      'Steve',
      '--version',
      '1.7.10',
      '--gameDir',
      '<root>/instances/test',
      '--assetsDir',
      '<root>/assets',
      '--assetIndex',
      '1.7.10',
      '--uuid',
      '069a79f444e94726a5befca90e38aaf5',
      '--accessToken',
      TOKEN,
      '--userProperties',
      '{}',
      '--userType',
      'msa',
      '--server',
      'example.org',
      '--port',
      '25566',
      '--width',
      '854',
      '--height',
      '480',
    ])
    expect(cmd.args).not.toContain('-XstartOnFirstThread')
    expect(cmd.java).toBe('/jvm/bin/java')
    expect(cmd.cwd).toBe(path.join(root, 'instances', 'test'))
    expect(cmd.natives.extract.map((l) => l.name)).toEqual(['dev.wynn.amethyst.natives:lwjgl-platform:2.9.1:natives-macos-arm64'])
  })

  it('builds the modern 1.21 command (golden) with features, quick play and the dock icon', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    await mkdir(path.join(root, 'assets', 'indexes'), { recursive: true })
    await copyFile(path.join(FIXTURE_ASSETS, '17.json'), path.join(root, 'assets', 'indexes', '17.json'))
    const icon = path.join(root, 'assets', 'objects', 'f0', 'f00657542252858a721e715a2e888a9226404e35')
    await mkdir(path.dirname(icon), { recursive: true })
    await writeFile(icon, 'icns')

    const cmd = await buildLaunchCommand(
      v,
      base({
        memory: { maxMB: 6144 },
        jvmArgs: [],
        gameArgs: ['--custom'],
        quickPlay: { type: 'multiplayer', host: 'mc.example.org' },
        quickPlayPath: 'quickPlay/log.json',
        resolution: { width: 1280, height: 720 },
      }),
    )
    const natives = '<root>/versions/1.21/1.21-natives-arm64'
    const args = norm(cmd.args)
    const cpIndex = args.indexOf('-cp') + 1
    expect(args[cpIndex]?.endsWith('<root>/versions/1.21/1.21.jar')).toBe(true)
    args[cpIndex] = '<classpath>'
    expect(args).toEqual([
      '-Xdock:name=Minecraft',
      '-Xdock:icon=<root>/assets/objects/f0/f00657542252858a721e715a2e888a9226404e35',
      '-Xmx6144M',
      '-XstartOnFirstThread',
      `-Djava.library.path=${natives}`,
      `-Djna.tmpdir=${natives}`,
      `-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives}`,
      `-Dio.netty.native.workdir=${natives}`,
      '-Dminecraft.launcher.brand=amethyst',
      '-Dminecraft.launcher.version=1.2.3',
      '-cp',
      '<classpath>',
      '-Dlog4j.configurationFile=<root>/assets/log_configs/client-1.12.xml',
      '-DlibraryDirectory=<root>/libraries',
      'net.minecraft.client.main.Main',
      '--username',
      'Steve',
      '--version',
      '1.21',
      '--gameDir',
      '<root>/instances/test',
      '--assetsDir',
      '<root>/assets',
      '--assetIndex',
      '17',
      '--uuid',
      '069a79f444e94726a5befca90e38aaf5',
      '--accessToken',
      TOKEN,
      '--clientId',
      'client-abc',
      '--xuid',
      '2535400000000000',
      '--userType',
      'msa',
      '--versionType',
      'release',
      '--width',
      '1280',
      '--height',
      '720',
      '--quickPlayPath',
      'quickPlay/log.json',
      '--quickPlayMultiplayer',
      'mc.example.org:25565',
      '--custom',
    ])
    expect(cmd.features).toEqual({ has_custom_resolution: true, is_quick_play_multiplayer: true, has_quick_plays_support: true })
    expect(args).not.toContain('--server')
    // The 1.21 classpath has both macOS natives jars and no windows/linux ones.
    expect(cmd.classpath.some((c) => c.endsWith('lwjgl-3.3.3-natives-macos-arm64.jar'))).toBe(true)
    expect(cmd.classpath.some((c) => c.includes('natives-windows') || c.includes('natives-linux'))).toBe(false)
  })

  it('drops empty optional variables together with their flag', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    const cmd = await buildLaunchCommand(v, base({ auth: { username: 'Alex', uuid: UUID, userType: 'legacy' } }))
    expect(cmd.args).not.toContain('--clientId')
    expect(cmd.args).not.toContain('--xuid')
    expect(cmd.args.some((a) => a.includes('${'))).toBe(false)
    expect(cmd.args[cmd.args.indexOf('--userType') + 1]).toBe('legacy')
    // Offline accounts get a random token.
    expect(cmd.args[cmd.args.indexOf('--accessToken') + 1]).toMatch(/^[0-9a-f]{32}$/)
  })

  it('uses token:<t>:<uuid> sessions for pre-1.7 online play and builds game_assets', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.6.4')
    const cmd = await buildLaunchCommand(v, base())
    expect(norm(cmd.args).slice(-10)).toEqual([
      '--username',
      'Steve',
      '--session',
      `token:${TOKEN}:069a79f444e94726a5befca90e38aaf5`,
      '--version',
      '1.6.4',
      '--gameDir',
      '<root>/instances/test',
      '--assetsDir',
      '<root>/assets/virtual/legacy',
    ])
    // 1.6.4 declares no log4j config and predates log4j 2.
    expect(cmd.args).not.toContain('-Dlog4j2.formatMsgNoLookups=true')
  })

  it('applies the Log4Shell fallback when Forge disables the vanilla config', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.12.2-forge-14.23.5.2859')
    const cmd = await buildLaunchCommand(v, base())
    expect(cmd.args).toContain('-Dlog4j2.formatMsgNoLookups=true')
    expect(cmd.args.some((a) => a.startsWith('-Dlog4j.configurationFile'))).toBe(false)
    expect(cmd.args).toContain('net.minecraft.launchwrapper.Launch')
    expect(cmd.args.slice(cmd.args.indexOf('--tweakClass'), cmd.args.indexOf('--tweakClass') + 2)).toEqual(['--tweakClass', 'net.minecraftforge.fml.common.launcher.FMLTweaker'])
    expect(cmd.classpath.at(-1)).toBe(path.join(root, 'versions', '1.12.2', '1.12.2.jar'))
  })

  it('keeps Forge 1.17+ ${version_name}.jar consistent with the jar on the classpath', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.20.1-forge-47.4.28')
    const cmd = await buildLaunchCommand(v, base())
    const ignore = cmd.args.find((a) => a.startsWith('-DignoreList='))
    expect(ignore?.endsWith(',1.20.1.jar')).toBe(true)
    expect(cmd.args.filter((a) => a.startsWith('-DlibraryDirectory'))).toEqual([`-DlibraryDirectory=${path.join(root, 'libraries')}`])
    const p = cmd.args[cmd.args.indexOf('-p') + 1]
    expect(p?.startsWith(`${path.join(root, 'libraries')}/cpw/mods/bootstraplauncher/1.1.2/`)).toBe(true)
    expect(p).toContain(':')
    expect(cmd.args[cmd.args.indexOf('--version') + 1]).toBe('1.20.1-forge-47.4.28')
  })

  it('uses 26.x default-user-jvm only when the user configured no JVM arguments', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '26.3')
    await writeFile(path.join(root, 'assets', 'log_configs', 'client-1.21.2.xml'), '<Configuration/>')
    const defaults = await buildLaunchCommand(v, base({ memory: { maxMB: 8192 } }))
    expect(defaults.args).toContain('-XX:+UseZGC')
    expect(defaults.args).toContain('-XX:+UseCompactObjectHeaders')
    expect(defaults.args).not.toContain('-Xmx4G')
    expect(defaults.args).not.toContain('-XX:+UseG1GC')
    expect(defaults.args).toContain(`-Djava.library.path=${defaults.nativesDir}/java`)
    const none = await buildLaunchCommand(v, base({ jvmArgs: [] }))
    expect(none.args).not.toContain('-XX:+UseZGC')
  })

  it('handles demo, fullscreen and quick play on versions without the JSON features', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.12.2')
    const cmd = await buildLaunchCommand(v, base({ demo: true, resolution: { fullscreen: true }, quickPlay: { type: 'singleplayer', world: 'New World' } }))
    expect(cmd.args.slice(-2)).toEqual(['--fullscreen', '--demo'])
    expect(cmd.warnings.some((w) => w.includes('quick play'))).toBe(true)
    const modern = await buildLaunchCommand(await resolveVersion(FIXTURE_VERSIONS, '1.21'), base({ demo: true }))
    expect(modern.args.filter((a) => a === '--demo')).toHaveLength(1)
  })

  it('fails clearly for unavailable natives, missing log configs and bad memory', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.7.10')
    await expect(buildLaunchCommand(v, base({ lwjgl2: { baseUrl: 'https://x/', artifacts: [] } }))).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
    const v116 = await resolveVersion(FIXTURE_VERSIONS, '1.16.5')
    await expect(buildLaunchCommand(v116, base({ glfw: { baseUrl: 'https://x/', artifacts: [] } }))).rejects.toMatchObject({ code: 'ENATIVES_UNAVAILABLE' })
    const modern = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    await expect(buildLaunchCommand(modern, base({ dirs: { root, assets: path.join(root, 'empty-assets') } }))).rejects.toMatchObject({ code: 'ELOG_CONFIG_MISSING' })
    await expect(buildLaunchCommand(modern, base({ memory: { maxMB: -1 } }))).rejects.toMatchObject({ code: 'ELAUNCH_OPTIONS' })
    const clamped = await buildLaunchCommand(modern, base({ memory: { minMB: 8192, maxMB: 4096 } }))
    expect(clamped.args).toContain('-Xms4096M')
  })

  it('1.16.5 on arm64: LWJGL 3.3.1 with the patched GLFW jar on the classpath instead of the official natives', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.16.5')
    const cmd = await buildLaunchCommand(v, base())
    const libs = path.join(root, 'libraries')
    expect(cmd.classpath).toContain(path.join(libs, 'dev/wynn/amethyst/natives/lwjgl-glfw-patched/3.3.1/lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar'))
    expect(cmd.classpath).toContain(path.join(libs, 'org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1.jar'))
    expect(cmd.classpath.some((c) => c.endsWith('lwjgl-glfw-3.3.1-natives-macos-arm64.jar'))).toBe(false)
    expect(cmd.natives.extract).toEqual([])
    expect(cmd.args.includes('-XstartOnFirstThread')).toBe(true)
  })

  it('evaluates rules with an x64 JVM and keeps the x86_64 natives (Rosetta)', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.16.5')
    const cmd = await buildLaunchCommand(v, base({ java: { path: '/x64/java', arch: 'x86_64' } }))
    expect(cmd.nativesDir).toBe(path.join(root, 'versions', '1.16.5', '1.16.5-natives-x64'))
    expect(cmd.classpath.some((c) => c.endsWith('lwjgl-3.2.1.jar'))).toBe(true)
    expect(cmd.natives.extract.length).toBeGreaterThan(0)
  })

  it('sanitises the environment and supports wrappers without a shell', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.21')
    const cmd = await buildLaunchCommand(v, base({ env: { JAVA_TOOL_OPTIONS: '-Duser=1', FOO: 'bar' }, wrapper: '/usr/bin/caffeinate -i' }))
    expect(cmd.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/steve', JAVA_TOOL_OPTIONS: '-Duser=1', FOO: 'bar' })
    expect(cmd.warnings).toContain('Environment sets JAVA_TOOL_OPTIONS=-Duser=1')
    expect(cmd.wrapper).toEqual(['/usr/bin/caffeinate', '-i'])
  })

  it('redacts tokens by position and by value', async () => {
    const v = await resolveVersion(FIXTURE_VERSIONS, '1.6.4')
    const cmd = await buildLaunchCommand(v, base({ wrapper: ['caffeinate', '-i'] }))
    const printed = redactCommand(cmd)
    expect(printed).not.toContain(TOKEN)
    expect(printed.startsWith('caffeinate -i /jvm/bin/java ')).toBe(true)
    expect(printed).toContain('--session <redacted>')
    expect(redactArgs(['--accessToken', 'abc', '-Dx=abcdef'], ['abcdef'])).toEqual(['--accessToken', '<redacted>', '-Dx=<redacted>'])
  })
})

describe('templating', () => {
  const p: Platform = { name: 'osx', version: '14.4', arch: 'arm64' }
  it('substitutes several placeholders per argument and leaves unknown ones', () => {
    const warnings: string[] = []
    expect(substitute('${a}-${library_directory}/x${classpath_separator}y', { library_directory: '/L', classpath_separator: ':' }, warnings)).toBe('${a}-/L/x:y')
    expect(warnings[0]).toContain('Unknown variable ${a}')
  })
  it('drops flag/value pairs for empty known variables', () => {
    expect(expandArguments(['--a', '${clientid}', '--b', 'x', '${auth_xuid}'], p, {}, {})).toEqual(['--b', 'x'])
  })
})

describe('argument parsing', () => {
  it('splits shell-style', () => {
    expect(parseArgs(`-Xss2M  -Dfoo="a b" -Dbar='c "d"' e\\ f "g\\"h" ''`)).toEqual(['-Xss2M', '-Dfoo=a b', '-Dbar=c "d"', 'e f', 'g"h', ''])
    expect(parseArgs('')).toEqual([])
    expect(() => parseArgs('"open')).toThrow(SyntaxError)
  })
})

describe('helpers', () => {
  it('knows the Log4Shell range', () => {
    expect(isLog4ShellAffected({ minecraftVersion: '1.7.10' })).toBe(true)
    expect(isLog4ShellAffected({ minecraftVersion: '1.18' })).toBe(true)
    expect(isLog4ShellAffected({ minecraftVersion: '1.18.1' })).toBe(false)
    expect(isLog4ShellAffected({ minecraftVersion: '1.6.4' })).toBe(false)
    expect(isLog4ShellAffected({ minecraftVersion: '21w44a', releaseTime: '2021-11-03T12:00:00+00:00' })).toBe(true)
    expect(isLog4ShellAffected({ minecraftVersion: '26.3' })).toBe(false)
  })
  it('suggests memory', () => {
    expect(autoMemory(0, 16384)).toEqual({ minMB: 1024, maxMB: 2048 })
    expect(autoMemory(200, 16384)).toEqual({ minMB: 1024, maxMB: 6144 })
    expect(autoMemory(2000, 65536)).toEqual({ minMB: 1024, maxMB: 16384 })
  })
  it('sanitises env', () => {
    expect(sanitizeEnv({ A: '1', ELECTRON_X: '1', DYLD_LIBRARY_PATH: 'x', _JAVA_OPTIONS: 'y' })).toEqual({ A: '1' })
  })
})
