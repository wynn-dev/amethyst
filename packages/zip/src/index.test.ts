import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createZip, openZip, ZipError, type CreateZipOptions, type ZipReader } from './index'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'amethyst-zip-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

type Add = (w: ReturnType<typeof createZip>) => void | Promise<void>

/** Build a zip on disk with createZip and return its bytes. */
async function build(name: string, add: Add, options?: CreateZipOptions): Promise<{ file: string; bytes: Buffer }> {
  const file = path.join(tmp, name)
  const w = createZip(file, options)
  await add(w)
  await w.finish()
  return { file, bytes: await readFile(file) }
}

/** Replace every occurrence of `from` with the same-length `to` (names live in local and central headers). */
function patchName(bytes: Buffer, from: string, to: string): Buffer {
  expect(from.length).toBe(to.length)
  const out = Buffer.from(bytes)
  const needle = Buffer.from(from)
  let hits = 0
  for (let i = out.indexOf(needle); i !== -1; i = out.indexOf(needle, i + 1)) {
    out.write(to, i, 'latin1')
    hits++
  }
  expect(hits).toBeGreaterThanOrEqual(2)
  return out
}

async function withZip<T>(source: string | Uint8Array, fn: (z: ZipReader) => Promise<T>): Promise<T> {
  const z = await openZip(source)
  try {
    return await fn(z)
  } finally {
    await z.close()
  }
}

const listTree = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)) + (d.isDirectory() ? '/' : ''))
    .toSorted()

describe('createZip + openZip', () => {
  it('round-trips files and buffers with metadata', async () => {
    const src = path.join(tmp, 'source.txt')
    await writeFile(src, 'from disk\n'.repeat(1000), { mode: 0o755 })
    const json = JSON.stringify({ schemaVersion: 1, id: 'example' })
    const { file } = await build('a.zip', (w) => {
      w.addFile(src, 'bin/run.sh')
      w.addBuffer(Buffer.from(json), 'fabric.mod.json')
      w.addBuffer(Buffer.from('\ufeff{"a":1}'), 'bom.json')
      w.addBuffer(new Uint8Array([1, 2, 3]), 'assets/icon.png', { compress: false, mode: 0o600 })
      w.addBuffer(Buffer.from('ünïcödé'), 'données/ß.txt')
    })

    await withZip(file, async (z) => {
      expect(z.entryCount).toBe(5)
      const entries = await z.entries()
      expect(entries.map((e) => e.name)).toEqual(['bin/run.sh', 'fabric.mod.json', 'bom.json', 'assets/icon.png', 'données/ß.txt'])
      const run = await z.entry('bin/run.sh')
      expect(run).toMatchObject({ size: 10000, isDirectory: false, isSymlink: false, mode: 0o755 })
      expect(run!.compressedSize).toBeLessThan(10000)
      expect(run!.crc).toBe(crc32('from disk\n'.repeat(1000)))
      expect(await z.entry('assets/icon.png')).toMatchObject({ size: 3, compressedSize: 3, mode: 0o600 })

      expect(await z.has('fabric.mod.json')).toBe(true)
      expect(await z.has('missing')).toBe(false)
      expect(JSON.parse(await z.readText('fabric.mod.json'))).toEqual({ schemaVersion: 1, id: 'example' })
      expect(await z.readText('bom.json')).toBe('{"a":1}')
      expect([...(await z.readBuffer('assets/icon.png'))]).toEqual([1, 2, 3])
      expect(await z.readText('données/ß.txt')).toBe('ünïcödé')

      const chunks: Buffer[] = []
      for await (const c of await z.openStream('bin/run.sh')) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('from disk\n'.repeat(1000))
    })
  })

  it('opens archives from a buffer and reads entries concurrently', async () => {
    const { bytes } = await build('b.zip', (w) => {
      for (let i = 0; i < 20; i++) w.addBuffer(Buffer.from(`file ${i}`.repeat(100)), `f/${i}.txt`)
    })
    await withZip(new Uint8Array(bytes), async (z) => {
      const texts = await Promise.all(Array.from({ length: 20 }, (_, i) => z.readText(`f/${i}.txt`)))
      expect(texts[7]).toBe('file 7'.repeat(100))
    })
  })

  it('reads entries written with data descriptors', async () => {
    const src = path.join(tmp, 'dd.bin')
    await writeFile(src, Buffer.alloc(50_000, 7))
    const { bytes } = await build('dd.zip', (w) => w.addFile(src, 'dd.bin'))
    // Local file header: signature, version, then general purpose flags; bit 3 = data descriptor.
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50)
    expect(bytes.readUInt16LE(6) & 0x08).toBe(0x08)
    await withZip(bytes, async (z) => {
      expect((await z.readBuffer('dd.bin')).equals(Buffer.alloc(50_000, 7))).toBe(true)
    })
  })

  it('reads ZIP64 entries', async () => {
    const { bytes } = await build('z64.zip', (w) => {
      w.addBuffer(Buffer.from('big in spirit'), 'a.txt', { zip64: true })
      w.addBuffer(Buffer.from('normal'), 'b.txt')
    }, { zip64: true })
    // ZIP64 end of central directory record and locator signatures.
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true)
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true)
    await withZip(bytes, async (z) => {
      expect(await z.readText('a.txt')).toBe('big in spirit')
      expect(await z.readText('b.txt')).toBe('normal')
    })
  })

  it('accepts backslash separators from sloppy archivers', async () => {
    const { bytes } = await build('bs.zip', (w) => w.addBuffer(Buffer.from('x'), 'META-INF/mods.toml'))
    await withZip(patchName(bytes, 'META-INF/mods', 'META-INF\\mods'), async (z) => {
      expect(await z.readText('META-INF/mods.toml')).toBe('x')
    })
  })
})

describe('errors', () => {
  it('reports missing entries, size limits and closed readers', async () => {
    const { file } = await build('e.zip', (w) => w.addBuffer(Buffer.alloc(1000), 'a'))
    const z = await openZip(file)
    await expect(z.readBuffer('nope')).rejects.toMatchObject({ code: 'EZIP_NOT_FOUND' })
    await expect(z.readBuffer('a', { maxBytes: 10 })).rejects.toMatchObject({ code: 'EZIP_TOO_LARGE' })
    await z.close()
    await expect(z.entries()).rejects.toMatchObject({ code: 'EZIP_CLOSED' })
  })

  it('opens jars whose end record has a wrong comment length, as Java does (#1431)', async () => {
    const { bytes } = await build('c.jar', (w) => {
      w.addBuffer(Buffer.from('{"id":"m"}'), 'fabric.mod.json')
      w.addBuffer(Buffer.from('x'.repeat(5000)), 'big.txt')
    })
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    // Extra bytes after a zero-length comment, and a declared comment longer than the file.
    const trailing = Buffer.concat([bytes, Buffer.from('junk!')])
    const truncated = Buffer.from(bytes)
    truncated.writeUInt16LE(40, eocd + 20)
    for (const variant of [trailing, truncated]) {
      const file = path.join(tmp, `variant-${variant.length}.jar`)
      await writeFile(file, variant)
      for (const source of [file, new Uint8Array(variant)]) {
        await withZip(source, async (z) => {
          expect((await z.entries()).map((e) => e.name).toSorted()).toEqual(['big.txt', 'fabric.mod.json'])
          expect(await z.readText('fabric.mod.json')).toBe('{"id":"m"}')
          expect(await z.readText('big.txt')).toBe('x'.repeat(5000))
        })
      }
    }
  })

  it('rejects garbage as malformed and passes through fs errors', async () => {
    await expect(openZip(Buffer.from('definitely not a zip file, just text'))).rejects.toBeInstanceOf(ZipError)
    await expect(openZip(Buffer.from('definitely not a zip file, just text'))).rejects.toMatchObject({ code: 'EZIP_MALFORMED' })
    await expect(openZip(path.join(tmp, 'missing.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects corrupt entry data', async () => {
    const { bytes } = await build('c.zip', (w) => w.addBuffer(Buffer.alloc(10_000, 1), 'a'))
    // Corrupt the deflate stream right after the local header + name.
    const corrupt = Buffer.from(bytes)
    for (let i = 31; i < 45; i++) corrupt[i] = 0xff
    await withZip(corrupt, async (z) => {
      await expect(z.readBuffer('a')).rejects.toMatchObject({ code: 'EZIP_MALFORMED' })
    })
  })
})

async function sample() {
  return build('sample.zip', (w) => {
    w.addBuffer(Buffer.from('root'), 'pkg/readme.txt')
    w.addBuffer(Buffer.from('#!/bin/sh\n'), 'pkg/bin/tool', { mode: 0o755 })
    w.addBuffer(Buffer.from('lib'), 'pkg/natives/liblwjgl.dylib')
    w.addBuffer(Buffer.from('sig'), 'pkg/META-INF/MANIFEST.MF')
    w.addBuffer(Buffer.from('top'), 'top.txt')
  })
}

describe('extractTo', () => {
  it('extracts everything, creating directories and setting modes', async () => {
    const { file } = await sample()
    const out = path.join(tmp, 'out')
    const progress: number[] = []
    const result = await withZip(file, (z) => z.extractTo(out, { onProgress: (b) => progress.push(b) }))
    expect(await listTree(out)).toEqual([
      'pkg/',
      'pkg/META-INF/',
      'pkg/META-INF/MANIFEST.MF',
      'pkg/bin/',
      'pkg/bin/tool',
      'pkg/natives/',
      'pkg/natives/liblwjgl.dylib',
      'pkg/readme.txt',
      'top.txt',
    ])
    expect(result.files).toHaveLength(5)
    expect(result.bytes).toBe(4 + 10 + 3 + 3 + 3)
    expect(progress.at(-1)).toBe(result.bytes)
    expect((await stat(path.join(out, 'pkg/bin/tool'))).mode & 0o777).toBe(0o755)
    expect(await readFile(path.join(out, 'pkg/natives/liblwjgl.dylib'), 'utf8')).toBe('lib')
  })

  it('applies filter and strip', async () => {
    const { file } = await sample()
    const out = path.join(tmp, 'out')
    const seen: string[] = []
    await withZip(file, (z) =>
      z.extractTo(out, {
        strip: 1,
        filter: (e) => {
          seen.push(e.name)
          return !e.name.includes('META-INF/')
        },
      }),
    )
    // top.txt has a single component and disappears with strip: 1.
    expect(await listTree(out)).toEqual(['bin/', 'bin/tool', 'natives/', 'natives/liblwjgl.dylib', 'readme.txt'])
    expect(seen).toContain('pkg/META-INF/MANIFEST.MF')
  })

  it.each([
    ['parent traversal', 'xx/evil.txt', '../evil.txt'],
    ['nested traversal', 'a/xx/xx/e.txt', 'a/../../e.txt'],
    ['backslash traversal', 'xx/evil.txt', '..\\evil.txt'],
    ['absolute path', 'Xetc/passwd', '/etc/passwd'],
    ['drive letter', 'XX/win.txt', 'C:/win.txt'],
  ])('rejects %s before writing anything', async (_label, placeholder, hostile) => {
    const { bytes } = await build('t.zip', (w) => {
      w.addBuffer(Buffer.from('fine'), 'aaa-first.txt')
      w.addBuffer(Buffer.from('pwned'), placeholder)
    })
    const evil = patchName(bytes, placeholder, hostile)
    const out = path.join(tmp, 'deep/out')
    await withZip(evil, async (z) => {
      // Listing still works, so callers can inspect hostile archives.
      expect((await z.entries()).map((e) => e.name)).toContain(hostile.replaceAll('\\', '/'))
      await expect(z.extractTo(out)).rejects.toMatchObject({ code: 'EZIP_UNSAFE_PATH' })
      // A filter that excludes the bad entry makes the archive usable.
      await z.extractTo(path.join(tmp, 'filtered'), { filter: (e) => e.name === 'aaa-first.txt' })
    })
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(tmp, 'deep/evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listTree(path.join(tmp, 'filtered'))).toEqual(['aaa-first.txt'])
  })

  it('creates symlinks that stay inside the destination', async () => {
    const { file } = await build('ln.zip', (w) => {
      w.addBuffer(Buffer.from('real'), 'lib/real.dylib')
      w.addBuffer(Buffer.from('real.dylib'), 'lib/alias.dylib', { mode: 0o120777 })
      w.addBuffer(Buffer.from('.'), 'self', { mode: 0o120777 })
      w.addBuffer(Buffer.from('through'), 'self/via-link.txt')
    })
    const out = path.join(tmp, 'out')
    await withZip(file, async (z) => {
      expect(await z.entry('lib/alias.dylib')).toMatchObject({ isSymlink: true })
      await z.extractTo(out)
    })
    expect(await readlink(path.join(out, 'lib/alias.dylib'))).toBe('real.dylib')
    expect(await readFile(path.join(out, 'lib/alias.dylib'), 'utf8')).toBe('real')
    expect(await readFile(path.join(out, 'via-link.txt'), 'utf8')).toBe('through')
  })

  it.each([
    ['relative escape', [['link', '../outside', true]]],
    ['absolute target', [['link', '/tmp', true]]],
    [
      // Lexically a/b/c/x, but l3 points at the root so l3/.. is the root's parent.
      'escape through a symlink chain',
      [
        ['a/b/c/l3', '../../..', true],
        ['y', 'a/b/c/l3/../x', true],
      ],
    ],
  ] as const)('rejects symlinks with %s', async (_label, links) => {
    const { file } = await build('bad-ln.zip', (w) => {
      for (const [name, target] of links) w.addBuffer(Buffer.from(target), name, { mode: 0o120777 })
    })
    const out = path.join(tmp, 'out')
    await withZip(file, async (z) => {
      await expect(z.extractTo(out)).rejects.toMatchObject({ code: 'EZIP_UNSAFE_PATH' })
    })
  })

  it('never writes through a symlink that leads outside', async () => {
    // A link created before extraction (e.g. by a previous run) must not redirect writes.
    const out = path.join(tmp, 'out')
    await mkdir(path.join(tmp, 'elsewhere'))
    await mkdir(out)
    await symlink('../elsewhere', path.join(out, 'mods'))
    await symlink('../elsewhere/file.txt', path.join(out, 'file.txt'))
    const { file } = await build('w.zip', (w) => {
      w.addBuffer(Buffer.from('x'), 'file.txt')
      w.addBuffer(Buffer.from('y'), 'mods/a.jar')
    })
    await withZip(file, async (z) => {
      await expect(z.extractTo(out)).rejects.toMatchObject({ code: 'EZIP_UNSAFE_PATH' })
    })
    // The pre-existing file.txt link was replaced by a real file, not written through.
    expect((await lstat(path.join(out, 'file.txt'))).isFile()).toBe(true)
    expect(await readdir(path.join(tmp, 'elsewhere'))).toEqual([])
  })

  it('respects AbortSignal', async () => {
    const { file } = await sample()
    await withZip(file, async (z) => {
      await expect(z.extractTo(path.join(tmp, 'pre'), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })

      const controller = new AbortController()
      const out = path.join(tmp, 'mid')
      await expect(
        z.extractTo(out, { signal: controller.signal, onProgress: () => controller.abort('stop') }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(await listTree(out)).toEqual(['pkg/', 'pkg/readme.txt'])
    })
  })

  it('aborts a large entry mid-stream and removes the partial file', async () => {
    const big = Buffer.alloc(32 * 1024 * 1024, 3)
    const { file } = await build('big.zip', (w) => w.addBuffer(big, 'big.bin', { compress: false }))
    const controller = new AbortController()
    const out = path.join(tmp, 'out')
    await withZip(file, async (z) => {
      const p = z.extractTo(out, { signal: controller.signal })
      // Abort as soon as the output file exists, i.e. while it is being streamed.
      while (!(await stat(path.join(out, 'big.bin')).catch(() => undefined))) await new Promise(setImmediate)
      controller.abort()
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    })
    expect(await readdir(out)).toEqual([])
  })
})

describe('createZip', () => {
  it('validates entry paths', () => {
    const w = createZip(path.join(tmp, 'v.zip'))
    expect(() => w.addBuffer(Buffer.from(''), '../x')).toThrow(expect.objectContaining({ code: 'EZIP_UNSAFE_PATH' }))
    expect(() => w.addBuffer(Buffer.from(''), '/abs')).toThrow(ZipError)
    expect(() => w.addBuffer(Buffer.from(''), 'dir/')).toThrow(ZipError)
    return w.abort()
  })

  it('normalizes backslashes in entry paths', async () => {
    const { file } = await build('n.zip', (w) => w.addBuffer(Buffer.from('ok'), 'overrides\\config\\a.txt'))
    await withZip(file, async (z) => expect(await z.readText('overrides/config/a.txt')).toBe('ok'))
  })

  it('fails finish() and leaves no output when a source file is missing', async () => {
    const out = path.join(tmp, 'fail.zip')
    const w = createZip(out)
    w.addBuffer(Buffer.from('ok'), 'ok.txt')
    w.addFile(path.join(tmp, 'does-not-exist'), 'missing.txt')
    await expect(w.finish()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(tmp)).toEqual([])
    expect(() => w.addBuffer(Buffer.from(''), 'late.txt')).toThrow(expect.objectContaining({ code: 'EZIP_CLOSED' }))
  })

  it('abort() discards the partial archive', async () => {
    const w = createZip(path.join(tmp, 'sub/aborted.zip'))
    w.addBuffer(Buffer.alloc(1024 * 1024, 1), 'a.bin')
    await w.abort()
    expect(await readdir(tmp, { recursive: true })).toEqual(['sub'])
  })

  it('honours an AbortSignal', async () => {
    const controller = new AbortController()
    const w = createZip(path.join(tmp, 's.zip'), { signal: controller.signal })
    w.addBuffer(Buffer.alloc(1024), 'a.bin')
    controller.abort()
    await expect(w.finish()).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(tmp)).toEqual([])
  })
})
