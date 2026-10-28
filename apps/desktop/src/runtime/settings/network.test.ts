import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHttpClient, type HttpClient } from '@amethyst/net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../layout'
import { bindNetworkSettings, networkOptions } from './network'
import { defaultSettings } from './schema'
import { SettingsStore } from './service'

let root: string
let proxy: Server
let proxyUrl: string
let seen: string[]
let client: HttpClient

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-network-'))
  seen = []
  proxy = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.end('via proxy')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  client = createHttpClient({ retry: { retries: 0 } })
})

afterEach(async () => {
  await client.close()
  proxy.closeAllConnections()
  await new Promise((r) => proxy.close(r))
  await rm(root, { recursive: true, force: true })
})

describe('network settings', () => {
  it('maps the settings to client options, with the environment proxy as the fallback address', () => {
    const s = defaultSettings()
    expect(networkOptions(s, {})).toEqual({ proxy: null, connectionsPerHost: 16, apiConcurrency: 8 })
    s.network.proxyEnabled = true
    expect(networkOptions(s, { HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'intranet' }).proxy).toEqual({ url: 'http://corp:3128', noProxy: 'intranet' })
    s.network.proxyUrl = 'socks5://127.0.0.1:1080'
    expect(networkOptions(s, { HTTPS_PROXY: 'http://corp:3128' }).proxy).toEqual({ url: 'socks5://127.0.0.1:1080' })
    s.network.proxyEnabled = false
    expect(networkOptions(s, { HTTPS_PROXY: 'http://corp:3128' }).proxy).toBeNull()
  })

  it('applies proxy and limit changes live, and mirrors the proxy into Electron', async () => {
    const store = new SettingsStore(dataLayout(root), () => {})
    await store.load()
    const electron: (string | null)[] = []
    bindNetworkSettings(store, client, async (url) => void electron.push(url), {})
    await expect(client.text('http://piston-meta.mojang.invalid/mc/game/version_manifest_v2.json')).rejects.toMatchObject({ code: 'ENOTFOUND' })

    await store.patch({ network: { proxyEnabled: true, proxyUrl } })
    expect(await client.text('http://piston-meta.mojang.invalid/mc/game/version_manifest_v2.json')).toBe('via proxy')
    expect(seen).toEqual(['http://piston-meta.mojang.invalid/mc/game/version_manifest_v2.json'])
    // Unrelated changes do not touch the network setup; limits apply without dropping the proxy.
    await store.patch({ appearance: { theme: 'dark' }, network: { maxApiConnections: 2, maxConnectionsPerHost: 4 } })
    expect(await client.text('http://api.modrinth.invalid/v2/tag/loader')).toBe('via proxy')

    await store.patch({ network: { proxyEnabled: false } })
    await expect(client.text('http://api.modrinth.invalid/v2/tag/loader')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(seen).toHaveLength(2)
    expect(electron).toEqual([proxyUrl, null])
  })
})
