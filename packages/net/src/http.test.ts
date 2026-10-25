import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type TestServer } from './__fixtures__/server'
import { createHttpClient, HttpError, type HttpClient, type RetryInfo } from './index'

let server: TestServer
let client: HttpClient

const parseVersion = (v: unknown) => {
  if (typeof (v as { id?: unknown }).id !== 'string') throw new Error('missing id')
  return v as { id: string }
}

beforeAll(async () => {
  server = await startServer()
  client = createHttpClient({ version: '1.2.3', retry: { baseDelayMs: 1, maxDelayMs: 5 } })
})

afterAll(async () => {
  await client.close()
  await server.close()
})

describe('HttpClient', () => {
  it('fetches JSON with the Amethyst User-Agent', async () => {
    server.route('/json', (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: '1.21.1' }))
    })
    const value = await client.json<{ id: string }>(`${server.url}/json`)
    expect(value.id).toBe('1.21.1')
    expect(server.hits('/json')[0]?.headers['user-agent']).toBe('Amethyst/1.2.3 (+https://github.com/wynn-dev/amethyst)')
  })

  it('rejects invalid or unexpected JSON with EBADRESPONSE', async () => {
    server.route('/bad-json', (_req, res) => res.end('<html>captive portal</html>'))
    await expect(client.json(`${server.url}/bad-json`)).rejects.toMatchObject({ code: 'EBADRESPONSE' })
    server.route('/shape', (_req, res) => res.end('{"x":1}'))
    await expect(client.json(`${server.url}/shape`, { parse: parseVersion })).rejects.toMatchObject({ code: 'EBADRESPONSE' })
  })

  it('retries 503 with backoff', async () => {
    let n = 0
    server.route('/flaky', (_req, res) => {
      res.statusCode = ++n < 3 ? 503 : 200
      res.end('ok')
    })
    const retries: RetryInfo[] = []
    expect(await client.text(`${server.url}/flaky`, { retry: { onRetry: (i) => retries.push(i) } })).toBe('ok')
    expect(n).toBe(3)
    expect(retries.map((r) => r.attempt)).toEqual([1, 2])
  })

  it('honours Retry-After on 429', async () => {
    let n = 0
    server.route('/limited', (_req, res) => {
      if (++n === 1) {
        res.statusCode = 429
        res.setHeader('retry-after', '1')
      }
      res.end('ok')
    })
    const retries: RetryInfo[] = []
    const started = Date.now()
    expect(await client.text(`${server.url}/limited`, { retry: { onRetry: (i) => retries.push(i) } })).toBe('ok')
    expect(retries[0]?.delayMs).toBe(1000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
  })

  it('does not retry 404 and throws a typed HttpError', async () => {
    const before = server.hits('/missing').length
    const error = await client.text(`${server.url}/missing`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'EHTTP', status: 404, url: `${server.url}/missing` })
    expect(server.hits('/missing').length - before).toBe(1)
  })

  it('follows redirects and reports the final URL', async () => {
    server.route('/old', (_req, res) => {
      res.statusCode = 302
      res.setHeader('location', '/new?sig=secret')
      res.end()
    })
    server.route('/new', (_req, res) => res.end('moved'))
    const res = await client.request(`${server.url}/old`)
    expect(res.url).toBe(`${server.url}/new?sig=secret`)
    expect(await res.body.text()).toBe('moved')
  })

  it('strips API keys and other credentials on a redirect to another origin (CurseForge x-api-key)', async () => {
    const cdn = await startServer()
    try {
      cdn.route('/file.jar', (_req, res) => res.end('jar'))
      server.route('/v1/mods/1/files/2/download', (_req, res) => {
        res.statusCode = 302
        res.setHeader('location', `${cdn.url}/file.jar`)
        res.end()
      })
      const headers = { 'x-api-key': 'cf-secret', Authorization: 'Bearer t', cookie: 'c=1', 'x-custom-token': 'z', accept: 'application/java-archive', range: 'bytes=0-' }
      const res = await client.request(`${server.url}/v1/mods/1/files/2/download`, { headers })
      await res.body.text()
      expect(server.hits('/v1/mods/1/files/2/download').at(-1)?.headers['x-api-key']).toBe('cf-secret')
      const sent = cdn.hits('/file.jar')[0]?.headers ?? {}
      expect(sent['x-api-key']).toBeUndefined()
      expect(sent.authorization).toBeUndefined()
      expect(sent.cookie).toBeUndefined()
      expect(sent['x-custom-token']).toBeUndefined()
      expect(sent.accept).toBe('application/java-archive')
      expect(sent.range).toBe('bytes=0-')
      expect(sent['user-agent']).toContain('Amethyst/')

      // Per request, a caller can let a named header follow the redirect.
      const again = await client.request(`${server.url}/v1/mods/1/files/2/download`, { headers, crossOriginHeaders: ['X-Custom-Token'] })
      await again.body.text()
      const second = cdn.hits('/file.jar')[1]?.headers ?? {}
      expect(second['x-custom-token']).toBe('z')
      expect(second['x-api-key']).toBeUndefined()
    } finally {
      await cdn.close()
    }
  })

  it('keeps headers on a same-origin redirect', async () => {
    server.route('/same-a', (_req, res) => {
      res.statusCode = 307
      res.setHeader('location', '/same-b')
      res.end()
    })
    server.route('/same-b', (_req, res) => res.end('b'))
    await (await client.request(`${server.url}/same-a`, { headers: { 'x-api-key': 'k' } })).body.text()
    expect(server.hits('/same-b').at(-1)?.headers['x-api-key']).toBe('k')
  })

  it('caps response size for buffered reads', async () => {
    server.route('/big', (_req, res) => res.end(Buffer.alloc(2048)))
    await expect(client.bytes(`${server.url}/big`, { maxBytes: 1024 })).rejects.toMatchObject({ code: 'EBADRESPONSE' })
  })
})
