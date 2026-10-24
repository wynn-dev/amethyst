import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createZip } from '@amethyst/zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from '../__fixtures__/helpers'
import type { ResolvedLibrary } from '../libraries'
import { parseMavenName } from '../maven'
import { extractNatives, NATIVES_MANIFEST, nativesDirectory } from './extract'

let root: string
let cleanup: () => Promise<void>
beforeEach(async () => ({ dir: root, cleanup } = await tempDir()))
afterEach(() => cleanup())

const libs = () => path.join(root, 'libraries')

async function jar(name: string, entries: Record<string, string>, sha1 = 'x'): Promise<ResolvedLibrary> {
  const coordinate = parseMavenName(name)
  const rel = `${coordinate.group.replaceAll('.', '/')}/${coordinate.artifact}/${coordinate.version}/${coordinate.artifact}-${coordinate.version}-${coordinate.classifier}.jar`
  const file = path.join(libs(), rel)
  await mkdir(path.dirname(file), { recursive: true })
  const w = createZip(file)
  for (const [n, data] of Object.entries(entries)) w.addBuffer(Buffer.from(data), n)
  await w.finish()
  return { name, coordinate, download: { path: rel, url: '', sha1 }, isNative: true, extractExclude: ['META-INF/'], source: 'test' }
}

describe('extractNatives', () => {
  it('extracts flat, filters META-INF/.sha1/.git and other platforms, and creates the sub-folders', async () => {
    const lwjgl = await jar('org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', {
      'META-INF/MANIFEST.MF': 'm',
      'liblwjgl.dylib': 'lwjgl',
      'openal.dylib': 'al',
      'liblwjgl.dylib.sha1': 'h',
      'liblwjgl.dylib.git': 'g',
      'osx/arm64/libextra.dylib': 'extra',
      'osx/x64/libwrong.dylib': 'wrong',
      'windows/x64/lwjgl.dll': 'dll',
    })
    const dir = nativesDirectory(path.join(root, 'versions'), '1.7.10', { jvmArch: 'arm64' })
    expect(dir).toBe(path.join(root, 'versions', '1.7.10', '1.7.10-natives-arm64'))
    const r = await extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: dir })
    expect(r.extracted).toBe(true)
    expect((await readdir(dir)).toSorted()).toEqual([NATIVES_MANIFEST, 'java', 'jna', 'libextra.dylib', 'liblwjgl.dylib', 'lwjgl', 'netty', 'openal.dylib'])
    expect(await readFile(path.join(dir, 'liblwjgl.dylib'), 'utf8')).toBe('lwjgl')
    expect((await readdir(path.dirname(dir))).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('skips extraction when the directory is verified, and re-extracts a corrupted file', async () => {
    const lwjgl = await jar('org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', { 'liblwjgl.dylib': 'lwjgl', 'openal.dylib': 'al' })
    const dir = path.join(root, 'natives')
    const opts = { librariesDir: libs(), nativesDir: dir }
    expect((await extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, opts)).extracted).toBe(true)
    const before = (await stat(path.join(dir, 'liblwjgl.dylib'))).mtimeMs
    // LWJGL 3.3 writes into the directory at run time; those files are left alone.
    await writeFile(path.join(dir, 'runtime.dylib'), 'r')
    const again = await extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, opts)
    expect(again.extracted).toBe(false)
    expect((await stat(path.join(dir, 'liblwjgl.dylib'))).mtimeMs).toBe(before)
    expect(again.files.map((f) => path.basename(f)).toSorted()).toEqual(['liblwjgl.dylib', 'openal.dylib'])

    await writeFile(path.join(dir, 'openal.dylib'), 'xx')
    const repaired = await extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, opts)
    expect(repaired.extracted).toBe(true)
    expect(await readFile(path.join(dir, 'openal.dylib'), 'utf8')).toBe('al')
  })

  it('rebuilds the directory when the library set changes, so stale dylibs disappear', async () => {
    const x86 = await jar('org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', { 'liblwjgl.dylib': 'x86', 'stale-only-in-x86.dylib': 's' }, 'a')
    const dir = path.join(root, 'natives')
    await extractNatives({ extract: [x86], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: dir })
    const arm = await jar('dev.wynn.amethyst.natives:lwjgl-platform:2.9.1:natives-macos-arm64', { 'liblwjgl.dylib': 'arm' }, 'b')
    const r = await extractNatives({ extract: [arm], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: dir })
    expect(r.extracted).toBe(true)
    expect(await readdir(dir)).not.toContain('stale-only-in-x86.dylib')
    expect(await readFile(path.join(dir, 'liblwjgl.dylib'), 'utf8')).toBe('arm')
    expect((await readdir(root)).filter((n) => n.includes('.old-') || n.includes('.tmp-'))).toEqual([])
  })

  it('handles concurrent extraction of the same set', async () => {
    const lwjgl = await jar('org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', { 'liblwjgl.dylib': 'lwjgl' })
    const opts = { librariesDir: libs(), nativesDir: path.join(root, 'natives') }
    const results = await Promise.all([1, 2, 3].map(() => extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, opts)))
    expect(results.every((r) => r.files.length === 1)).toBe(true)
    expect(await readFile(path.join(root, 'natives', 'liblwjgl.dylib'), 'utf8')).toBe('lwjgl')
  })

  it('creates an empty natives directory for versions without old-style natives', async () => {
    const dir = path.join(root, 'n')
    const r = await extractNatives({ extract: [], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: dir })
    expect(r.files).toEqual([])
    expect((await readdir(dir)).toSorted()).toEqual([NATIVES_MANIFEST, 'java', 'jna', 'lwjgl', 'netty'])
  })

  it('aggregates failures into one ENATIVES_EXTRACT error and leaves no partial directory', async () => {
    const good = await jar('a.b:good:1:natives-osx', { 'libgood.dylib': 'g' })
    const missing: ResolvedLibrary = { ...good, name: 'a.b:missing:1:natives-osx', download: { path: 'nope.jar', url: '' } }
    await writeFile(path.join(libs(), 'corrupt.jar'), 'not a zip')
    const corrupt: ResolvedLibrary = { ...good, name: 'a.b:corrupt:1:natives-osx', download: { path: 'corrupt.jar', url: '' } }
    const dir = path.join(root, 'natives')
    const e = await extractNatives({ extract: [good, missing, corrupt], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: dir }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'ENATIVES_EXTRACT' })
    expect((e as { details: { failures: { library: string }[] } }).details.failures.map((f) => f.library)).toEqual(['a.b:missing:1:natives-osx', 'a.b:corrupt:1:natives-osx'])
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('stops on abort', async () => {
    const lwjgl = await jar('org.lwjgl.lwjgl:lwjgl-platform:2.9.1:natives-osx', { 'liblwjgl.dylib': 'lwjgl' })
    const c = new AbortController()
    c.abort()
    await expect(extractNatives({ extract: [lwjgl], jvmArch: 'arm64' }, { librariesDir: libs(), nativesDir: path.join(root, 'n'), signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
