import { execFile } from 'node:child_process'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTar, makeTarGz, paxRecord, put, sha1, tempDir, type TarSpec } from './__fixtures__/helpers'
import { checkLinkTarget, extractTar, extractTarGz, safeSegments } from './tar'

let dir: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ dir, cleanup } = await tempDir())
  dir = await realpath(dir)
})
afterEach(() => cleanup())

async function* chunks(buf: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

const extract = (entries: TarSpec[], options = {}) => extractTar(chunks(makeTar(entries)), join(dir, 'out'), options)

describe('extractTar', () => {
  it('extracts files, directories, modes, symlinks and hard links from a chunked stream', async () => {
    const big = Buffer.alloc(5000, 7)
    const result = await extract(
      [
        { name: 'top/', type: '5' },
        { name: 'top/Contents/Home/bin/', type: '5' },
        { name: 'top/Contents/Home/bin/java', content: 'java', mode: 0o4755 },
        { name: 'top/Contents/Home/legal/java.base/LICENSE', content: 'GPL' },
        { name: 'top/Contents/Home/legal/java.xml/LICENSE', type: '2', linkname: '../java.base/LICENSE' },
        { name: 'top/bin', type: '2', linkname: 'Contents/Home/bin' },
        { name: 'top/Contents/Home/lib/modules', content: big },
        { name: 'top/Contents/Home/lib/modules2', type: '1', linkname: 'top/Contents/Home/lib/modules' },
        { name: 'top/dev', type: '3' },
      ],
      { hash: true },
    )
    const out = join(dir, 'out')
    expect(await readFile(join(out, 'top/Contents/Home/bin/java'), 'utf8')).toBe('java')
    expect((await stat(join(out, 'top/Contents/Home/bin/java'))).mode & 0o7777).toBe(0o755) // setuid stripped
    expect(await readlink(join(out, 'top/Contents/Home/legal/java.xml/LICENSE'))).toBe('../java.base/LICENSE')
    expect(await readFile(join(out, 'top/bin/java'), 'utf8')).toBe('java')
    expect((await stat(join(out, 'top/Contents/Home/lib/modules2'))).ino).toBe((await stat(join(out, 'top/Contents/Home/lib/modules'))).ino)
    expect(result.bytes).toBe(4 + 3 + 5000)
    expect(result.skipped).toEqual(['top/dev'])
    expect(result.entries.find((e) => e.path === 'top/Contents/Home/lib/modules')).toMatchObject({ type: 'file', size: 5000, sha1: sha1(big) })
  })

  it('supports GNU long names, pax paths and strip-components', async () => {
    const long = `${'a'.repeat(80)}/${'b'.repeat(80)}/file.txt`
    const pax = paxRecord('path', 'pax/ünïcode name.txt')
    await extract(
      [
        { name: '././@LongLink', type: 'L', content: `${long}\0` },
        { name: 'truncated', content: 'long' },
        { name: 'PaxHeader', type: 'x', content: pax },
        { name: 'ignored', content: 'pax' },
        { name: 'shallow.txt', content: 'skipped by strip' },
      ],
      { strip: 0 },
    )
    expect(await readFile(join(dir, 'out', long), 'utf8')).toBe('long')
    expect(await readFile(join(dir, 'out', 'pax/ünïcode name.txt'), 'utf8')).toBe('pax')

    const r = await extractTar(chunks(makeTar([{ name: 'x/y/z.txt', content: 'z' }, { name: 'x/top.txt', content: 't' }, { name: 'root.txt', content: 'r' }])), join(dir, 'strip'), { strip: 1 })
    expect(await readFile(join(dir, 'strip', 'y/z.txt'), 'utf8')).toBe('z')
    expect(await readFile(join(dir, 'strip', 'top.txt'), 'utf8')).toBe('t')
    expect(r.skipped).toEqual(['root.txt'])
  })

  it.each([
    ['parent traversal', [{ name: '../evil', content: 'x' }]],
    ['nested traversal', [{ name: 'a/../../evil', content: 'x' }]],
    ['absolute path', [{ name: '/tmp/evil', content: 'x' }]],
    ['absolute symlink', [{ name: 'link', type: '2', linkname: '/etc/passwd' }]],
    ['escaping symlink', [{ name: 'a/link', type: '2', linkname: '../../outside' }]],
    ['".." after a name', [{ name: 'dot', type: '2', linkname: '.' }, { name: 'up', type: '2', linkname: 'dot/..' }]],
    ['write through a symlink', [{ name: 'sub/', type: '5' }, { name: 'link', type: '2', linkname: 'sub' }, { name: 'link/file', content: 'x' }]],
  ] as [string, TarSpec[]][])('rejects %s', async (_, entries) => {
    await expect(extract(entries)).rejects.toMatchObject({ code: 'EUNSAFEPATH' })
    await expect(lstat(join(dir, 'evil'))).rejects.toThrow(/ENOENT/)
  })

  it('rejects hard links to unknown entries, bad checksums and truncation', async () => {
    await expect(extract([{ name: 'h', type: '1', linkname: 'etc/passwd' }])).rejects.toMatchObject({ code: 'EBADARCHIVE' })
    await expect(extract([{ name: 'f', content: 'x', badChecksum: true }])).rejects.toMatchObject({ code: 'EBADARCHIVE' })
    const tar = makeTar([{ name: 'f', content: Buffer.alloc(2000, 1) }], { terminate: false })
    await expect(extractTar(chunks(tar.subarray(0, 1200)), join(dir, 't'))).rejects.toMatchObject({ code: 'EBADARCHIVE' })
    // A stream that just ends after complete entries (no zero blocks) is accepted.
    await expect(extractTar(chunks(tar), join(dir, 'u'))).resolves.toMatchObject({ bytes: 2000 })
  })

  it('replaces an earlier symlink with a file instead of writing through it', async () => {
    await put(join(dir, 'victim'), 'keep')
    await extract([
      { name: 'x', type: '2', linkname: 'y' },
      { name: 'x', content: 'file' },
    ])
    expect((await lstat(join(dir, 'out', 'x'))).isFile()).toBe(true)
    expect(await readFile(join(dir, 'victim'), 'utf8')).toBe('keep')
  })

  it('enforces size and entry limits and cancellation', async () => {
    await expect(extract([{ name: 'big', content: Buffer.alloc(4096) }], { maxBytes: 1000 })).rejects.toMatchObject({ code: 'EBADARCHIVE' })
    await expect(extract([{ name: 'a', content: '1' }, { name: 'b', content: '2' }], { maxEntries: 1 })).rejects.toMatchObject({ code: 'EBADARCHIVE' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(extract([{ name: 'a', content: '1' }], { signal: controller.signal })).rejects.toThrow('cancelled')
  })
})

describe('extractTarGz', () => {
  it('extracts a gzip file and maps zlib errors', async () => {
    await put(join(dir, 'a.tar.gz'), makeTarGz([{ name: 'pkg/bin/java', content: '#!/bin/sh', mode: 0o755 }]))
    await extractTarGz(join(dir, 'a.tar.gz'), join(dir, 'a'))
    expect(await readFile(join(dir, 'a/pkg/bin/java'), 'utf8')).toBe('#!/bin/sh')
    await put(join(dir, 'bad.tar.gz'), Buffer.concat([makeTarGz([{ name: 'x', content: 'y' }]).subarray(0, 20), Buffer.alloc(40, 9)]))
    await expect(extractTarGz(join(dir, 'bad.tar.gz'), join(dir, 'b'))).rejects.toMatchObject({ code: 'EBADARCHIVE' })
  })

  it('reads archives produced by the system tar (pax headers, long paths, links)', async () => {
    const src = join(dir, 'src')
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}`
    await put(join(src, 'pkg', deep, 'file.txt'), 'deep')
    await put(join(src, 'pkg/Contents/Home/bin/java'), 'bin', 0o755)
    const { symlink } = await import('node:fs/promises')
    await symlink('Contents/Home/bin', join(src, 'pkg/bin'))
    await promisify(execFile)('tar', ['-czf', join(dir, 'sys.tar.gz'), '-C', src, 'pkg'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    await extractTarGz(join(dir, 'sys.tar.gz'), join(dir, 'sys'), { strip: 1 })
    expect(await readFile(join(dir, 'sys', deep, 'file.txt'), 'utf8')).toBe('deep')
    expect(await readlink(join(dir, 'sys/bin'))).toBe('Contents/Home/bin')
    expect((await stat(join(dir, 'sys/Contents/Home/bin/java'))).mode & 0o777).toBe(0o755)
  })
})

describe('path rules', () => {
  it('normalises safe names', () => {
    expect(safeSegments('./a//b/./c')).toEqual(['a', 'b', 'c'])
    expect(() => safeSegments('a\0b')).toThrow(/unsafe path/)
  })

  it('accepts only leading ".." that stays inside', () => {
    expect(() => checkLinkTarget('../java.base/LICENSE', 1, 'legal/x/LICENSE')).not.toThrow()
    expect(() => checkLinkTarget('../../a', 2, 'p/q/r')).not.toThrow()
    expect(() => checkLinkTarget('../../a', 1, 'p/r')).toThrow(/escapes/)
    expect(() => checkLinkTarget('a/../b', 3, 'p')).toThrow(/after a name/)
    expect(() => checkLinkTarget('', 0, 'p')).toThrow(/unsafe symlink/)
  })
})
