/* oxlint-disable no-await-in-loop -- test setup is sequential */
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildZip, fixtureJson, processorJar, sha1, tempDir } from './__fixtures__/helpers'
import {
  buildVariables,
  libraryPathOf,
  type ModernProfile,
  parseModernProfile,
  type Processor,
  type ProcessorInvocation,
  processorOutputs,
  type ProcessorRunner,
  readMainClass,
  runProcessors,
  spawnProcessor,
  substituteArgument,
  toolLibrarySpecs,
  type VariableContext,
} from './index'

let root: string
let libraryDir: string

beforeEach(async () => {
  root = await tempDir()
  libraryDir = join(root, 'libraries')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

function context(extra: Partial<VariableContext> = {}): VariableContext {
  return {
    side: 'client',
    root,
    libraryDir,
    minecraftJar: join(root, 'versions/1.21.1/1.21.1.jar'),
    minecraftVersion: '1.21.1',
    installer: join(libraryDir, 'net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar'),
    resolveInstallerPath: (entry) => join(root, 'extracted', entry),
    ...extra,
  }
}

describe('processor variables', () => {
  it('resolves every data value form and the built-ins', () => {
    const vars = buildVariables(
      {
        COORD: { client: '[net.neoforged:neoform:1.21.1-20240808.144430:mappings@txt]', server: '[x:y:1]' },
        LITERAL: { client: "'1.21.1-20240808.144430'", server: "'s'" },
        BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
        RAW: { client: 'plain-value', server: 'p' },
        SIDE: { client: 'not-the-side', server: 'x' },
      },
      context(),
    )
    expect(vars).toEqual({
      COORD: join(libraryDir, 'net/neoforged/neoform/1.21.1-20240808.144430/neoform-1.21.1-20240808.144430-mappings.txt'),
      LITERAL: '1.21.1-20240808.144430',
      BINPATCH: join(root, 'extracted', '/data/client.lzma'),
      RAW: 'plain-value',
      SIDE: 'client', // built-ins win over data
      MINECRAFT_JAR: join(root, 'versions/1.21.1/1.21.1.jar'),
      MINECRAFT_VERSION: '1.21.1',
      ROOT: root,
      INSTALLER: context().installer,
      LIBRARY_DIR: libraryDir,
    })
  })

  it('substitutes [coordinates], {variables} and escapes', () => {
    const vars = { ROOT: '/mc', LIT: 'abc' }
    expect(substituteArgument('[g.h:a:1.0:extra@zip]', vars, '/mc/libraries')).toBe('/mc/libraries/g/h/a/1.0/a-1.0-extra.zip')
    expect(substituteArgument('{ROOT}/run.sh', vars, '/l')).toBe('/mc/run.sh')
    expect(substituteArgument('--key={LIT}-{LIT}', vars, '/l')).toBe('--key=abc-abc')
    expect(substituteArgument('\\{ROOT\\}', vars, '/l')).toBe('{ROOT}')
    expect(substituteArgument('--plain', vars, '/l')).toBe('--plain')
  })

  it('rejects unknown variables and unsafe coordinates', () => {
    expect(() => substituteArgument('{MISSING}', {}, '/l')).toThrow(expect.objectContaining({ code: 'EINSTALL_UNKNOWN_VARIABLE' }))
    expect(() => substituteArgument('{ROOT', { ROOT: '/' }, '/l')).toThrow(expect.objectContaining({ code: 'EINSTALL_UNKNOWN_VARIABLE' }))
    expect(() => substituteArgument('[a:..:1]', {}, '/l')).toThrow(expect.objectContaining({ code: 'EINSTALL_BAD_METADATA' }))
  })

  it.each(['neoforge-21.1.209', 'forge-1.20.1-47.3.0', 'neoforge-26.3.0.97'])('substitutes every client processor of the real %s profile', (name) => {
    const profile = parseModernProfile(fixtureJson(`${name}.install_profile.json`))
    const vars = buildVariables(profile.data, context({ minecraftVersion: profile.minecraft }))
    for (const p of (profile.processors ?? []).filter((x) => !x.sides || x.sides.includes('client'))) {
      const args = (p.args ?? []).map((a) => substituteArgument(a, vars, libraryDir))
      expect(args.join(' ')).not.toMatch(/[{}[\]]/)
      processorOutputs(p, args, vars, libraryDir)
    }
  })

  it('derives outputs: declared hashes (quotes stripped), --output files, no directories, no tsrg hash', () => {
    const profile = parseModernProfile(fixtureJson('forge-1.20.1-47.3.0.install_profile.json'))
    const vars = buildVariables(profile.data, context({ minecraftVersion: '1.20.1' }))
    const outputsOf = (p: Processor) => processorOutputs(p, (p.args ?? []).map((a) => substituteArgument(a, vars, libraryDir)), vars, libraryDir)
    const procs = profile.processors ?? []
    const splitter = procs.find((p) => p.jar.includes('jarsplitter') && p.sides?.includes('client')) as Processor
    expect(outputsOf(splitter)).toEqual([
      { path: vars.MC_SLIM, sha1: 'de86b035d2da0f78940796bb95c39a932ed84834' },
      { path: vars.MC_EXTRA, sha1: '8c5a95cbce940cfdb304376ae9fea47968d02587' },
    ])
    const patcher = procs.find((p) => p.jar.includes('binarypatcher')) as Processor
    expect(outputsOf(patcher)).toEqual([{ path: vars.PATCHED, validator: 'zip' }])
    const bundlerLibs = procs.find((p) => p.args?.includes('--libraries')) as Processor
    expect(outputsOf(bundlerLibs)).toEqual([]) // extracts into a directory
    const tsrg = processorOutputs({ jar: 'a:b:1', outputs: { '{ROOT}/x/mappings.tsrg': "'abc'" } }, [], { ROOT: '/r' }, '/l')
    expect(tsrg).toEqual([{ path: '/r/x/mappings.tsrg' }])
  })
})

describe('toolLibrarySpecs', () => {
  it('keeps every version of an artifact that processors need side by side', () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- local test data builder
    const lib = (v: string) => ({ name: `net.minecraftforge:srgutils:${v}`, downloads: { artifact: { path: `net/minecraftforge/srgutils/${v}/srgutils-${v}.jar`, url: `https://m/${v}`, sha1: 'a'.repeat(40), size: 1 } } })
    const specs = toolLibrarySpecs(root, [lib('0.4.3'), lib('0.4.9'), lib('0.5.6'), lib('0.4.3')], { name: 'osx', version: '15.0', arch: 'arm64' })
    expect(specs.map((s) => s.name)).toEqual(['net.minecraftforge:srgutils:0.4.3', 'net.minecraftforge:srgutils:0.4.9', 'net.minecraftforge:srgutils:0.5.6'])
  })
})

describe('readMainClass', () => {
  it('reads Main-Class, including continuation lines', async () => {
    const jar = join(root, 'p.jar')
    await writeFile(jar, await buildZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nMain-Class: net.minecraftforge.binarypatcher.Consol\n eTool\nX: y\n' }))
    expect(await readMainClass(jar)).toBe('net.minecraftforge.binarypatcher.ConsoleTool')
  })

  it('reports bad jars and missing main classes', async () => {
    const none = join(root, 'none.jar')
    await writeFile(none, await buildZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' }))
    await expect(readMainClass(none)).rejects.toMatchObject({ code: 'EINSTALL_PROCESSOR_NO_MAIN_CLASS' })
    const broken = join(root, 'broken.jar')
    await writeFile(broken, 'not a zip')
    await expect(readMainClass(broken)).rejects.toMatchObject({ code: 'EINSTALL_PROCESSOR_BAD_JAR' })
  })
})

describe('runProcessors', () => {
  const PATCHED_CONTENT = 'patched-bytes'

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- kept next to the tests that use it
  async function setup() {
    for (const [coord, main] of [
      ['com.example:split:1.0', 'com.example.Split'],
      ['com.example:patch:1.0', 'com.example.Patch'],
      ['com.example:dep:1.0', 'com.example.Dep'],
      ['com.example:server:1.0', 'com.example.Server'],
    ] as const) {
      const path = libraryPathOf(coord, libraryDir)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, await processorJar(main))
    }
    const profile: ModernProfile = {
      version: 'test-1',
      minecraft: '1.21.1',
      data: {
        SLIM: { client: '[net.minecraft:client:1.21.1:slim]', server: '[net.minecraft:server:1.21.1:slim]' },
        SLIM_SHA: { client: `'${sha1('slim-bytes')}'`, server: "''" },
        PATCHED: { client: '[com.example:out:1.0:client]', server: '[com.example:out:1.0:server]' },
      },
      processors: [
        { sides: ['server'], jar: 'com.example:server:1.0', args: ['--task', 'SERVER_ONLY'] },
        { jar: 'com.example:split:1.0', classpath: ['com.example:dep:1.0'], args: ['--input', '{MINECRAFT_JAR}', '--slim', '{SLIM}'], outputs: { '{SLIM}': '{SLIM_SHA}' } },
        { jar: 'com.example:patch:1.0', args: ['--clean', '{SLIM}', '--output', '{PATCHED}', '--side', '{SIDE}'] },
      ],
    }
    const vars = buildVariables(profile.data, context())
    return { profile, vars }
  }

  /** A runner that behaves like the tools: writes the requested outputs. */
  function fakeRunner(calls: ProcessorInvocation[], options: { slim?: string; exit?: number } = {}): ProcessorRunner {
    return async (inv) => {
      calls.push(inv)
      if (options.exit) return { exitCode: options.exit, signal: null, log: 'Exception in thread "main"' }
      const flag = (name: string) => inv.args[inv.args.indexOf(name) + 1] as string
      if (inv.mainClass === 'com.example.Split') {
        await mkdir(dirname(flag('--slim')), { recursive: true })
        await writeFile(flag('--slim'), options.slim ?? 'slim-bytes')
      } else if (inv.mainClass === 'com.example.Patch') {
        await mkdir(dirname(flag('--output')), { recursive: true })
        await writeFile(flag('--output'), await buildZip({ 'Patched.class': PATCHED_CONTENT }))
      }
      return { exitCode: 0, signal: null, log: `ran ${inv.mainClass}` }
    }
  }

  it('runs client processors in order with substituted args, then skips them when outputs are valid', async () => {
    const { profile, vars } = await setup()
    const calls: ProcessorInvocation[] = []
    const result = await runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, java: '/fake/java', runner: fakeRunner(calls) })
    expect(result).toMatchObject({ ran: 2, skipped: 0, native: 0 })
    expect(calls.map((c) => c.mainClass)).toEqual(['com.example.Split', 'com.example.Patch'])
    expect(calls[0]).toEqual({
      java: '/fake/java',
      jvmArgs: [],
      classpath: [libraryPathOf('com.example:dep:1.0', libraryDir), libraryPathOf('com.example:split:1.0', libraryDir)],
      mainClass: 'com.example.Split',
      args: ['--input', join(root, 'versions/1.21.1/1.21.1.jar'), '--slim', vars.SLIM],
      cwd: root,
    })
    expect(calls[1]?.args).toEqual(['--clean', vars.SLIM, '--output', vars.PATCHED, '--side', 'client'])
    expect(result.logs.map((l) => l.log)).toEqual(['ran com.example.Split', 'ran com.example.Patch'])

    calls.length = 0
    const again = await runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, java: '/fake/java', runner: fakeRunner(calls) })
    expect(again).toMatchObject({ ran: 0, skipped: 2 })
    expect(calls).toEqual([])

    // Only the processor whose output went bad runs again.
    await writeFile(vars.PATCHED as string, Buffer.alloc(22))
    await runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, java: '/fake/java', runner: fakeRunner(calls) })
    expect(calls.map((c) => c.mainClass)).toEqual(['com.example.Patch'])
  })

  it('verifies declared output hashes and deletes bad outputs', async () => {
    const { profile, vars } = await setup()
    const calls: ProcessorInvocation[] = []
    await expect(
      runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, java: '/fake/java', runner: fakeRunner(calls, { slim: 'wrong' }) }),
    ).rejects.toMatchObject({ code: 'EINSTALL_PROCESSOR_OUTPUT', file: vars.SLIM, expected: sha1('slim-bytes'), actual: sha1('wrong') })
    expect(await exists(vars.SLIM as string)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('reports failing processors with their log', async () => {
    const { profile, vars } = await setup()
    await expect(
      runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, java: '/fake/java', runner: fakeRunner([], { exit: 1 }) }),
    ).rejects.toMatchObject({ code: 'EINSTALL_PROCESSOR_FAILED', mainClass: 'com.example.Split', exitCode: 1, log: 'Exception in thread "main"' })
  })

  it('refuses to start with an unknown variable or without Java', async () => {
    const { profile, vars } = await setup()
    const calls: ProcessorInvocation[] = []
    const bad: Processor[] = [...(profile.processors ?? []), { jar: 'com.example:patch:1.0', args: ['{NOT_DEFINED}'] }]
    await expect(runProcessors({ processors: bad, variables: vars, libraryDir, cwd: root, java: '/j', runner: fakeRunner(calls) })).rejects.toMatchObject({
      code: 'EINSTALL_UNKNOWN_VARIABLE',
    })
    expect(calls).toEqual([])
    await expect(runProcessors({ processors: profile.processors ?? [], variables: vars, libraryDir, cwd: root, runner: fakeRunner(calls) })).rejects.toMatchObject({
      code: 'EINSTALL_NO_JAVA',
    })
  })

  it('lets a native handler replace a processor', async () => {
    const { vars } = await setup()
    const out = join(root, 'maps.txt')
    const result = await runProcessors({
      processors: [{ jar: 'com.example:split:1.0', args: ['--task', 'DOWNLOAD_MOJMAPS', '--output', out] }],
      variables: vars,
      libraryDir,
      cwd: root,
      handleNatively: async (_p, args, outputs) => {
        expect(outputs).toEqual([{ path: out }])
        await writeFile(args[3] as string, 'mappings')
        return true
      },
    })
    expect(result).toMatchObject({ native: 1, ran: 0 })
  })
})

describe('spawnProcessor', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- kept next to the tests that use it
  async function fakeJava(body: string): Promise<string> {
    const dir = join(root, 'jdk', 'bin')
    await mkdir(dir, { recursive: true })
    const java = join(dir, 'java')
    await writeFile(java, `#!/bin/sh\n${body}\n`)
    await chmod(java, 0o755)
    return java
  }

  it('runs java -cp <classpath> <main> <args> and captures output', async () => {
    const record = join(root, 'args.txt')
    const java = await fakeJava(`for a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\necho "working in $(pwd)"\necho oops >&2`)
    const result = await spawnProcessor(
      { java, jvmArgs: ['-Dhttps.proxyHost=proxy'], classpath: ['/l/a.jar', '/l/b.jar'], mainClass: 'com.example.Main', args: ['--in', 'a b'], cwd: root },
      {},
    )
    expect(result.exitCode).toBe(0)
    expect((await readFile(record, 'utf8')).trimEnd().split('\n')).toEqual(['-Dhttps.proxyHost=proxy', '-cp', '/l/a.jar:/l/b.jar', 'com.example.Main', '--in', 'a b'])
    expect(result.log).toContain('working in')
    expect(result.log).toContain('oops')
  })

  it('runs processors with the sanitised game environment (no JVM agents, dylibs or ELECTRON_RUN_AS_NODE)', async () => {
    const java = await fakeJava('env')
    const baseEnv = { PATH: process.env.PATH, HOME: '/home/x', JAVA_TOOL_OPTIONS: '-javaagent:/evil.jar', _JAVA_OPTIONS: '-Dx', JDK_JAVA_OPTIONS: '-Dy', ELECTRON_RUN_AS_NODE: '1', DYLD_INSERT_LIBRARIES: '/evil.dylib', NODE_OPTIONS: '--require x' }
    const { log } = await spawnProcessor({ java, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, { baseEnv })
    expect(log).toContain('HOME=/home/x')
    for (const k of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']) expect(log).not.toMatch(new RegExp(`^${k}=`, 'm'))
    // The default is process.env, sanitised the same way.
    const before = process.env.JAVA_TOOL_OPTIONS
    process.env.JAVA_TOOL_OPTIONS = '-javaagent:/evil.jar'
    try {
      expect((await spawnProcessor({ java, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, {})).log).not.toContain('JAVA_TOOL_OPTIONS')
    } finally {
      if (before === undefined) delete process.env.JAVA_TOOL_OPTIONS
      else process.env.JAVA_TOOL_OPTIONS = before
    }
  })

  it('reports exit codes and stops on abort', async () => {
    const failing = await fakeJava('echo boom; exit 3')
    expect(await spawnProcessor({ java: failing, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, {})).toMatchObject({ exitCode: 3, log: 'boom\n' })
    const slow = await fakeJava('sleep 30')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(new Error('stop')), 100)
    await expect(spawnProcessor({ java: slow, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, { signal: controller.signal })).rejects.toThrow('stop')
    expect(Date.now() - started).toBeLessThan(5000)
    const timed = await spawnProcessor({ java: slow, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, { timeoutMs: 100 })
    expect(timed).toMatchObject({ timedOut: true, signal: 'SIGTERM' })
  })

  it('settles when a grandchild outside the process group keeps the output pipes open', async () => {
    // The fake tool starts a `sleep 30` in a new session (out of reach of the group kill) that
    // inherits stdout/stderr, records its pid, then exits (or hangs until the timeout).
    const pids = join(root, 'pids.txt')
    const spawnOrphan = `"${process.execPath}" -e 'const c=require("child_process").spawn("sleep",["30"],{detached:true,stdio:["ignore",1,2]});require("fs").appendFileSync(process.argv[1],c.pid+"\\n");c.unref()' '${pids}'`
    try {
      const exits = await fakeJava(`${spawnOrphan}\necho started\nexit 0`)
      let started = Date.now()
      const done = await spawnProcessor({ java: exits, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, {})
      expect(done).toMatchObject({ exitCode: 0, timedOut: false })
      expect(done.log).toContain('started')
      expect(Date.now() - started).toBeLessThan(4000)

      const hangs = await fakeJava(`${spawnOrphan}\nsleep 30`)
      started = Date.now()
      const timed = await spawnProcessor({ java: hangs, jvmArgs: [], classpath: [], mainClass: 'M', args: [], cwd: root }, { timeoutMs: 100 })
      expect(timed).toMatchObject({ timedOut: true })
      expect(Date.now() - started).toBeLessThan(4000)
    } finally {
      for (const pid of (await readFile(pids, 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }, 15_000)
})
