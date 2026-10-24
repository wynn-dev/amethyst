import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { createTask } from '@amethyst/task'
import { compress } from 'lzma1'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CPU_ARM64, CPU_X86_64, makeTarGz, put, sha1, sha256, startServer, tempDir, type TestServer, thinMachO } from './__fixtures__/helpers'
import { InstallError } from './errors'
import { installJavaRuntime, installMojangRuntime, installZuluRuntime, locateJavaBundle, repairRuntime } from './install'
import { INSTALLED_MANIFEST, listManagedRuntimes, readInstalledRuntime, verifyRuntime } from './managed'

let server: TestServer
let client: HttpClient
let base: string
let cleanup: () => Promise<void>
let runtimesDir: string

const H = 'jre.bundle/Contents/Home'
const JAVA = thinMachO(CPU_ARM64, 0, 8192)
const RELEASE = 'JAVA_VERSION="21.0.7"\nMODULES="java.base"\n'
const LICENSE = 'GNU General Public License, version 2, with the Classpath Exception\n'
const SPAWN = thinMachO(CPU_ARM64, 0, 1024)

/** Serve a Mojang-style component: `files` -> manifest -> index. */
function serveComponent(name: string, java: Buffer): { indexUrl: string } {
  const obj = (path: string, data: string | Buffer) => {
    server.route(path, data)
    return `${server.url}${path}`
  }
  const raw = (data: string | Buffer, id: string) => ({ sha1: sha1(data), size: Buffer.byteLength(data), url: obj(`/${name}/raw/${id}`, data) })
  const javaLzma = Buffer.from(compress(java, 3))
  const wrongLzma = Buffer.from(compress(Buffer.from('not the release file'), 1))
  const manifest = {
    files: {
      'jre.bundle': { type: 'directory' },
      'jre.bundle/Contents': { type: 'directory' },
      [H]: { type: 'directory' },
      [`${H}/bin`]: { type: 'directory' },
      [`${H}/bin/java`]: {
        type: 'file',
        executable: true,
        downloads: { raw: raw(java, 'java'), lzma: { sha1: sha1(javaLzma), size: javaLzma.length, url: obj(`/${name}/lzma/java`, javaLzma) } },
      },
      // Its lzma variant decodes to the wrong bytes: must fall back to raw.
      [`${H}/release`]: {
        type: 'file',
        executable: false,
        downloads: { raw: raw(RELEASE, 'release'), lzma: { sha1: sha1(wrongLzma), size: wrongLzma.length, url: obj(`/${name}/lzma/release`, wrongLzma) } },
      },
      [`${H}/lib/jspawnhelper`]: { type: 'file', executable: true, downloads: { raw: raw(SPAWN, 'jspawnhelper') } },
      // Its lzma URL 404s: must fall back to raw.
      [`${H}/legal/java.base/LICENSE`]: {
        type: 'file',
        executable: false,
        downloads: { raw: raw(LICENSE, 'license'), lzma: { sha1: 'f'.repeat(40), size: 10, url: `${server.url}/${name}/lzma/missing` } },
      },
      [`${H}/legal/java.compiler`]: { type: 'directory' },
      [`${H}/legal/java.compiler/LICENSE`]: { type: 'link', target: '../java.base/LICENSE' },
    },
  }
  const manifestBody = JSON.stringify(manifest)
  const manifestUrl = obj(`/${name}/manifest.json`, manifestBody)
  const entry = { availability: { group: 1, progress: 100 }, manifest: { sha1: sha1(manifestBody), size: manifestBody.length, url: manifestUrl }, version: { name: '21.0.7', released: '2025-04-15T00:00:00+00:00' } }
  const index = { 'mac-os-arm64': { [`java-runtime-${name}`]: [entry], 'jre-legacy': [], 'java-runtime-broken': [{ ...entry, manifest: { ...entry.manifest, url: `${server.url}/nope.json` } }] }, 'mac-os': {} }
  return { indexUrl: obj(`/${name}/all.json`, JSON.stringify(index)) }
}

/** An old-style Azul tarball: `<top>/zulu-8.jre/Contents/Home` plus convenience symlinks. */
function zuluTarball(cpu = CPU_ARM64): Buffer {
  const top = 'zulu8.98.0.107-ca-jre8.0.512-macosx_aarch64'
  const home = `${top}/zulu-8.jre/Contents/Home`
  return makeTarGz([
    { name: `${top}/`, type: '5' },
    { name: `${top}/zulu-8.jre/Contents/Info.plist`, content: '<plist/>' },
    { name: `${home}/bin/java`, content: thinMachO(cpu, 0, 4096), mode: 0o755 },
    { name: `${home}/release`, content: 'IMPLEMENTOR="Azul Systems, Inc."\nJAVA_VERSION="1.8.0_512"\nOS_ARCH="aarch64"\n' },
    { name: `${home}/lib/rt.jar`, content: Buffer.alloc(10_000, 3) },
    { name: `${home}/legal/a/LICENSE`, content: 'license' },
    { name: `${home}/legal/b/LICENSE`, type: '2', linkname: '../a/LICENSE' },
    { name: `${top}/bin`, type: '2', linkname: 'zulu-8.jre/Contents/Home/bin' },
    { name: `${top}/release`, type: '2', linkname: 'zulu-8.jre/Contents/Home/release' },
  ])
}

function serveZulu(prefix: string, archive: Buffer, opts: { badSha?: boolean } = {}): string {
  const name = 'zulu8.98.0.107-ca-jre8.0.512-macosx_aarch64.tar.gz'
  const uuid = '841e5f64-a746-4803-8b56-4e14767efb1b'
  const url = `${server.url}${prefix}/cdn/${name}`
  server.route(`${prefix}/cdn/${name}`, archive)
  const summary = { availability_type: 'CA', distro_version: [8, 98, 0, 107], download_url: url, java_version: [8, 0, 512], latest: true, name, package_uuid: uuid, product: 'zulu' }
  server.route(`${prefix}/api/`, [summary])
  server.route(`${prefix}/api/${uuid}`, {
    ...summary,
    arch: 'arm',
    os: 'macos',
    archive_type: 'tar.gz',
    java_package_type: 'jre',
    javafx_bundled: false,
    sha256_hash: opts.badSha ? '0'.repeat(64) : sha256(archive),
    // Azul rounds sizes to the nearest 100 bytes; the install must still succeed.
    size: Math.round(archive.length / 100) * 100 + 100,
  })
  return `${server.url}${prefix}/api`
}

beforeAll(async () => {
  server = await startServer()
  client = createHttpClient({ connectTimeoutMs: 2000 })
  ;({ dir: base, cleanup } = await tempDir())
})
afterAll(async () => {
  await client.close()
  await server.close()
  await cleanup()
})
beforeEach(async () => {
  runtimesDir = join(base, `runtimes-${Math.random().toString(36).slice(2)}`)
})

const hits = (path: string) => server.hits.get(path) ?? 0

describe('installMojangRuntime (offline)', () => {
  it('installs with lzma, falls back to raw, lays out modes and links, then reuses the install', async () => {
    const { indexUrl } = serveComponent('delta', JAVA)
    const task = createTask('install', (ctx) => installMojangRuntime('java-runtime-delta', { runtimesDir, client, indexUrl, ctx, probe: false }))
    const result = await task.promise
    const dir = join(runtimesDir, 'java-runtime-delta')
    expect(result.reused).toBe(false)
    expect(result.transfer).toEqual({ lzma: 1, raw: 3, reused: 0 })
    expect(result.runtime.javaPath).toBe(join(dir, H, 'bin/java'))
    expect(result.java).toMatchObject({ valid: true, arch: 'arm64', majorVersion: 21, managed: true, source: 'managed' })
    expect((await readFile(join(dir, H, 'bin/java'))).equals(JAVA)).toBe(true)
    expect(await readFile(join(dir, H, 'release'), 'utf8')).toBe(RELEASE)
    expect((await stat(join(dir, H, 'bin/java'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(dir, H, 'lib/jspawnhelper'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(dir, H, 'release'))).mode & 0o777).toBe(0o644)
    expect(await readlink(join(dir, H, 'legal/java.compiler/LICENSE'))).toBe('../java.base/LICENSE')
    expect(await readFile(join(dir, H, 'legal/java.compiler/LICENSE'), 'utf8')).toBe(LICENSE)
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).files).toBeDefined()
    // java came through lzma; release and LICENSE through the raw fallback.
    expect(hits('/delta/lzma/java')).toBe(1)
    expect(hits('/delta/raw/java')).toBe(0)
    expect(hits('/delta/raw/release')).toBe(1)
    expect(hits('/delta/raw/license')).toBe(1)
    const installed = (await readInstalledRuntime(dir))!
    expect(installed).toMatchObject({ source: 'mojang', name: 'java-runtime-delta', majorVersion: 21, version: '21.0.7', arch: 'arm64', javaPath: `${H}/bin/java` })
    expect(Object.keys(installed.files)).toHaveLength(4)
    expect(installed.links).toEqual({ [`${H}/legal/java.compiler/LICENSE`]: '../java.base/LICENSE' })
    expect((await readdir(runtimesDir)).filter((n) => n.startsWith('.'))).toEqual([])
    expect(task.snapshot().children.map((c) => c.name)).toEqual(['download', 'decompress', 'download-raw', 'layout'])

    const again = await installMojangRuntime('java-runtime-delta', { runtimesDir, client, indexUrl, probe: false })
    expect(again.reused).toBe(true)
    expect(hits('/delta/lzma/java')).toBe(1)
    expect((await listManagedRuntimes(runtimesDir)).map((r) => [r.name, r.javaPath])).toEqual([['java-runtime-delta', join(dir, H, 'bin/java')]])
  })

  it('verifies quickly, detects damage, and repairs it', async () => {
    const { indexUrl } = serveComponent('repair', JAVA)
    const { runtime } = await installMojangRuntime('java-runtime-repair', { runtimesDir, client, indexUrl, probe: false })
    const dir = runtime.dir
    expect(await verifyRuntime(dir)).toMatchObject({ ok: true, hashed: 0, checked: 4 })
    expect((await verifyRuntime(dir, { full: true })).hashed).toBe(4)

    await writeFile(join(dir, H, 'legal/java.base/LICENSE'), LICENSE.toUpperCase())
    await chmod(join(dir, H, 'bin/java'), 0o644)
    await rm(join(dir, H, 'lib/jspawnhelper'))
    await rm(join(dir, H, 'legal/java.compiler/LICENSE'))
    const report = await verifyRuntime(dir)
    expect(report.problems).toEqual([
      { path: `${H}/bin/java`, problem: 'mode' },
      { path: `${H}/legal/java.base/LICENSE`, problem: 'hash' },
      { path: `${H}/legal/java.compiler/LICENSE`, problem: 'link' },
      { path: `${H}/lib/jspawnhelper`, problem: 'missing' },
    ])

    const repaired = await repairRuntime(dir, { runtimesDir, client, probe: false })
    expect(repaired.reinstalled).toBe(false)
    expect(repaired.repaired).toHaveLength(4)
    expect(await verifyRuntime(dir, { full: true })).toMatchObject({ ok: true })
    expect(await readFile(join(dir, H, 'legal/java.base/LICENSE'), 'utf8')).toBe(LICENSE)
    expect((await stat(join(dir, H, 'bin/java'))).mode & 0o777).toBe(0o755)
  })

  it('refuses a runtime that is not arm64 and leaves nothing behind', async () => {
    const { indexUrl } = serveComponent('intel', thinMachO(CPU_X86_64, 0, 4096))
    await expect(installMojangRuntime('java-runtime-intel', { runtimesDir, client, indexUrl, probe: false })).rejects.toMatchObject({ code: 'EBADARCH' })
    expect(await readdir(runtimesDir)).toEqual([])
  })

  it('reports components Mojang does not ship for arm64', async () => {
    const { indexUrl } = serveComponent('legacy', JAVA)
    await expect(installMojangRuntime('jre-legacy', { runtimesDir, client, indexUrl, probe: false })).rejects.toMatchObject({ code: 'ENORUNTIME' })
  })
})

describe('installZuluRuntime (offline)', () => {
  it('downloads, verifies sha256, extracts safely and normalises to Contents/Home', async () => {
    const apiBase = serveZulu('/z1', zuluTarball())
    const result = await installZuluRuntime(8, { runtimesDir, client, apiBase, probe: false })
    const dir = join(runtimesDir, 'zulu-8')
    expect(result.runtime.javaPath).toBe(join(dir, 'Contents/Home/bin/java'))
    expect(result.java).toMatchObject({ valid: true, arch: 'arm64', majorVersion: 8, version: '1.8.0_512', vendor: 'Azul Systems, Inc.' })
    expect(await readFile(join(dir, 'Contents/Info.plist'), 'utf8')).toBe('<plist/>')
    expect(await readlink(join(dir, 'Contents/Home/legal/b/LICENSE'))).toBe('../a/LICENSE')
    // The archive's top-level convenience links are not part of the normalised bundle.
    await expect(lstat(join(dir, 'bin'))).rejects.toThrow(/ENOENT/)
    const installed = (await readInstalledRuntime(dir))!
    expect(installed).toMatchObject({ source: 'zulu', name: 'zulu-8', majorVersion: 8, javaPath: 'Contents/Home/bin/java', zulu: { packageUuid: '841e5f64-a746-4803-8b56-4e14767efb1b' } })
    expect(installed.files['Contents/Home/lib/rt.jar']).toMatchObject({ size: 10_000, sha1: sha1(Buffer.alloc(10_000, 3)) })
    expect(installed.links).toEqual({ 'Contents/Home/legal/b/LICENSE': '../a/LICENSE' })
    expect(await verifyRuntime(dir, { full: true })).toMatchObject({ ok: true })
    expect((await installZuluRuntime(8, { runtimesDir, client, apiBase, probe: false })).reused).toBe(true)

    // Zulu repair reinstalls the archive.
    await writeFile(join(dir, 'Contents/Home/lib/rt.jar'), 'truncated')
    const repaired = await repairRuntime(dir, { runtimesDir, client, probe: false })
    expect(repaired.reinstalled).toBe(true)
    expect(await verifyRuntime(dir, { full: true })).toMatchObject({ ok: true })
  })

  it('fails on a sha256 mismatch without installing anything', async () => {
    const apiBase = serveZulu('/z2', zuluTarball(), { badSha: true })
    await expect(installZuluRuntime(8, { runtimesDir, client, apiBase, probe: false })).rejects.toMatchObject({ code: 'ECHECKSUM' })
    expect(await readdir(runtimesDir)).toEqual([])
  })

  it('locates both Azul layouts', async () => {
    const { dir, cleanup: done } = await tempDir()
    try {
      await put(join(dir, 'new/zulu21-top/Contents/Home/bin/java'), 'x')
      expect(await locateJavaBundle(join(dir, 'new'))).toEqual({ kind: 'bundle', dir: join(dir, 'new/zulu21-top') })
      await put(join(dir, 'old/top/zulu-16.jre/Contents/Home/bin/java'), 'x')
      await mkdir(join(dir, 'old/top/bin'), { recursive: true })
      expect(await locateJavaBundle(join(dir, 'old'))).toEqual({ kind: 'bundle', dir: join(dir, 'old/top/zulu-16.jre') })
      await put(join(dir, 'bare/jdk-17/bin/java'), 'x')
      expect(await locateJavaBundle(join(dir, 'bare'))).toEqual({ kind: 'home', dir: join(dir, 'bare/jdk-17') })
      expect(await locateJavaBundle(join(dir, 'missing'))).toBeUndefined()
    } finally {
      await done()
    }
  })
})

describe('installJavaRuntime (offline)', () => {
  it('routes Java 8 to Zulu because Mojang has no arm64 jre-legacy', async () => {
    const { indexUrl } = serveComponent('route', JAVA)
    const apiBase = serveZulu('/z3', zuluTarball())
    const r = await installJavaRuntime({ majorVersion: 8, component: 'jre-legacy' }, { runtimesDir, client, indexUrl, apiBase, probe: false })
    expect(r.choice).toMatchObject({ source: 'zulu', majorVersion: 8 })
    expect(r.runtime.name).toBe('zulu-8')
  })

  it('collects every failed candidate into an InstallError', async () => {
    const { indexUrl } = serveComponent('fail', JAVA)
    const err = await installJavaRuntime({ majorVersion: 21, component: 'java-runtime-broken' }, { runtimesDir, client, indexUrl, apiBase: `${server.url}/no-api`, probe: false }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstallError)
    expect((err as InstallError).attempts.map((a) => [a.source, a.target])).toEqual([
      ['mojang', 'java-runtime-broken'],
      ['zulu', 'zulu-21'],
    ])
    expect(await readdir(runtimesDir).catch(() => [])).toEqual([])
  })

  it('keeps the install record name stable', () => {
    expect(INSTALLED_MANIFEST).toBe('.amethyst-installed.json')
  })
})
