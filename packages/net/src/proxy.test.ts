import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseNoProxy } from './dispatcher'
import { startServer, type TestServer } from './__fixtures__/server'
import { bypassesProxy, createHttpClient, installGlobalDispatcher, type HttpClient } from './index'

/** A forwarding HTTP proxy that answers every request itself and records its absolute URL. */
async function startProxy(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.end(`proxied ${req.url}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

let origin: TestServer
let proxy: Awaited<ReturnType<typeof startProxy>>
const clients: HttpClient[] = []
const client = (o: Parameters<typeof createHttpClient>[0] = {}) => {
  const c = createHttpClient({ retry: { retries: 0 }, ...o })
  clients.push(c)
  return c
}

beforeAll(async () => {
  origin = await startServer()
  origin.route('/direct', (_req, res) => res.end('direct'))
  proxy = await startProxy()
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  proxy.seen.length = 0
})

afterAll(async () => {
  await origin.close()
  await proxy.close()
})

describe('proxy support', () => {
  it('sends requests through the configured proxy, but never loopback ones', async () => {
    const c = client({ proxy: { url: proxy.url } })
    expect(await c.text('http://meta.minecraft.invalid/versions.json')).toBe('proxied http://meta.minecraft.invalid/versions.json')
    expect(await c.text(`${origin.url}/direct`)).toBe('direct')
    expect(proxy.seen).toEqual(['http://meta.minecraft.invalid/versions.json'])
  })

  it('applies proxy changes live, without a new client', async () => {
    const c = client()
    await expect(c.text('http://cdn.invalid/a')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    c.configure({ proxy: { url: proxy.url } })
    expect(await c.text('http://cdn.invalid/a')).toBe('proxied http://cdn.invalid/a')
    c.configure({ proxy: { url: proxy.url, noProxy: 'cdn.invalid' } })
    await expect(c.text('http://cdn.invalid/b')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    c.configure({ proxy: null, connectionsPerHost: 4 })
    await expect(c.text('http://cdn.invalid/c')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(proxy.seen).toEqual(['http://cdn.invalid/a'])
  })

  it('rejects an unusable proxy URL without changing anything', async () => {
    const c = client({ proxy: { url: proxy.url } })
    expect(() => c.configure({ proxy: { url: 'ftp://proxy.local:21' } })).toThrow(TypeError)
    expect(await c.text('http://x.invalid/')).toBe('proxied http://x.invalid/')
  })

  it('routes the built-in fetch (marketplace, sign-in, telemetry) through the installed dispatcher', async () => {
    const key1 = Symbol.for('undici.globalDispatcher.1')
    const key2 = Symbol.for('undici.globalDispatcher.2')
    const g = globalThis as unknown as Record<symbol, unknown>
    const saved = [g[key1], g[key2]]
    try {
      const c = client({ proxy: { url: proxy.url } })
      installGlobalDispatcher(c.dispatcher)
      const res = await fetch('http://api.modrinth.invalid/v2/search')
      expect(await res.text()).toBe('proxied http://api.modrinth.invalid/v2/search')
      // Live changes reach fetch too: the installed dispatcher is stable.
      c.configure({ proxy: null })
      expect(await (await fetch(`${origin.url}/direct`)).text()).toBe('direct')
      expect(proxy.seen).toEqual(['http://api.modrinth.invalid/v2/search'])
    } finally {
      Object.defineProperty(globalThis, key1, { value: saved[0], writable: true })
      Object.defineProperty(globalThis, key2, { value: saved[1], writable: true })
    }
  })

  it('accepts SOCKS5 proxies', () => {
    const c = client()
    expect(() => c.configure({ proxy: { url: 'socks5://127.0.0.1:1080' } })).not.toThrow()
  })

  it('matches NO_PROXY entries the usual way', () => {
    const e = parseNoProxy('example.com, *.wild.test .dot.test internal:8080 [::2]')
    expect(bypassesProxy('https://example.com', e)).toBe(true)
    expect(bypassesProxy('https://a.example.com', e)).toBe(true)
    expect(bypassesProxy('https://notexample.com', e)).toBe(false)
    expect(bypassesProxy('https://wild.test', e)).toBe(false)
    expect(bypassesProxy('https://a.wild.test', e)).toBe(true)
    expect(bypassesProxy('https://dot.test', e)).toBe(true)
    expect(bypassesProxy('http://internal:8080', e)).toBe(true)
    expect(bypassesProxy('http://internal:80', e)).toBe(false)
    expect(bypassesProxy('http://[::2]:5', e)).toBe(true)
    for (const loop of ['http://localhost:1', 'http://127.0.0.1:2', 'http://127.1.2.3', 'http://[::1]:3']) expect(bypassesProxy(loop, [])).toBe(true)
    expect(bypassesProxy('https://anything', parseNoProxy('*'))).toBe(true)
  })
})

describe('API concurrency', () => {
  it('limits buffered API reads to apiConcurrency, live', async () => {
    let active = 0
    let peak = 0
    origin.route('/slow', async (_req, res) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      res.end('{}')
    })
    const c = client({ apiConcurrency: 2 })
    await Promise.all(Array.from({ length: 6 }, () => c.json(`${origin.url}/slow`)))
    expect(peak).toBe(2)
    peak = 0
    c.configure({ apiConcurrency: 5 })
    await Promise.all(Array.from({ length: 10 }, () => c.json(`${origin.url}/slow`)))
    expect(peak).toBe(5)
  })
})
