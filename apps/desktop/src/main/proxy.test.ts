import { describe, expect, it } from 'vitest'
import { applySessionProxy, electronProxyConfig } from './proxy'

describe('Electron session proxy', () => {
  it('maps the launcher proxy to Chromium rules, keeping local names direct', () => {
    expect(electronProxyConfig(null)).toEqual({ mode: 'direct' })
    expect(electronProxyConfig('http://proxy.corp:3128')).toEqual({ mode: 'fixed_servers', proxyRules: 'http://proxy.corp:3128', proxyBypassRules: '<local>' })
    expect(electronProxyConfig('socks5://127.0.0.1:1080').proxyRules).toBe('socks5://127.0.0.1:1080')
    expect(() => electronProxyConfig('file:///etc/passwd')).toThrow('Unsupported proxy address')
  })

  it('applies it to every session and drops connections made under the old setting', async () => {
    const calls: string[] = []
    const fake = (name: string) => ({
      setProxy: async (c: unknown) => void calls.push(`${name} ${JSON.stringify(c)}`),
      closeAllConnections: async () => void calls.push(`${name} closed`),
    })
    await applySessionProxy([fake('default'), fake('msa')], 'https://p:8443')
    expect(calls).toEqual([
      'default {"mode":"fixed_servers","proxyRules":"https://p:8443","proxyBypassRules":"<local>"}',
      'msa {"mode":"fixed_servers","proxyRules":"https://p:8443","proxyBypassRules":"<local>"}',
      'default closed',
      'msa closed',
    ])
  })
})
