import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CancelledError, createTask, type TaskContext } from '@amethyst/task'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytes, serveBytes, sha, startServer, type TestServer } from './__fixtures__/server'
import { createHttpClient, download, DownloadError, downloadMany, type DownloadItem, type DownloadOptions, type HttpClient } from './index'

let server: TestServer
let client: HttpClient
let dir: string
let opts: DownloadOptions

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

beforeAll(async () => {
  server = await startServer()
  client = createHttpClient({ retry: { baseDelayMs: 1, maxDelayMs: 5 } })
  opts = { client, retry: { baseDelayMs: 1, maxDelayMs: 5 } }
})

afterAll(async () => {
  await client.close()
  await server.close()
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amethyst-net-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Run `download` in a task that cancels itself once `abortAt` bytes have been received. */
function downloadAndCancelAt(item: DownloadItem, abortAt: number, extra: DownloadOptions = {}) {
  const task = createTask('dl', (ctx) => {
    const watched: TaskContext = {
      ...ctx,
      update(progress, total, message) {
        ctx.update(progress, total, message)
        if (progress >= abortAt) task.cancel('test abort')
      },
    }
    return download(item, { ...opts, ...extra, ctx: watched })
  })
  return task.promise
}

describe('download', () => {
  it('downloads, verifies and renames into place', async () => {
    const data = bytes(300_000)
    server.route('/basic.bin', serveBytes(data))
    const dest = join(dir, 'nested/deeper/basic.bin')
    const result = await download(
      { url: `${server.url}/basic.bin`, dest, size: data.length, checksum: { algorithm: 'sha1', value: sha('sha1', data) } },
      opts,
    )
    expect(result).toMatchObject({ path: dest, skipped: false, bytes: data.length })
    expect((await readFile(dest)).equals(data)).toBe(true)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('fails with ECHECKSUM and leaves no file behind', async () => {
    const data = bytes(10_000)
    server.route('/corrupt.bin', serveBytes(data))
    const dest = join(dir, 'corrupt.bin')
    const error = await download({ url: `${server.url}/corrupt.bin`, dest, checksum: { algorithm: 'sha256', value: 'ab'.repeat(32) } }, opts).catch(
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'ECHECKSUM', algorithm: 'sha256', actual: sha('sha256', data) })
    expect(await exists(dest)).toBe(false)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('resumes a .part file with Range and If-Range', async () => {
    const data = bytes(400_000, 2)
    server.route('/resume.bin', serveBytes(data, { stallAfter: 150_000 }))
    const dest = join(dir, 'resume.bin')
    const item: DownloadItem = { url: `${server.url}/resume.bin`, dest, size: data.length, checksum: { algorithm: 'sha512', value: sha('sha512', data) } }

    await expect(downloadAndCancelAt(item, 150_000, { resume: { minBytes: 1024 } })).rejects.toBeInstanceOf(CancelledError)
    expect((await stat(`${dest}.part`)).size).toBe(150_000)
    expect(await exists(`${dest}.part.json`)).toBe(true)

    server.route('/resume.bin', serveBytes(data))
    const result = await download(item, { ...opts, resume: { minBytes: 1024 } })
    const last = server.hits('/resume.bin').at(-1)
    expect(last?.headers.range).toBe('bytes=150000-')
    expect(last?.headers['if-range']).toBe(`"${sha('sha1', data)}"`)
    expect(result.bytes).toBe(data.length - 150_000)
    expect((await readFile(dest)).equals(data)).toBe(true)
    expect(await exists(`${dest}.part.json`)).toBe(false)
  })

  it('starts over when the server ignores Range', async () => {
    const data = bytes(200_000, 3)
    server.route('/norange.bin', serveBytes(data, { ranges: false, stallAfter: 80_000 }))
    const dest = join(dir, 'norange.bin')
    const item: DownloadItem = { url: `${server.url}/norange.bin`, dest, checksum: { algorithm: 'sha1', value: sha('sha1', data) } }
    await expect(downloadAndCancelAt(item, 80_000, { resume: { minBytes: 1024 } })).rejects.toBeInstanceOf(CancelledError)
    expect((await stat(`${dest}.part`)).size).toBe(80_000)

    server.route('/norange.bin', serveBytes(data, { ranges: false }))
    const result = await download(item, { ...opts, resume: { minBytes: 1024 } })
    expect(server.hits('/norange.bin').at(-1)?.headers.range).toBe('bytes=80000-')
    expect(result.bytes).toBe(data.length)
    expect((await readFile(dest)).equals(data)).toBe(true)
  })

  it('retries 503 responses', async () => {
    const data = bytes(1000, 4)
    let n = 0
    const serve = serveBytes(data)
    server.route('/busy.bin', (req, res) => {
      if (++n <= 2) {
        res.statusCode = 503
        res.end()
        return
      }
      return serve(req, res)
    })
    await download({ url: `${server.url}/busy.bin`, dest: join(dir, 'busy.bin'), size: data.length }, opts)
    expect(n).toBe(3)
  })

  it('does not retry 404', async () => {
    const dest = join(dir, 'missing.bin')
    await expect(download({ url: `${server.url}/does-not-exist.bin`, dest }, opts)).rejects.toMatchObject({ code: 'EHTTP', status: 404 })
    expect(server.hits('/does-not-exist.bin')).toHaveLength(1)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('falls back to the next mirror', async () => {
    const data = bytes(5000, 5)
    server.route('/mirror-b/file.bin', serveBytes(data))
    const result = await download(
      {
        url: [`${server.url}/mirror-a/file.bin`, `${server.url}/mirror-b/file.bin`],
        dest: join(dir, 'file.bin'),
        checksum: { algorithm: 'sha1', value: sha('sha1', data) },
      },
      opts,
    )
    expect(result.url).toBe(`${server.url}/mirror-b/file.bin`)
    expect(server.hits('/mirror-a/file.bin')).toHaveLength(1)
  })

  it('aborts mid-stream and cleans up', async () => {
    const data = bytes(100_000, 6)
    server.route('/stall.bin', serveBytes(data, { stallAfter: 30_000 }))
    const dest = join(dir, 'stall.bin')
    const controller = new AbortController()
    const promise = download({ url: `${server.url}/stall.bin`, dest, size: data.length }, { ...opts, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('user cancelled')), 50)
    await expect(promise).rejects.toThrow('user cancelled')
    expect(await exists(dest)).toBe(false)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('downloads large files in parallel segments', async () => {
    const data = bytes(3 * 1024 * 1024 + 123, 7)
    server.route('/large.bin', serveBytes(data))
    const dest = join(dir, 'large.bin')
    const before = server.hits('/large.bin').length
    await download(
      { url: `${server.url}/large.bin`, dest, checksum: { algorithm: 'sha256', value: sha('sha256', data) } },
      { ...opts, segments: { threshold: 1024 * 1024, parts: 4 } },
    )
    const hits = server.hits('/large.bin').slice(before)
    expect(hits).toHaveLength(4)
    expect(hits.filter((h) => h.headers.range).map((h) => h.headers.range)).toHaveLength(3)
    expect(sha('sha256', await readFile(dest))).toBe(sha('sha256', data))
  })

  it('falls back to one stream when ranged sub-requests are not honoured', async () => {
    const data = bytes(2 * 1024 * 1024, 8)
    server.route('/liar.bin', serveBytes(data, { lieAboutRanges: true }))
    const dest = join(dir, 'liar.bin')
    await download(
      { url: `${server.url}/liar.bin`, dest, size: data.length, checksum: { algorithm: 'sha1', value: sha('sha1', data) } },
      { ...opts, segments: { threshold: 1024 * 1024, parts: 4 } },
    )
    const hits = server.hits('/liar.bin')
    expect(hits.some((h) => h.headers.range)).toBe(true)
    expect(hits.at(-1)?.headers.range).toBeUndefined()
    expect((await readFile(dest)).equals(data)).toBe(true)
  })

  it('resumes within the same call when the connection drops mid-body', async () => {
    const data = bytes(120_000, 12)
    const serve = serveBytes(data)
    let n = 0
    server.route('/drop.bin', (req, res) => {
      if (++n > 1) return serve(req, res)
      res.setHeader('etag', `"${sha('sha1', data)}"`)
      res.setHeader('accept-ranges', 'bytes')
      res.setHeader('content-length', data.length)
      res.write(data.subarray(0, 50_000), () => setTimeout(() => res.destroy(), 20))
    })
    const dest = join(dir, 'drop.bin')
    const result = await download(
      { url: `${server.url}/drop.bin`, dest, size: data.length, checksum: { algorithm: 'sha1', value: sha('sha1', data) } },
      { ...opts, resume: { minBytes: 1024 } },
    )
    expect(server.hits('/drop.bin').at(-1)?.headers.range).toBe('bytes=50000-')
    // 50 000 bytes before the drop plus the 70 000-byte tail: nothing was downloaded twice.
    expect(result.bytes).toBe(data.length)
    expect((await readFile(dest)).equals(data)).toBe(true)
  })

  it('gives up on a URL that stops sending, with ESTALLED, and tries the next mirror', async () => {
    const data = bytes(64 * 1024, 41)
    server.route('/stall-body', serveBytes(data, { stallAfter: 1000, ranges: false }))
    server.route('/stall-good', serveBytes(data))
    const dest = join(dir, 'stall.bin')
    const started = Date.now()
    const r = await download(
      { url: [`${server.url}/stall-body`, `${server.url}/stall-good`], dest, size: data.length, checksum: { algorithm: 'sha1', value: sha('sha1', data) } },
      { ...opts, stallTimeoutMs: 300 },
    )
    expect(r.url).toBe(`${server.url}/stall-good`)
    // The 10 s body timeout (times its continuations) never had to fire.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await readFile(dest)).toEqual(data)
  })

  it('fails a host that accepts connections but never answers within the stall limit', async () => {
    server.route('/silent', () => new Promise(() => {}))
    const started = Date.now()
    const error = await download({ url: `${server.url}/silent`, dest: join(dir, 'silent.bin') }, { ...opts, stallTimeoutMs: 300 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'ESTALLED' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await exists(join(dir, 'silent.bin.part'))).toBe(false)
  })

  it('does not count retry waits (Retry-After) as stalling', async () => {
    let n = 0
    const data = bytes(2048, 42)
    server.route('/retry-after', (req, res) => {
      if (++n === 1) {
        res.statusCode = 503
        res.setHeader('retry-after', '1')
        res.end()
        return
      }
      serveBytes(data)(req, res)
    })
    const r = await download({ url: `${server.url}/retry-after`, dest: join(dir, 'ra.bin'), size: data.length }, { ...opts, stallTimeoutMs: 400 })
    expect(r.skipped).toBe(false)
    expect(n).toBe(2)
  })

  it('skips files that are already valid', async () => {
    const data = bytes(4096, 9)
    server.route('/skip.bin', serveBytes(data))
    const dest = join(dir, 'skip.bin')
    const url = `${server.url}/skip.bin`
    await writeFile(dest, data)
    const before = server.hits('/skip.bin').length

    expect(await download({ url, dest, checksum: { algorithm: 'sha1', value: sha('sha1', data) } }, opts)).toMatchObject({ skipped: true })
    expect(await download({ url, dest, size: data.length }, opts)).toMatchObject({ skipped: true })
    expect(server.hits('/skip.bin').length).toBe(before)

    // Same size, wrong content: 'trust-size' keeps it, 'verify' repairs it.
    const wrong = bytes(4096, 10)
    await writeFile(dest, wrong)
    const item = { url, dest, size: data.length, checksum: { algorithm: 'sha1' as const, value: sha('sha1', data) } }
    expect(await download(item, { ...opts, existing: 'trust-size' })).toMatchObject({ skipped: true })
    expect(await download(item, opts)).toMatchObject({ skipped: false })
    expect((await readFile(dest)).equals(data)).toBe(true)

    // No checksum and no size: nothing to verify against, so it is downloaded again.
    expect(await download({ url, dest }, opts)).toMatchObject({ skipped: false })
    expect(await download({ url, dest, size: data.length }, { ...opts, existing: 'replace' })).toMatchObject({ skipped: false })
  })

  it('shares one transfer between concurrent calls for the same path', async () => {
    const data = bytes(50_000, 11)
    server.route('/shared.bin', serveBytes(data, { delayMs: 20 }))
    const dest = join(dir, 'shared.bin')
    const before = server.hits('/shared.bin').length
    const item = { url: `${server.url}/shared.bin`, dest, checksum: { algorithm: 'sha1' as const, value: sha('sha1', data) } }
    const [a, b] = await Promise.all([download(item, opts), download(item, opts)])
    expect([a.skipped, b.skipped].toSorted()).toEqual([false, true])
    expect(server.hits('/shared.bin').length - before).toBe(1)
    const [replaced, conflicting] = await Promise.allSettled([
      download(item, { ...opts, existing: 'replace' }),
      download({ ...item, checksum: { algorithm: 'sha1', value: '00' } }, opts),
    ])
    expect(replaced.status).toBe('fulfilled')
    expect(conflicting).toMatchObject({ status: 'rejected', reason: { code: 'ECONFLICT' } })
  })
})

describe('download: integrity and failure regressions', () => {
  it('never touches an existing file until the replacement is verified', async () => {
    const good = bytes(20_000, 400)
    const fresh = bytes(20_000, 401)
    const dest = join(dir, 'lib.jar')
    await writeFile(dest, good)
    // Checksum mismatch on the new bytes, then a 404, then 'replace' with a broken mirror.
    server.route('/regress/wrong.jar', serveBytes(bytes(20_000, 402)))
    const item = { dest, size: fresh.length, checksum: { algorithm: 'sha1' as const, value: sha('sha1', fresh) } }
    await expect(download({ ...item, url: `${server.url}/regress/wrong.jar` }, opts)).rejects.toMatchObject({ code: 'ECHECKSUM' })
    await expect(download({ ...item, url: `${server.url}/regress/missing.jar` }, opts)).rejects.toMatchObject({ status: 404 })
    await expect(download({ url: `${server.url}/regress/missing.jar`, dest }, { ...opts, existing: 'replace' })).rejects.toMatchObject({ status: 404 })
    expect((await readFile(dest)).equals(good)).toBe(true)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('rejects an empty body unless an empty file is expected', async () => {
    server.route('/regress/empty.bin', (_req, res) => res.end())
    const url = `${server.url}/regress/empty.bin`
    const dest = join(dir, 'empty.bin')
    await expect(download({ url, dest }, opts)).rejects.toMatchObject({ code: 'EBADRESPONSE', message: expect.stringContaining('empty') })
    await expect(download({ url, dest, checksum: { algorithm: 'sha1', value: sha('sha1', bytes(10)) } }, opts)).rejects.toMatchObject({
      code: 'EBADRESPONSE',
    })
    expect(await exists(dest)).toBe(false)
    expect(await exists(`${dest}.part`)).toBe(false)
    // Explicitly expected to be empty: by size or by the empty file's digest.
    await download({ url, dest, size: 0 }, { ...opts, existing: 'replace' })
    expect((await stat(dest)).size).toBe(0)
    await download({ url, dest: join(dir, 'empty2.bin'), checksum: { algorithm: 'sha1', value: sha('sha1', Buffer.alloc(0)) } }, opts)
    expect(await exists(join(dir, 'empty2.bin'))).toBe(true)
  })

  it('rejects an HTML page served for an unhashed file', async () => {
    const page = Buffer.from('<html><body>Sign in to the Wi-Fi</body></html>')
    server.route('/regress/portal.jar', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page)
    })
    const dest = join(dir, 'portal.jar')
    await expect(download({ url: `${server.url}/regress/portal.jar`, dest }, opts)).rejects.toMatchObject({ code: 'EBADRESPONSE' })
    expect(await exists(dest)).toBe(false)
    // A matching checksum vouches for the bytes whatever the content type says.
    await download({ url: `${server.url}/regress/portal.jar`, dest, checksum: { algorithm: 'sha1', value: sha('sha1', page) } }, opts)
    expect((await readFile(dest)).equals(page)).toBe(true)
  })

  it('restarts from zero when a resumed .part turns out to be corrupt', async () => {
    const data = bytes(300_000, 403)
    server.route('/regress/stale.bin', serveBytes(data, { stallAfter: 100_000 }))
    const dest = join(dir, 'stale.bin')
    const item: DownloadItem = { url: `${server.url}/regress/stale.bin`, dest, size: data.length, checksum: { algorithm: 'sha1', value: sha('sha1', data) } }
    await expect(downloadAndCancelAt(item, 100_000, { resume: { minBytes: 1024 } })).rejects.toBeInstanceOf(CancelledError)
    // Corrupt the kept prefix (as a crash or disk error could).
    const fh = await open(`${dest}.part`, 'r+')
    await fh.write(Buffer.alloc(1000, 0xee), 0, 1000, 5000)
    await fh.close()

    server.route('/regress/stale.bin', serveBytes(data))
    const result = await download(item, { ...opts, resume: { minBytes: 1024 } })
    const hits = server.hits('/regress/stale.bin')
    expect(hits.at(-2)?.headers.range).toBe('bytes=100000-')
    expect(hits.at(-1)?.headers.range).toBeUndefined()
    expect(result.skipped).toBe(false)
    expect((await readFile(dest)).equals(data)).toBe(true)
  })

  it('does not re-request the body after a local write failure', async () => {
    const data = bytes(200_000, 404)
    server.route('/regress/nospace.bin', serveBytes(data))
    const probe = await open(join(dir, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probe) as { writev: (...args: unknown[]) => Promise<unknown> }
    await probe.close()
    const spy = vi.spyOn(proto, 'writev').mockRejectedValue(Object.assign(new Error('no space left on device'), { code: 'ENOSPC', syscall: 'write' }))
    try {
      const dest = join(dir, 'nospace.bin')
      await expect(download({ url: `${server.url}/regress/nospace.bin`, dest, size: data.length }, opts)).rejects.toMatchObject({ code: 'ENOSPC' })
      expect(server.hits('/regress/nospace.bin')).toHaveLength(1)
      expect(await exists(dest)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('serializes paths that differ only by case or Unicode normalization', async () => {
    const data = bytes(40_000, 405)
    const serve = serveBytes(data, { delayMs: 20 })
    let active = 0
    let peak = 0
    server.route('/regress/fold.jar', async (req, res) => {
      peak = Math.max(peak, ++active)
      res.on('close', () => active--)
      await serve(req, res)
    })
    const url = `${server.url}/regress/fold.jar`
    const checksum = { algorithm: 'sha1' as const, value: sha('sha1', data) }
    const names = ['Caf\u00e9.jar', 'cafe\u0301.jar', 'CAF\u00c9.jar']
    await Promise.all(names.map((n) => download({ url, dest: join(dir, n), checksum }, opts)))
    expect(peak).toBe(1)
    const written = await Promise.all(names.map((n) => readFile(join(dir, n))))
    expect(written.every((buf) => buf.equals(data))).toBe(true)
  })
})

describe('downloadMany', () => {
  it('bounds concurrency, aggregates progress and collects every failure', async () => {
    // A dedicated server so the in-flight high-water mark only reflects this batch.
    const isolated = await startServer()
    const files = Array.from({ length: 40 }, (_, i) => bytes(1000 + i * 100, 100 + i))
    for (const [i, data] of files.entries()) isolated.route(`/many/${i}.bin`, serveBytes(data, { delayMs: 5 }))
    const items: DownloadItem[] = files.map((data, i) => ({
      url: `${isolated.url}/many/${i}.bin`,
      dest: join(dir, 'many', `${i}.bin`),
      size: data.length,
      checksum: { algorithm: 'sha1', value: sha('sha1', data) },
    }))
    items.push({ url: `${isolated.url}/many/missing-1.bin`, dest: join(dir, 'many', 'missing-1.bin'), size: 10 })
    items.push({ url: `${isolated.url}/many/missing-2.bin`, dest: join(dir, 'many', 'missing-2.bin') })

    const task = createTask('assets', (ctx) => downloadMany(items, { ...opts, ctx, concurrency: 4 }))
    const error = await task.promise.catch((e: unknown) => e)
    await isolated.close()

    expect(error).toBeInstanceOf(DownloadError)
    const err = error as DownloadError
    expect(err.code).toBe('EDOWNLOAD')
    expect(err.failures.map((f) => f.item.dest).toSorted()).toEqual([join(dir, 'many', 'missing-1.bin'), join(dir, 'many', 'missing-2.bin')])
    expect(err.failures.every((f) => (f.error as { status?: number }).status === 404)).toBe(true)
    const total = files.reduce((n, f) => n + f.length, 0)
    expect(err.stats).toMatchObject({ files: 40, skipped: 0, bytes: total })
    expect(isolated.maxInFlight).toBeLessThanOrEqual(4)
    expect(isolated.maxInFlight).toBeGreaterThan(1)
    const written = await Promise.all(files.map((_, i) => readFile(join(dir, 'many', `${i}.bin`))))
    expect(written.every((buf, i) => buf.equals(files[i] as Buffer))).toBe(true)
    const snap = task.snapshot()
    expect(snap.progress).toBe(total)
    expect(snap.message).toBe('42/42 files')
  })

  it('returns throughput stats and skips valid files', async () => {
    const files = Array.from({ length: 10 }, (_, i) => bytes(2000, 200 + i))
    files.forEach((data, i) => server.route(`/stats/${i}.bin`, serveBytes(data)))
    const items: DownloadItem[] = files.map((data, i) => ({
      url: `${server.url}/stats/${i}.bin`,
      dest: join(dir, 'stats', `${i}.bin`),
      size: data.length,
    }))
    const first = await downloadMany(items.slice(0, 4), opts)
    expect(first).toMatchObject({ files: 4, skipped: 0, bytes: 8000 })
    const second = await downloadMany(items, opts)
    expect(second).toMatchObject({ files: 6, skipped: 4, bytes: 12_000 })
    expect(second.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('stops at the first failure with failFast', async () => {
    const data = bytes(1000, 300)
    server.route('/ff/slow.bin', serveBytes(data, { stallAfter: 10 }))
    const items: DownloadItem[] = [
      { url: `${server.url}/ff/slow.bin`, dest: join(dir, 'ff', 'slow.bin') },
      { url: `${server.url}/ff/missing.bin`, dest: join(dir, 'ff', 'missing.bin') },
    ]
    const error = await downloadMany(items, { ...opts, failFast: true }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DownloadError)
    expect((error as DownloadError).failures).toHaveLength(1)
    expect(await exists(join(dir, 'ff', 'slow.bin.part'))).toBe(false)
  })
})
