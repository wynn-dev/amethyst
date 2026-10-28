/* oxlint-disable no-await-in-loop -- chunks are written in order (backpressure) and URLs/attempts are tried sequentially by design */
import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { type FileHandle, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { abortReason, ChecksumError, HttpError, NetError, sanitizeUrl, SizeMismatchError } from './errors'
import { hashFile, hashRange } from './hash'
import { discardBody, getDefaultHttpClient, type HttpClient, type HttpResponse, type ResponseBody } from './http'
import { backoffDelay, DEFAULT_RETRY, type RetryOptions, sleep } from './retry'
import type { Checksum, DownloadItem, DownloadOptions, DownloadResult, ExistingFilePolicy, SegmentOptions } from './types'

const MiB = 1024 * 1024
const DEFAULT_SEGMENTS: SegmentOptions = { threshold: 16 * MiB, parts: 4 }
const DEFAULT_RESUME_MIN = MiB
/** Continuations (resume or restart) per URL after a failure while the body was streaming. */
const MAX_CONTINUATIONS = 5
/** Chunks are batched into one positional `writev` once this many bytes are pending. */
const WRITE_BATCH = 64 * 1024
/** Files at least this large are fsynced before the rename. */
const SYNC_MIN_BYTES = MiB
/** Default {@link DownloadOptions.stallTimeoutMs}. */
const DEFAULT_STALL_MS = 30_000

/** Receives byte progress for one item (internal; `downloadMany` aggregates it). */
export interface ProgressSink {
  /** Bytes on disk changed by `delta` (negative when a partial file is discarded). */
  progress(delta: number): void
  /** The size of an item without `size` became known from the response headers. */
  total(bytes: number): void
}

/** Sidecar stored next to a resumable `.part` file. */
interface PartMeta {
  v: 1
  url: string
  etag?: string
  lastModified?: string
  size?: number
  checksum?: Checksum
}

interface Job {
  item: DownloadItem
  dest: string
  part: string
  meta: string
  client: HttpClient
  /** The caller's signal, or (while a URL is being tried) that combined with its stall watchdog. */
  signal: AbortSignal | undefined
  sink: ProgressSink | undefined
  /** Abort a URL after this long without a response or a body byte (0: never). */
  stallMs: number
  /** When the current URL last made progress (a response arrived or bytes were received). */
  lastProgressAt: number
  /** Backoff for continuations after body failures. */
  retry: RetryOptions
  /** Per-call retry override passed to the client (undefined keeps the client's policy). */
  retryOverride: Partial<RetryOptions> | undefined
  segments: SegmentOptions | false
  resumeMin: number
  /** Bytes reported to the sink so far. */
  counted: number
  /** Bytes received from the network over all attempts. */
  bytes: number
  totalReported: boolean
  /** Whether `<dest>.part.json` exists, i.e. the partial is worth keeping for a later resume. */
  metaOnDisk: boolean
}

/** Server could not honour a range request: restart this URL from zero, once. */
class RangeRestart extends NetError {
  override name = 'RangeRestartError'
  constructor(url: string, detail: string) {
    super('EBADRESPONSE', `range request not honoured by ${sanitizeUrl(url)}: ${detail}`, sanitizeUrl(url))
  }
}

/** Errors raised while a body was streaming; these get resumed or restarted on the same URL. */
const bodyErrors = new WeakSet<object>()
/** Local write failures (ENOSPC, EACCES, ...): re-requesting the body cannot fix them, so they are never continued. */
const diskErrors = new WeakSet<object>()
function bodyError(e: unknown): unknown {
  if (typeof e === 'object' && e !== null && !diskErrors.has(e)) bodyErrors.add(e)
  return e
}

/** In-flight downloads by {@link pathSlot}; `dest` is the exact resolved path. */
const inflight = new Map<string, { dest: string; key: string; promise: Promise<DownloadResult> }>()

/**
 * APFS is normalization-insensitive and (by default) case-insensitive, so `Foo.jar`, `foo.jar` and
 * an NFD spelling can name one file. Such paths share a slot and are serialized, so two transfers
 * never write the same `.part` at once.
 */
function pathSlot(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/**
 * Download one file to `item.dest`.
 *
 * Bytes stream to `<dest>.part` while being hashed, then the length and checksum are verified and
 * the file is atomically renamed into place, so `dest` only ever holds a complete, verified file.
 * URLs are tried in order. Transient HTTP and network errors are retried with backoff; a body that
 * breaks mid-stream is resumed with `Range` when the server allows it. Large files are split into
 * parallel ranges (see {@link DownloadOptions.segments}).
 *
 * An existing destination is handled per {@link ExistingFilePolicy}. Concurrent calls for the same
 * destination share one transfer (`ECONFLICT` if their checksums or sizes disagree).
 *
 * Throws the last URL's error ({@link HttpError}, {@link ChecksumError}, {@link SizeMismatchError},
 * a network error) or the abort reason. Partial files are removed, except resumable ones (see
 * {@link DownloadOptions.resume}).
 */
export async function download(item: DownloadItem, options: DownloadOptions = {}): Promise<DownloadResult> {
  const ctx = options.ctx
  let sink: ProgressSink | undefined
  if (ctx) {
    let done = 0
    let total = item.size ?? 0
    sink = {
      progress(delta) {
        done += delta
        ctx.update(done, total)
      },
      total(bytes) {
        total = bytes
        ctx.update(done, total)
      },
    }
    if (total > 0) ctx.update(0, total)
  }
  return downloadItem(item, { ...options, signal: anySignal(options.signal, ctx?.signal) }, sink)
}

/** Combine two optional signals. */
export function anySignal(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a && b && a !== b) return AbortSignal.any([a, b])
  return a ?? b
}

/** {@link download} with an explicit progress sink and an already combined signal. */
export async function downloadItem(item: DownloadItem, options: DownloadOptions, sink?: ProgressSink): Promise<DownloadResult> {
  const signal = options.signal
  if (signal?.aborted) throw abortReason(signal)
  const urls = typeof item.url === 'string' ? [item.url] : [...item.url]
  if (urls.length === 0) throw new TypeError(`no URL given for ${item.dest}`)
  const dest = resolve(item.dest)
  const key = item.checksum ? `${item.checksum.algorithm}:${item.checksum.value.toLowerCase()}` : `size:${item.size ?? '?'}`

  const slot = pathSlot(dest)
  for (let other = inflight.get(slot); other; other = inflight.get(slot)) {
    if (other.dest !== dest) {
      // Same file on a case/normalization-insensitive volume (or a distinct one on a sensitive volume):
      // wait for it, then run ourselves (the existing-file check skips it if it is already valid).
      await untilAborted(other.promise.catch(() => undefined), signal)
      continue
    }
    if (other.key !== key) throw new NetError('ECONFLICT', `${dest} is already being downloaded with a different checksum or size`)
    try {
      const r = await untilAborted(other.promise, signal)
      return { path: dest, skipped: true, bytes: 0, url: r.url }
    } catch {
      // The other transfer failed (maybe it was cancelled by its own task): try ourselves.
      if (signal?.aborted) throw abortReason(signal)
    }
  }

  const segments = options.segments === false ? false : { ...DEFAULT_SEGMENTS, ...options.segments }
  const job: Job = {
    item,
    dest,
    part: `${dest}.part`,
    meta: `${dest}.part.json`,
    client: options.client ?? getDefaultHttpClient(),
    signal,
    sink,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    retryOverride: options.retry,
    segments: segments && segments.parts > 1 ? segments : false,
    resumeMin: options.resume === false ? Number.POSITIVE_INFINITY : (options.resume?.minBytes ?? DEFAULT_RESUME_MIN),
    counted: 0,
    bytes: 0,
    totalReported: false,
    metaOnDisk: false,
    stallMs: options.stallTimeoutMs ?? DEFAULT_STALL_MS,
    lastProgressAt: 0,
  }
  const promise: Promise<DownloadResult> = run(job, urls, item.existing ?? options.existing ?? 'verify').finally(() => {
    if (inflight.get(slot)?.promise === promise) inflight.delete(slot)
  })
  inflight.set(slot, { dest, key, promise })
  return promise
}

async function run(job: Job, urls: string[], policy: ExistingFilePolicy): Promise<DownloadResult> {
  const { item, signal } = job
  if (policy !== 'replace' && (await isValid(job.dest, item, policy, signal))) {
    return { path: job.dest, skipped: true, bytes: 0 }
  }
  await mkdir(dirname(job.dest), { recursive: true })
  let lastError: unknown
  try {
    for (const url of urls) {
      try {
        return await fromUrl(job, url)
      } catch (e) {
        if (signal?.aborted) throw abortReason(signal)
        lastError = e
      }
    }
    throw lastError
  } catch (e) {
    setProgress(job, 0)
    if (!job.metaOnDisk) await rm(job.part, { force: true }).catch(() => {})
    throw e
  }
}

/** Whether an existing destination can be kept, per policy. I/O errors other than ENOENT propagate. */
async function isValid(path: string, item: DownloadItem, policy: ExistingFilePolicy, signal?: AbortSignal): Promise<boolean> {
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return false
    size = st.size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
  if (item.size !== undefined && size !== item.size) return false
  if (policy === 'trust-size' && item.size !== undefined) return true
  if (item.checksum) return (await hashFile(path, item.checksum.algorithm, signal)) === item.checksum.value.toLowerCase()
  return item.size !== undefined
}

/**
 * One URL, under a no-progress watchdog: a host that accepts connections but never answers, or
 * stops sending mid-body, would otherwise take every timeout times every retry (minutes) before
 * the next mirror is tried. After `stallMs` without a response or a body byte the URL fails with
 * `ESTALLED`.
 */
async function fromUrl(job: Job, url: string): Promise<DownloadResult> {
  if (job.stallMs <= 0) return tryUrl(job, url)
  const outer = job.signal
  const watchdog = new AbortController()
  job.lastProgressAt = Date.now()
  const tick = Math.max(10, Math.min(1000, Math.floor(job.stallMs / 4)))
  const timer = setInterval(() => {
    if (Date.now() - job.lastProgressAt >= job.stallMs) {
      watchdog.abort(new NetError('ESTALLED', `no progress from ${sanitizeUrl(url)} for ${Math.round(job.stallMs / 1000)} s`, sanitizeUrl(url)))
    }
  }, tick)
  timer.unref?.()
  job.signal = anySignal(outer, watchdog.signal)
  try {
    return await tryUrl(job, url)
  } finally {
    clearInterval(timer)
    job.signal = outer
  }
}

/** One URL's ladder: one restart from zero after a range failure, a few continuations after body failures. */
async function tryUrl(job: Job, url: string): Promise<DownloadResult> {
  let fresh = false
  for (let continuations = 0; ; ) {
    try {
      return await attempt(job, url, fresh)
    } catch (e) {
      if (job.signal?.aborted) throw abortReason(job.signal)
      if (e instanceof RangeRestart && !fresh) {
        fresh = true
        await discard(job)
        continue
      }
      if (bodyErrors.has(e as object) && continuations < MAX_CONTINUATIONS) {
        continuations++
        const delay = backoffDelay(continuations, job.retry)
        job.lastProgressAt += delay
        await sleep(delay, job.signal)
        continue
      }
      throw e
    }
  }
}

async function attempt(job: Job, url: string, fresh: boolean): Promise<DownloadResult> {
  const { item, signal } = job
  let offset = 0
  let validator: string | undefined
  if (!fresh) ({ offset, validator } = await loadPartial(job, url))
  setProgress(job, offset)

  const headers: Record<string, string> = { ...item.headers }
  if (offset > 0) {
    headers.range = `bytes=${offset}-`
    if (validator) headers['if-range'] = validator
  }
  let res: HttpResponse
  try {
    res = await job.client.request(url, { headers, signal, retry: job.retryOverride, ...watch(job) })
  } catch (e) {
    if (offset > 0 && e instanceof HttpError && e.status === 416) throw new RangeRestart(url, 'HTTP 416')
    throw e
  }

  const h = res.headers
  let start = 0
  let total: number | undefined
  if (res.status === 206) {
    const cr = parseContentRange(h['content-range'])
    if (offset === 0 || !cr || cr.start !== offset) {
      discardBody(res.body)
      throw new RangeRestart(url, `unexpected Content-Range ${String(h['content-range'])}`)
    }
    start = offset
    total = cr.total ?? item.size
  } else if (res.status === 200) {
    total = headerNumber(h['content-length']) ?? item.size
  } else {
    discardBody(res.body)
    throw new NetError('EBADRESPONSE', `unexpected HTTP ${res.status} from ${sanitizeUrl(res.url)}`, sanitizeUrl(res.url))
  }
  // An HTML page (captive portal, CDN error page) is never a launcher artifact; only a checksum could vouch for it.
  if (!item.checksum && /^\s*text\/html\b/i.test(header(h['content-type']) ?? '')) {
    discardBody(res.body)
    throw new NetError('EBADRESPONSE', `unexpected HTML response from ${sanitizeUrl(res.url)}`, sanitizeUrl(res.url))
  }
  if (item.size !== undefined && total !== undefined && total !== item.size) {
    discardBody(res.body)
    throw new SizeMismatchError(item.size, total, res.url)
  }
  if (item.size === undefined && total !== undefined && !job.totalReported) {
    job.totalReported = true
    job.sink?.total(total)
  }
  if (start === 0) setProgress(job, 0)

  const etag = strongEtag(header(h.etag))
  const lastModified = header(h['last-modified'])
  if (start === 0 && !fresh && job.segments && total !== undefined && total >= job.segments.threshold && acceptsRanges(h)) {
    return segmented(job, res, total, etag ?? lastModified)
  }
  return single(job, url, res, start, total, etag, lastModified)
}

/** Stream one response into the `.part` file, hashing inline, then verify and rename. */
async function single(
  job: Job,
  url: string,
  res: HttpResponse,
  start: number,
  total: number | undefined,
  etag: string | undefined,
  lastModified: string | undefined,
): Promise<DownloadResult> {
  const { signal } = job
  // Make sure a stalled body is torn down even if the stream does not observe the request signal.
  const onAbort = () => res.body.destroy(abortReason(signal as AbortSignal))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await singleBody(job, url, res, start, total, etag, lastModified)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function singleBody(
  job: Job,
  url: string,
  res: HttpResponse,
  start: number,
  total: number | undefined,
  etag: string | undefined,
  lastModified: string | undefined,
): Promise<DownloadResult> {
  const { item, signal } = job
  if (start === 0) {
    const resumable = (total ?? 0) >= job.resumeMin && (item.checksum !== undefined || etag !== undefined || lastModified !== undefined)
    if (resumable) {
      const meta: PartMeta = { v: 1, url, etag, lastModified, size: total, checksum: item.checksum }
      await writeFile(job.meta, JSON.stringify(meta))
      job.metaOnDisk = true
    } else if (job.metaOnDisk) {
      await rm(job.meta, { force: true })
      job.metaOnDisk = false
    }
  }

  const hash = item.checksum ? createHash(item.checksum.algorithm) : undefined
  let fh: FileHandle
  try {
    fh = await open(job.part, start === 0 ? 'w' : 'r+')
  } catch (e) {
    discardBody(res.body)
    throw e
  }
  let end: number
  try {
    if (hash && start > 0) await hashRange(fh, hash, 0, start, signal)
    const writer = new BatchWriter(fh, start)
    try {
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        hash?.update(chunk)
        job.bytes += chunk.length
        addProgress(job, chunk.length)
        await writer.push(chunk)
      }
      await writer.flush()
    } catch (e) {
      // Persist what arrived so a resume continues from the right offset.
      await writer.flush().catch(() => {})
      throw bodyError(e)
    }
    end = writer.pos
    if (total !== undefined && end !== total) {
      if (end < total) throw bodyError(new SizeMismatchError(total, end, res.url))
      await discardAfterClose(job, fh)
      throw new SizeMismatchError(total, end, res.url)
    }
    if (end >= SYNC_MIN_BYTES) await fh.sync()
  } finally {
    await fh.close().catch(() => {})
  }

  const actual = hash?.digest('hex')
  const verified = item.checksum !== undefined && actual === item.checksum.value.toLowerCase()
  // An empty body is a failed download (mirror error), not a file, unless the caller expects exactly that.
  if (end === 0 && item.size === undefined && !verified) {
    await discard(job)
    throw new NetError('EBADRESPONSE', `empty response body from ${sanitizeUrl(res.url)}`, sanitizeUrl(res.url))
  }
  if (item.checksum && !verified) {
    await discard(job)
    // A stale or corrupt resumed prefix: restart this URL from zero once rather than failing it.
    if (start > 0) throw new RangeRestart(url, 'resumed file failed verification')
    throw new ChecksumError(item.checksum.algorithm, item.checksum.value.toLowerCase(), actual ?? '', job.dest, res.url)
  }
  return finish(job, res.url)
}

/** Download `[0, total)` as parallel ranges into one preallocated file; the first response serves range 0. */
async function segmented(job: Job, first: HttpResponse, total: number, validator: string | undefined): Promise<DownloadResult> {
  const { item } = job
  const parts = (job.segments as SegmentOptions).parts
  const partSize = Math.ceil(total / parts)
  const ranges: [number, number][] = []
  for (let s = 0; s < total; s += partSize) ranges.push([s, Math.min(total, s + partSize) - 1])
  // v1: segmented downloads restart from zero rather than resuming.
  if (job.metaOnDisk) {
    await rm(job.meta, { force: true })
    job.metaOnDisk = false
  }

  const controller = new AbortController()
  const signal = anySignal(job.signal, controller.signal) as AbortSignal
  let fh: FileHandle
  try {
    fh = await open(job.part, 'w')
  } catch (e) {
    discardBody(first.body)
    throw e
  }
  let ok = false
  try {
    await fh.truncate(total)
    const fetchRange = async (i: number): Promise<void> => {
      const [s, e] = ranges[i] as [number, number]
      if (i === 0) return writeRange(job, fh, first, s, e, signal)
      const headers: Record<string, string> = { ...item.headers, range: `bytes=${s}-${e}` }
      if (validator) headers['if-range'] = validator
      const res = await job.client.request(first.url, { headers, signal, retry: job.retryOverride, ...watch(job) })
      const cr = res.status === 206 ? parseContentRange(res.headers['content-range']) : undefined
      if (!cr || cr.start !== s || cr.end !== e) {
        discardBody(res.body)
        throw new RangeRestart(first.url, `HTTP ${res.status} for range ${s}-${e}`)
      }
      return writeRange(job, fh, res, s, e, signal)
    }
    // Any failure cancels the siblings; allSettled waits for their pending writes before closing (no stray writes).
    const results = await Promise.allSettled(
      ranges.map((_, i) =>
        fetchRange(i).catch((e: unknown) => {
          if (!controller.signal.aborted) controller.abort(e)
          throw e
        }),
      ),
    )
    if (controller.signal.aborted) throw controller.signal.reason
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
    await fh.sync()
    ok = true
  } finally {
    await fh.close().catch(() => {})
    if (!ok) await rm(job.part, { force: true }).catch(() => {})
  }

  if (item.checksum) {
    const actual = await hashFile(job.part, item.checksum.algorithm, job.signal)
    if (actual !== item.checksum.value.toLowerCase()) {
      await discard(job)
      throw new ChecksumError(item.checksum.algorithm, item.checksum.value.toLowerCase(), actual, job.dest, first.url)
    }
  }
  return finish(job, first.url)
}

/** Write bytes `[s, e]` from `res` at their offsets. Extra bytes from a full (200) response are not read. */
async function writeRange(job: Job, fh: FileHandle, res: HttpResponse, s: number, e: number, signal: AbortSignal): Promise<void> {
  const want = e - s + 1
  const body: ResponseBody = res.body
  const writer = new BatchWriter(fh, s)
  const onAbort = () => body.destroy(abortReason(signal))
  signal.addEventListener('abort', onAbort, { once: true })
  let got = 0
  try {
    for await (let chunk of body as AsyncIterable<Buffer>) {
      if (got + chunk.length > want) {
        if (res.status === 206) throw new SizeMismatchError(want, got + chunk.length, res.url)
        chunk = chunk.subarray(0, want - got)
      }
      got += chunk.length
      job.bytes += chunk.length
      addProgress(job, chunk.length)
      await writer.push(chunk)
      if (got === want) break
    }
    await writer.flush()
  } catch (err) {
    throw bodyError(err)
  } finally {
    signal.removeEventListener('abort', onAbort)
    discardBody(body)
  }
  if (got !== want) throw bodyError(new SizeMismatchError(want, got, res.url))
}

async function finish(job: Job, url: string): Promise<DownloadResult> {
  await rename(job.part, job.dest)
  if (job.metaOnDisk) {
    await rm(job.meta, { force: true })
    job.metaOnDisk = false
  }
  return { path: job.dest, skipped: false, bytes: job.bytes, url }
}

/** Find a `.part` this item can continue. Anything unusable is deleted. */
async function loadPartial(job: Job, url: string): Promise<{ offset: number; validator?: string }> {
  const { item } = job
  // Small files never leave resumable partials, so skip the extra syscalls (thousands of assets).
  if (item.size !== undefined && item.size < job.resumeMin) return { offset: 0 }
  let size: number
  try {
    size = (await stat(job.part)).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { offset: 0 }
    throw e
  }
  let meta: PartMeta | undefined
  try {
    meta = JSON.parse(await readFile(job.meta, 'utf8')) as PartMeta
    job.metaOnDisk = true
  } catch {
    meta = undefined
  }
  const sameEntity =
    meta !== undefined &&
    meta.v === 1 &&
    (item.size === undefined || meta.size === item.size) &&
    (item.checksum
      ? meta.checksum?.algorithm === item.checksum.algorithm && meta.checksum.value.toLowerCase() === item.checksum.value.toLowerCase()
      : meta.url === url && (meta.etag !== undefined || meta.lastModified !== undefined))
  const limit = item.size ?? meta?.size
  if (!meta || !sameEntity || size === 0 || (limit !== undefined && size >= limit)) {
    await discard(job)
    return { offset: 0 }
  }
  // Validators from another mirror mean nothing here; the checksum protects the result instead.
  return { offset: size, validator: meta.url === url ? (meta.etag ?? meta.lastModified) : undefined }
}

async function discard(job: Job): Promise<void> {
  await Promise.all([rm(job.part, { force: true }), rm(job.meta, { force: true })])
  job.metaOnDisk = false
  setProgress(job, 0)
}

async function discardAfterClose(job: Job, fh: FileHandle): Promise<void> {
  await fh.close().catch(() => {})
  await discard(job)
}

function setProgress(job: Job, value: number): void {
  if (value !== job.counted) job.sink?.progress(value - job.counted)
  job.counted = value
}

/** Request hooks for the stall watchdog: a response resets it, and retry waits do not count as stalling. */
function watch(job: Job): { onResponse: () => void; onRetryWait: (delayMs: number) => void } {
  return {
    onResponse: () => {
      job.lastProgressAt = Math.max(job.lastProgressAt, Date.now())
    },
    onRetryWait: (delayMs) => {
      job.lastProgressAt += delayMs
    },
  }
}

function addProgress(job: Job, delta: number): void {
  job.lastProgressAt = Math.max(job.lastProgressAt, Date.now())
  job.counted += delta
  job.sink?.progress(delta)
}

/** Batches chunks into positional `writev` calls; each push awaits the disk, which back-pressures the socket. */
class BatchWriter {
  private chunks: Buffer[] = []
  private size = 0

  constructor(
    private readonly fh: FileHandle,
    /** File offset just past the last flushed byte. */
    public pos: number,
  ) {}

  async push(chunk: Buffer): Promise<void> {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size >= WRITE_BATCH) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.size === 0) return
    const { chunks, size } = this
    this.chunks = []
    this.size = 0
    try {
      let written = (await this.fh.writev(chunks, this.pos)).bytesWritten
      if (written < size) {
        const rest = Buffer.concat(chunks, size)
        while (written < size) written += (await this.fh.write(rest, written, size - written, this.pos + written)).bytesWritten
      }
    } catch (e) {
      if (typeof e === 'object' && e !== null) diskErrors.add(e)
      throw e
    }
    this.pos += size
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function headerNumber(value: string | string[] | undefined): number | undefined {
  const v = header(value)
  if (v === undefined || !/^\d+$/.test(v.trim())) return undefined
  return Number(v)
}

/** `If-Range` requires a strong validator; weak ETags are ignored. */
function strongEtag(etag: string | undefined): string | undefined {
  return etag && !etag.startsWith('W/') ? etag : undefined
}

function acceptsRanges(h: IncomingHttpHeaders): boolean {
  return /\bbytes\b/i.test(header(h['accept-ranges']) ?? '')
}

function parseContentRange(value: string | string[] | undefined): { start: number; end: number; total?: number } | undefined {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header(value) ?? '')
  if (!m) return undefined
  const start = Number(m[1])
  const end = Number(m[2])
  if (end < start) return undefined
  return { start, end, total: m[3] === '*' ? undefined : Number(m[3]) }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((onValue, onError) => {
    const onAbort = () => onError(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        onValue(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        onError(e as Error)
      },
    )
  })
}
