import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import project from './__fixtures__/modrinth-project.json'
import { json, mockFetch, type Reply } from './__fixtures__/mock-fetch'
import { MemoryCache } from './cache'
import { CurseForgeClient } from './curseforge'
import { parseRetryAfter } from './http'
import { ModrinthClient } from './modrinth'
import { RateLimiter } from './rate-limit'

/** A deferred reply so tests decide when the "server" answers. */
function deferred() {
  let resolve!: (r: Reply) => void
  const promise = new Promise<Reply>((r) => (resolve = r))
  return { promise, resolve }
}

/** A fetch that never answers; only an abort (e.g. the timeout) settles it. */
function neverAnswers(_input: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
}

describe('MemoryCache', () => {
  it('expires entries and evicts the least recently used', () => {
    let now = 0
    const cache = new MemoryCache({ maxEntries: 2, now: () => now })
    cache.set('a', 1, 100)
    cache.set('b', 2, 100)
    expect(cache.get('a')).toBe(1) // a is now most recent
    cache.set('c', 3, 100)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    now = 100
    expect(cache.get('a')).toBeUndefined()
    cache.set('z', 0, 0)
    expect(cache.get('z')).toBeUndefined()
  })
})

describe('GET cache and in-flight de-duplication', () => {
  it('serves repeat GETs from the cache until the TTL passes, and `fresh` bypasses it', async () => {
    let now = 0
    const { fetch, calls } = mockFetch(() => json(project))
    const c = new ModrinthClient({ fetch, limiter: false, cache: new MemoryCache({ now: () => now }) })
    await c.getProject('sodium')
    await c.getProject('sodium')
    expect(calls).toHaveLength(1)
    await c.getProject('sodium', { fresh: true })
    expect(calls).toHaveLength(2)
    now = 60 * 60_000 // project TTL is one hour
    await c.getProject('sodium')
    expect(calls).toHaveLength(3)
  })

  it('does not cache errors or POSTs', async () => {
    let fail = true
    const { fetch, calls } = mockFetch((call) =>
      call.method === 'POST' ? json({}) : fail ? { status: 404, text: '' } : json(project),
    )
    const c = new ModrinthClient({ fetch, limiter: false })
    await expect(c.getProject('sodium')).rejects.toMatchObject({ code: 'ENOT_FOUND' })
    fail = false
    await expect(c.getProject('sodium')).resolves.toMatchObject({ id: 'AANobbMI' })
    const hash = 'a'.repeat(40)
    await c.getVersionsFromHashes([hash])
    await c.getVersionsFromHashes([hash])
    expect(calls.filter((x) => x.method === 'POST')).toHaveLength(2)
  })

  it('shares one request between identical concurrent calls', async () => {
    const gate = deferred()
    const { fetch, calls } = mockFetch(() => gate.promise)
    const c = new ModrinthClient({ fetch, limiter: false, cache: false })
    const a = c.getProject('sodium')
    const b = c.getProject('sodium')
    const other = c.getProject('lithium')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    gate.resolve(json(project))
    const [ra, rb] = await Promise.all([a, b, other])
    expect(ra).toBe(rb)
    expect(calls.map((x) => x.url.pathname)).toEqual(['/v2/project/sodium', '/v2/project/lithium'])
  })

  it('de-duplicates POSTs with the same body only', async () => {
    const gate = deferred()
    const { fetch, calls } = mockFetch(() => gate.promise)
    const c = new ModrinthClient({ fetch, limiter: false })
    const h1 = '1'.repeat(40)
    const h2 = '2'.repeat(40)
    const all = Promise.all([c.getVersionsFromHashes([h1]), c.getVersionsFromHashes([h1]), c.getVersionsFromHashes([h2])])
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    gate.resolve(json({}))
    await all
  })

  it('aborting one caller keeps the shared request alive for the others', async () => {
    const gate = deferred()
    const { fetch, calls } = mockFetch(() => gate.promise)
    const c = new ModrinthClient({ fetch, limiter: false })
    const controller = new AbortController()
    const a = c.getProject('sodium', { signal: controller.signal })
    const b = c.getProject('sodium')
    controller.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    gate.resolve(json(project))
    await expect(b).resolves.toMatchObject({ id: 'AANobbMI' })
    expect(calls).toHaveLength(1)
  })

  it('aborts the underlying fetch once every caller has gone', async () => {
    let fetchSignal: AbortSignal | undefined
    const c = new ModrinthClient({
      limiter: false,
      fetch: (_url, init) => {
        fetchSignal = init.signal ?? undefined
        return new Promise(() => {})
      },
    })
    const controller = new AbortController()
    const p = c.getProject('sodium', { signal: controller.signal })
    await vi.waitFor(() => expect(fetchSignal).toBeDefined())
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSignal?.aborted).toBe(true)
  })
})

describe('retries, timeouts and rate limiting (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for Retry-After on 429, then succeeds', async () => {
    const replies: Reply[] = [{ status: 429, text: '', headers: { 'retry-after': '5' } }, json(project)]
    const { fetch, calls } = mockFetch(() => replies.shift()!)
    const c = new ModrinthClient({ fetch, random: () => 0.5 })
    const p = c.getProject('sodium')
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await expect(p).resolves.toMatchObject({ id: 'AANobbMI' })
  })

  it('pauses every Modrinth request after a 429 using X-Ratelimit-Reset', async () => {
    let first = true
    const { fetch, calls } = mockFetch((call) => {
      if (first) {
        first = false
        return { status: 429, text: '', headers: { 'x-ratelimit-reset': '10', 'x-ratelimit-remaining': '0' } }
      }
      return json({ ...project, slug: call.url.pathname })
    })
    const c = new ModrinthClient({ fetch, random: () => 0.5 })
    const a = c.getProject('aaa')
    await vi.advanceTimersByTimeAsync(0)
    const b = c.getProject('bbb')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([a, b])
    expect(calls).toHaveLength(3)
  })

  it('throws ERATE_LIMITED once retries are exhausted', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 429, text: '', headers: { 'retry-after': '1' } }))
    const c = new ModrinthClient({ fetch, retries: 2 })
    const p = c.getProject('sodium').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await p).toMatchObject({ code: 'ERATE_LIMITED', status: 429, retryable: true })
    expect(calls).toHaveLength(3)
  })

  it('backs off on 5xx and network errors but never retries other 4xx', async () => {
    const replies: Reply[] = [{ status: 502, text: '<html>bad gateway</html>' }, new TypeError('fetch failed'), json(project)]
    const { fetch, calls } = mockFetch(() => replies.shift()!)
    const c = new ModrinthClient({ fetch, limiter: false, retryDelaysMs: [500, 1500], random: () => 0.5 })
    const p = c.getProject('sodium')
    await vi.advanceTimersByTimeAsync(499)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(p).resolves.toMatchObject({ id: 'AANobbMI' })
    expect(calls).toHaveLength(3)

    const bad = mockFetch(() => ({ status: 400, text: '{"error":"invalid_input","description":"bad ids"}' }))
    const c2 = new ModrinthClient({ fetch: bad.fetch, limiter: false })
    await expect(c2.getProject('x-y-z')).rejects.toMatchObject({ code: 'EHTTP', status: 400, message: expect.stringContaining('bad ids') })
    expect(bad.calls).toHaveLength(1)
  })

  it('times out slow requests with ETIMEOUT', async () => {
    const c = new ModrinthClient({ fetch: neverAnswers, limiter: false, retries: 0, timeoutMs: 1000 })
    const p = c.getProject('sodium').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ code: 'ETIMEOUT', retryable: true })
  })

  it('honours Retry-After and backs off on CurseForge 429s', async () => {
    const replies: Reply[] = [{ status: 429, text: '' }, json({ data: { id: 1, slug: 'x' } })]
    const { fetch, calls } = mockFetch(() => replies.shift()!)
    const c = new CurseForgeClient({ apiKey: 'k', fetch, random: () => 0.5 })
    const p = c.getMod(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toMatchObject({ id: 1 })
  })
})

describe('RateLimiter (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps concurrency and serves waiters in order', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2 })
    const order: number[] = []
    const releases = await Promise.all([limiter.acquire(), limiter.acquire()])
    const third = limiter.acquire().then((r) => (order.push(3), r))
    const fourth = limiter.acquire().then((r) => (order.push(4), r))
    await vi.advanceTimersByTimeAsync(0)
    expect(limiter.inFlight).toBe(2)
    expect(limiter.pending).toBe(2)
    releases[0]!()
    releases[0]!() // double release is a no-op
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual([3])
    releases[1]!()
    await Promise.all([third, fourth])
    expect(order).toEqual([3, 4])
  })

  it('refills tokens over the window', async () => {
    const limiter = new RateLimiter({ capacity: 2, windowMs: 1000, maxConcurrent: 10 })
    ;(await limiter.acquire())()
    ;(await limiter.acquire())()
    let got = false
    const p = limiter.acquire().then((r) => {
      got = true
      return r
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(got).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toBe(true)
    ;(await p)()
  })

  it('holds requests until reset when X-Ratelimit-Remaining is low', async () => {
    const limiter = new RateLimiter({ lowWatermark: 10 })
    limiter.observe(new Headers({ 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '30' }))
    expect(limiter.pausedForMs).toBe(0)
    limiter.observe(new Headers({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '7' }))
    expect(limiter.pausedForMs).toBe(7000)
    let got = false
    const p = limiter.acquire().then((r) => {
      got = true
      return r
    })
    await vi.advanceTimersByTimeAsync(6999)
    expect(got).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toBe(true)
    ;(await p)()
  })

  it('removes aborted waiters from the queue', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 })
    const release = await limiter.acquire()
    const controller = new AbortController()
    const waiting = limiter.acquire(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(limiter.pending).toBe(0)
    release()
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10_000)
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})

describe('redirects', () => {
  it('never sends the CurseForge API key to another host after a redirect', async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.hostname === 'api.curseforge.com') return { status: 302, headers: { location: 'https://edge.example.net/v1/mods/1' } }
      return json({ data: { id: 1 } })
    })
    const c = new CurseForgeClient({ fetch, limiter: false, cache: false, apiKey: 'cf-secret', retries: 0 })
    await c.getMod(1).catch(() => undefined)
    expect(calls.map((x) => x.url.hostname)).toEqual(['api.curseforge.com', 'edge.example.net'])
    expect(calls[0]?.headers['x-api-key']).toBe('cf-secret')
    expect(calls[1]?.headers['x-api-key']).toBeUndefined()
    expect(calls[1]?.headers.accept).toBe('application/json')
  })

  it('keeps headers on a same-origin redirect and refuses HTTPS to HTTP', async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.pathname === '/v1/mods/1') return { status: 301, headers: { location: '/v1/mods/2' } }
      if (call.url.pathname === '/v1/mods/2') return json({ data: { id: 2 } })
      return { status: 302, headers: { location: 'http://api.curseforge.com/v1/mods/2' } }
    })
    const c = new CurseForgeClient({ fetch, limiter: false, cache: false, apiKey: 'cf-secret', retries: 0 })
    await c.getMod(1).catch(() => undefined)
    expect(calls[1]?.headers['x-api-key']).toBe('cf-secret')
    await expect(c.getMod(3)).rejects.toMatchObject({ code: 'EBAD_RESPONSE' })
    expect(calls.filter((x) => x.url.protocol === 'http:')).toHaveLength(0)
  })
})
