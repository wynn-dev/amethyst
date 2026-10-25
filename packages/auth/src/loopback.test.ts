import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { startLoopbackServer } from './loopback'

function get(port: number, path: string, options: { host?: string; address?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: options.address ?? '127.0.0.1', port, path, headers: { host: options.host ?? `localhost:${port}` } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('startLoopbackServer', () => {
  it('serves a localhost redirect URI on a random port and resolves with the code', async () => {
    const server = await startLoopbackServer()
    expect(server.redirectUri).toBe(`http://localhost:${server.port}`)
    expect(server.port).toBeGreaterThan(0)
    const wait = server.waitForCode('state-1')
    const res = await get(server.port, '/?code=the-code&state=state-1')
    expect(res.status).toBe(200)
    expect(res.body).toContain('You can close this window')
    await expect(wait).resolves.toEqual({ code: 'the-code' })
    // One-shot: the server is gone afterwards.
    await expect(get(server.port, '/?code=again&state=state-1')).rejects.toThrow(/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/)
  })

  it('supports a redirect path', async () => {
    const server = await startLoopbackServer({ path: '/auth' })
    expect(server.redirectUri).toBe(`http://localhost:${server.port}/auth`)
    const wait = server.waitForCode('s')
    expect((await get(server.port, '/?code=c&state=s')).status).toBe(404)
    expect((await get(server.port, '/auth?code=c&state=s')).status).toBe(200)
    await expect(wait).resolves.toEqual({ code: 'c' })
  })

  it('ignores requests with the wrong state or a foreign Host header', async () => {
    const server = await startLoopbackServer()
    const wait = server.waitForCode('good')
    expect((await get(server.port, '/?code=evil&state=bad')).status).toBe(400)
    expect((await get(server.port, '/?code=evil')).status).toBe(400)
    expect((await get(server.port, '/?code=evil&state=good', { host: `attacker.example:${server.port}` })).status).toBe(400)
    expect((await get(server.port, '/favicon.ico')).status).toBe(404)
    expect((await get(server.port, '/?code=real&state=good', { host: `127.0.0.1:${server.port}` })).status).toBe(200)
    await expect(wait).resolves.toEqual({ code: 'real' })
  })

  it('rejects with the OAuth error when the redirect carries one', async () => {
    const server = await startLoopbackServer()
    const wait = server.waitForCode('s')
    const res = await get(server.port, '/?error=access_denied&error_description=denied&state=s')
    expect(res.status).toBe(400)
    await expect(wait).rejects.toMatchObject({ code: 'EMSA_CANCELLED', reason: 'USER_CANCELLED' })
  })

  it('times out', async () => {
    const server = await startLoopbackServer({ timeoutMs: 30 })
    await expect(server.waitForCode('s')).rejects.toMatchObject({ code: 'ELOGIN_TIMEOUT' })
    await expect(get(server.port, '/?code=c&state=s')).rejects.toThrow(/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/)
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const server = await startLoopbackServer({ signal: controller.signal })
    const wait = server.waitForCode('s')
    controller.abort()
    await expect(wait).rejects.toMatchObject({ code: 'ECANCELLED' })
  })

  it('answers on both loopback addresses localhost may resolve to (127.0.0.1 and [::1]), and on no other interface', async () => {
    const server = await startLoopbackServer()
    try {
      expect(server.redirectUri).toBe(`http://localhost:${server.port}`)
      const code = server.waitForCode('s')
      // Microsoft redirects to `localhost`; a browser that resolves it to ::1 must still reach us.
      expect((await get(server.port, '/?code=v6&state=s', { address: '::1' })).status).toBe(200)
      await expect(code).resolves.toEqual({ code: 'v6' })
    } finally {
      await server.close()
    }
    const again = await startLoopbackServer()
    try {
      // Every non-loopback IPv4 address of this machine (there may be none on a CI runner).
      const external = Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && !i.internal && i.family === 'IPv4')
        .map((i) => i!.address)
      const results = await Promise.all(external.map((address) => get(again.port, '/', { address }).then(() => 'answered', (e: Error) => e.message)))
      for (const r of results) expect(r).toMatch(/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/)
    } finally {
      await again.close()
    }
  })
})
