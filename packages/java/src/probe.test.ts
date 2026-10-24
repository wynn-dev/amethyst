import { chmod, readFile, realpath, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CPU_ARM64, CPU_X86_64, fakeJavaScript, fatMachO, put, tempDir, thinMachO } from './__fixtures__/helpers'
import { ProbeCache } from './cache'
import { parseShowSettings, probeJava } from './probe'

let dir: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ dir, cleanup } = await tempDir())
})
afterEach(() => cleanup())

/** A JDK home whose `bin/java` is a (non-runnable) Mach-O header plus a `release` file. */
async function machoJdk(home: string, binary: Buffer, release: string): Promise<string> {
  const java = join(home, 'bin', 'java')
  await put(java, binary, 0o755)
  await put(join(home, 'release'), release)
  return java
}

const ARM_PROPS = {
  'java.version': '21.0.7',
  'java.vendor': 'Eclipse Adoptium',
  'java.vm.name': 'OpenJDK 64-Bit Server VM',
  'os.arch': 'aarch64',
  'java.specification.version': '21',
}

describe('parseShowSettings', () => {
  it('reads properties including multi-line values', () => {
    const text = [
      'Property settings:',
      '    file.separator = /',
      '    java.library.path = /Users/me/Library/Java/Extensions',
      '        /Library/Java/Extensions',
      '        /usr/lib/java',
      '    java.version = 1.8.0_512',
      '    os.arch = aarch64',
      '    line.separator = \\n ',
      '',
      'openjdk version "1.8.0_512"',
    ].join('\n')
    const props = parseShowSettings(text)
    expect(props['java.version']).toBe('1.8.0_512')
    expect(props['os.arch']).toBe('aarch64')
    expect(props['java.library.path']).toBe('/Users/me/Library/Java/Extensions\n/Library/Java/Extensions\n/usr/lib/java')
  })
})

describe('probeJava (no spawn)', () => {
  it('reads version, vendor and arch from release + Mach-O without spawning', async () => {
    // The binary is only a header: spawning it would fail, so a valid result proves no spawn.
    const java = await machoJdk(join(dir, 'zulu-17.jdk', 'Contents', 'Home'), thinMachO(CPU_ARM64, 0, 4096), 'IMPLEMENTOR="Azul Systems, Inc."\nJAVA_VERSION="17.0.20.1"\nOS_ARCH="aarch64"\n')
    const r = await probeJava(java, { source: 'system' })
    expect(r).toMatchObject({ valid: true, verified: false, version: '17.0.20.1', majorVersion: 17, arch: 'arm64', vendor: 'Azul Systems, Inc.', machO: ['arm64'], source: 'system', managed: false })
    expect(r.javaHome).toBe(join(await realpath(dir), 'zulu-17.jdk', 'Contents', 'Home'))
    expect(r.size).toBe(4096)
  })

  it('trusts the Mach-O header over the release file and picks the native slice of a fat binary', async () => {
    const x64 = await machoJdk(join(dir, 'a'), thinMachO(CPU_X86_64), 'JAVA_VERSION="11.0.2"\nOS_ARCH="aarch64"\n')
    expect((await probeJava(x64)).arch).toBe('x64')
    const fat = await machoJdk(join(dir, 'b'), fatMachO([CPU_X86_64, CPU_ARM64]), 'JAVA_VERSION="1.8.0_452"\nOS_ARCH="x86_64"\n')
    expect(await probeJava(fat)).toMatchObject({ arch: 'arm64', majorVersion: 8, machO: ['x86_64', 'arm64'] })
  })

  it('reports missing and non-executable binaries', async () => {
    expect(await probeJava(join(dir, 'nope', 'bin', 'java'))).toMatchObject({ valid: false, invalidReason: 'missing' })
    const java = await machoJdk(join(dir, 'c'), thinMachO(CPU_ARM64), 'JAVA_VERSION="21"\n')
    await chmod(java, 0o644)
    expect(await probeJava(java)).toMatchObject({ valid: false, invalidReason: 'not-executable' })
    expect((await stat(java)).mode & 0o777).toBe(0o644) // never chmods outside the managed dir
  })

  it('chmods a non-executable binary inside the managed directory', async () => {
    const managed = join(dir, 'runtimes')
    const java = await machoJdk(join(managed, 'zulu-8', 'Contents', 'Home'), thinMachO(CPU_ARM64), 'JAVA_VERSION="1.8.0_512"\nOS_ARCH="aarch64"\n')
    await chmod(java, 0o644)
    expect(await probeJava(java, { managedDir: managed, source: 'path' })).toMatchObject({ valid: true, managed: true, source: 'managed' })
    expect((await stat(java)).mode & 0o777).toBe(0o755)
  })
})

describe('probeJava (spawn)', () => {
  it('spawns when metadata is missing and uses os.arch', async () => {
    const java = join(dir, 'jdk', 'bin', 'java')
    await put(java, fakeJavaScript(ARM_PROPS), 0o755)
    expect(await probeJava(java)).toMatchObject({ valid: true, verified: true, version: '21.0.7', majorVersion: 21, arch: 'arm64', vendor: 'Eclipse Adoptium', vmName: 'OpenJDK 64-Bit Server VM' })
  })

  it('spawns with policy "always" even when metadata is complete, with a clean environment', async () => {
    const java = join(dir, 'jdk', 'bin', 'java')
    // Exits non-zero if the stripped variables leak into the probe.
    await put(java, fakeJavaScript({ ...ARM_PROPS, 'os.arch': 'x86_64' }, undefined, 'if [ -n "$JAVA_TOOL_OPTIONS$_JAVA_OPTIONS$CLASSPATH" ]; then exit 3; fi\n[ "$(pwd)" = "/" ] || exit 4'), 0o755)
    await put(join(dir, 'jdk', 'release'), 'JAVA_VERSION="21.0.7"\nOS_ARCH="aarch64"\n')
    const env = { ...process.env, JAVA_TOOL_OPTIONS: '-Dx=1.2.3', _JAVA_OPTIONS: '-Xmx1g', CLASSPATH: '/tmp' }
    // Metadata alone says arm64 and needs no spawn...
    expect(await probeJava(java, { spawn: 'fallback', env })).toMatchObject({ valid: true, verified: false, arch: 'arm64' })
    const r = await probeJava(java, { spawn: 'always', env })
    // ...but the running JVM's os.arch is authoritative (a script has no Mach-O header).
    expect(r).toMatchObject({ valid: true, verified: true, arch: 'x64' })
  })

  it('falls back to the version banner and classifies failures', async () => {
    const banner = join(dir, 'banner', 'bin', 'java')
    await put(banner, `#!/bin/sh\necho 'openjdk version "25" 2025-09-16' >&2\n`, 0o755)
    expect(await probeJava(banner)).toMatchObject({ valid: true, majorVersion: 25, arch: 'unknown' })

    const garbage = join(dir, 'garbage', 'bin', 'java')
    await put(garbage, `#!/bin/sh\necho 'hello' >&2\n`, 0o755)
    expect(await probeJava(garbage)).toMatchObject({ valid: false, invalidReason: 'unparseable' })

    const failing = join(dir, 'failing', 'bin', 'java')
    await put(failing, `#!/bin/sh\necho 'Error: could not create the Java Virtual Machine.' >&2\necho 'openjdk version "17.0.1"' >&2\nexit 1\n`, 0o755)
    expect(await probeJava(failing)).toMatchObject({ valid: false, invalidReason: 'spawn-failed' })
  })

  it('kills a hanging JVM after the timeout and does not cache the result', async () => {
    const java = join(dir, 'hang', 'bin', 'java')
    await put(java, '#!/bin/sh\nexec sleep 10\n', 0o755)
    const cache = new ProbeCache()
    const started = Date.now()
    expect(await probeJava(java, { timeoutMs: 200, cache })).toMatchObject({ valid: false, invalidReason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(cache.size).toBe(0)
  })
})

describe('ProbeCache', () => {
  it('reuses results keyed by (path, mtime, size) so rescans do not spawn', async () => {
    const java = join(dir, 'jdk', 'bin', 'java')
    const counter = join(dir, 'count')
    await put(counter, '')
    await put(java, fakeJavaScript(ARM_PROPS, undefined, `echo x >> '${counter}'`), 0o755)
    const cache = new ProbeCache()
    const first = await probeJava(java, { cache, source: 'path' })
    const second = await probeJava(java, { cache, source: 'user' })
    expect(second).toMatchObject({ ...first, source: 'user' })
    expect(cache.hits).toBe(1)
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)

    // Touching the binary (new mtime) invalidates the entry.
    const later = new Date(Date.now() + 60_000)
    await utimes(java, later, later)
    await probeJava(java, { cache })
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('re-probes unverified entries for spawn "always", and expires old entries', async () => {
    const java = await machoJdk(join(dir, 'jdk'), thinMachO(CPU_ARM64), 'JAVA_VERSION="21.0.7"\nOS_ARCH="aarch64"\n')
    const cache = new ProbeCache([], { maxAgeMs: 1000 })
    await probeJava(java, { cache })
    // The Mach-O stub cannot run, so the forced spawn fails: proof that it was not served from cache.
    expect((await probeJava(java, { cache, spawn: 'always' })).valid).toBe(false)
    const r = cache.records()[0]!
    expect(cache.get(r.realPath, r.mtimeMs, r.size, r.probedAt + 500)).toBeDefined()
    expect(cache.get(r.realPath, r.mtimeMs, r.size, r.probedAt + 5000)).toBeUndefined()
    expect(cache.get(r.realPath, r.mtimeMs + 1, r.size, r.probedAt)).toBeUndefined()
  })

  it('persists atomically and drops malformed entries on load', async () => {
    const java = await machoJdk(join(dir, 'jdk'), thinMachO(CPU_ARM64), 'JAVA_VERSION="21.0.7"\nOS_ARCH="aarch64"\n')
    const cache = new ProbeCache()
    await probeJava(java, { cache })
    const file = join(dir, 'state', 'java.json')
    await cache.save(file)
    const loaded = await ProbeCache.load(file)
    expect(loaded.records()).toEqual(cache.records())

    expect(ProbeCache.fromJSON({ version: 1, records: [{ path: 'x' }, ...cache.records()] }).size).toBe(1)
    expect((await ProbeCache.load(join(dir, 'missing.json'))).size).toBe(0)
    await put(join(dir, 'corrupt.json'), '{"version":1,"rec')
    expect((await ProbeCache.load(join(dir, 'corrupt.json'))).size).toBe(0)
  })
})
