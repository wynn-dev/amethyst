import { mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CPU_ARM64, CPU_X86_64, put, tempDir, thinMachO } from './__fixtures__/helpers'
import { ProbeCache } from './cache'
import { discoverJava, findJavaCandidates, type DiscoverOptions } from './discovery'
import type { JavaRecord } from './types'

let base: string
let cleanup: () => Promise<void>
let root: string
let home: string
let runtimes: string

async function jdk(dir: string, version: string, cpu = CPU_ARM64, vendor = 'Test Vendor'): Promise<void> {
  await put(join(dir, 'bin', 'java'), thinMachO(cpu), 0o755)
  await put(join(dir, 'release'), `IMPLEMENTOR="${vendor}"\nJAVA_VERSION="${version}"\nOS_ARCH="${cpu === CPU_ARM64 ? 'aarch64' : 'x86_64'}"\n`)
}

async function link(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path)
}

beforeAll(async () => {
  ;({ dir: base, cleanup } = await tempDir())
  base = await realpath(base)
  root = join(base, 'root')
  home = join(base, 'home')
  runtimes = join(base, 'runtimes')
  const zulu17 = join(root, 'Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home')
  await jdk(zulu17, '17.0.20.1', CPU_ARM64, 'Azul Systems, Inc.')
  await jdk(join(home, 'Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home'), '27', CPU_ARM64, 'Oracle Corporation')
  // Homebrew: the opt link points into the Cellar keg; both must collapse into one record.
  await jdk(join(root, 'opt/homebrew/Cellar/openjdk/25.0.1/libexec/openjdk.jdk/Contents/Home'), '25.0.1', CPU_ARM64, 'Homebrew')
  await link('../Cellar/openjdk/25.0.1', join(root, 'opt/homebrew/opt/openjdk'))
  await jdk(join(root, 'usr/local/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home'), '11.0.2', CPU_X86_64, 'Homebrew')
  // SDKMAN with its `current` link (skipped), asdf, mise, Gradle, Mojang launcher.
  await jdk(join(home, '.sdkman/candidates/java/21.0.7-tem'), '21.0.7', CPU_ARM64, 'Eclipse Adoptium')
  await link('21.0.7-tem', join(home, '.sdkman/candidates/java/current'))
  await jdk(join(home, '.asdf/installs/java/temurin-17.0.15'), '17.0.15')
  await jdk(join(home, '.local/share/mise/installs/java/22.0.2'), '22.0.2')
  await jdk(join(home, '.gradle/jdks/eclipse_adoptium-21-aarch64-os_x/Contents/Home'), '21.0.6')
  await jdk(join(home, 'Library/Application Support/minecraft/runtime/java-runtime-gamma/mac-os-arm64/java-runtime-gamma/jre.bundle/Contents/Home'), '17.0.15', CPU_ARM64, 'Microsoft')
  // jenv versions are links to real homes: de-duplicated against the system bundle.
  await link(zulu17, join(home, '.jenv/versions/17'))
  // Managed runtimes (Mojang layout and normalised Zulu layout); dot folders are ignored.
  await jdk(join(runtimes, 'java-runtime-delta/jre.bundle/Contents/Home'), '21.0.7', CPU_ARM64, 'Microsoft')
  await jdk(join(runtimes, 'zulu-8/Contents/Home'), '1.8.0_512', CPU_ARM64, 'Azul Systems, Inc.')
  await jdk(join(runtimes, '.staging-zulu-8-abc/tree/Contents/Home'), '1.8.0_512')
  // The Apple stub on PATH must never be probed.
  await put(join(root, 'usr/bin/java'), thinMachO(CPU_ARM64), 0o755)
  // A PATH dir with a `java` link into SDKMAN.
  await link(join(home, '.sdkman/candidates/java/21.0.7-tem/bin/java'), join(base, 'bin/java'))
}, 30_000)
afterAll(() => cleanup())

function options(extra: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    root,
    home,
    runtimesDir: runtimes,
    env: { PATH: [join(root, 'usr/bin'), join(base, 'bin'), 'relative/ignored'].join(':'), JAVA_HOME: join(runtimes, 'java-runtime-delta/jre.bundle/Contents/Home') },
    javaHome: async () => [
      { home: join(root, 'Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home'), version: '17.0.20.1', arch: 'arm64' },
      { home: join(base, 'disabled'), enabled: false },
    ],
    ...extra,
  }
}

const summary = (records: JavaRecord[]) =>
  records.map((r) => ({ source: r.source, path: r.path.slice(base.length + 1), major: r.majorVersion, arch: r.arch, valid: r.valid })).toSorted((a, b) => a.path.localeCompare(b.path))

describe('discoverJava', () => {
  it('finds every source, de-duplicates by realpath and prefers managed / java_home paths', async () => {
    const records = await discoverJava(options())
    expect(summary(records)).toEqual(
      [
        { source: 'managed', path: 'runtimes/java-runtime-delta/jre.bundle/Contents/Home/bin/java', major: 21, arch: 'arm64', valid: true },
        { source: 'managed', path: 'runtimes/zulu-8/Contents/Home/bin/java', major: 8, arch: 'arm64', valid: true },
        { source: 'java_home', path: 'root/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java', major: 17, arch: 'arm64', valid: true },
        { source: 'user', path: 'home/Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home/bin/java', major: 27, arch: 'arm64', valid: true },
        { source: 'homebrew', path: 'root/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java', major: 25, arch: 'arm64', valid: true },
        { source: 'homebrew-intel', path: 'root/usr/local/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home/bin/java', major: 11, arch: 'x64', valid: true },
        { source: 'sdkman', path: 'home/.sdkman/candidates/java/21.0.7-tem/bin/java', major: 21, arch: 'arm64', valid: true },
        { source: 'asdf', path: 'home/.asdf/installs/java/temurin-17.0.15/bin/java', major: 17, arch: 'arm64', valid: true },
        { source: 'mise', path: 'home/.local/share/mise/installs/java/22.0.2/bin/java', major: 22, arch: 'arm64', valid: true },
        { source: 'gradle', path: 'home/.gradle/jdks/eclipse_adoptium-21-aarch64-os_x/Contents/Home/bin/java', major: 21, arch: 'arm64', valid: true },
        {
          source: 'mojang-launcher',
          path: 'home/Library/Application Support/minecraft/runtime/java-runtime-gamma/mac-os-arm64/java-runtime-gamma/jre.bundle/Contents/Home/bin/java',
          major: 17,
          arch: 'arm64',
          valid: true,
        },
      ].toSorted((a, b) => a.path.localeCompare(b.path)),
    )
    const realPaths = records.map((r) => r.realPath)
    expect(new Set(realPaths).size).toBe(realPaths.length)
    expect(records.every((r) => r.managed === r.path.startsWith(runtimes))).toBe(true)
  })

  it('keeps missing user-added paths, accepts a home dir, and honours hidden paths', async () => {
    const records = await discoverJava(
      options({
        extraPaths: [join(base, 'gone/bin/java'), join(home, '.asdf/installs/java/temurin-17.0.15')],
        hidden: [join(home, 'Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home/bin/java'), join(root, 'opt/homebrew/Cellar/openjdk/25.0.1/libexec/openjdk.jdk/Contents/Home/bin/java')],
      }),
    )
    const byPath = new Map(records.map((r) => [r.path, r]))
    expect(byPath.get(join(base, 'gone/bin/java'))).toMatchObject({ source: 'manual', valid: false, invalidReason: 'missing' })
    expect(byPath.get(join(home, '.asdf/installs/java/temurin-17.0.15/bin/java'))?.source).toBe('manual')
    expect(records.some((r) => r.majorVersion === 27)).toBe(false)
    // Hidden by realpath: the Homebrew opt link resolves to the hidden Cellar path.
    expect(records.some((r) => r.majorVersion === 25)).toBe(false)
  })

  it('rescans from the probe cache with no new probes', async () => {
    const cache = new ProbeCache()
    const first = await discoverJava(options({ cache }))
    const misses = cache.misses
    const second = await discoverJava(options({ cache }))
    expect(cache.misses).toBe(misses)
    expect(cache.hits).toBe(first.length)
    expect(summary(second)).toEqual(summary(first))
  })

  it('lists candidates without probing', async () => {
    const candidates = await findJavaCandidates(options({ javaHome: false }))
    expect(candidates.some((c) => c.source === 'java_home')).toBe(false)
    expect(candidates.some((c) => c.path.includes('.staging-'))).toBe(false)
    expect(candidates.some((c) => c.path.endsWith('candidates/java/current/bin/java'))).toBe(false)
    expect(candidates.filter((c) => c.source === 'path').map((c) => c.path)).toEqual([join(root, 'usr/bin/java'), join(base, 'bin/java')])
  })

  it.runIf(process.platform === 'darwin')('scans this Mac without probing the /usr/bin/java stub', async () => {
    const records = await discoverJava({ cache: new ProbeCache() })
    expect(records.some((r) => r.path === '/usr/bin/java' || r.realPath === '/usr/bin/java')).toBe(false)
    for (const r of records.filter((x) => x.valid)) expect(['arm64', 'x64']).toContain(r.arch)
  }, 60_000)
})
