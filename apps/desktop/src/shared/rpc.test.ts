import { describe, expect, it } from 'vitest'
import { RpcClient, ServiceRegistry, unwrap, type RpcRequest } from './rpc'

describe('rpc', () => {
  const registry = new ServiceRegistry()
  registry.register('math', {
    async add(a: number, b: number) {
      return a + b
    },
    async fail() {
      throw Object.assign(new Error('nope'), { code: 'ENOPE' })
    },
  })

  const loopback = () => {
    const client: RpcClient = new RpcClient((req: RpcRequest) => {
      registry.dispatch(req).then((result) => client.settle({ t: 'res', id: req.id, result }))
    })
    return client
  }

  it('round-trips calls', async () => {
    expect(await unwrap(loopback().call('math', 'add', [2, 3]))).toBe(5)
  })

  it('preserves error codes', async () => {
    await expect(unwrap(loopback().call('math', 'fail', []))).rejects.toMatchObject({ message: 'nope', code: 'ENOPE' })
  })

  it('rejects unknown and inherited methods', async () => {
    const client = loopback()
    expect(await client.call('math', 'missing', [])).toMatchObject({ ok: false, error: { code: 'ENOMETHOD' } })
    expect(await client.call('math', 'toString', [])).toMatchObject({ ok: false, error: { code: 'ENOMETHOD' } })
    expect(await client.call('nope', 'add', [])).toMatchObject({ ok: false, error: { code: 'ENOMETHOD' } })
  })

  it('fails in-flight calls when the transport dies', async () => {
    const client = new RpcClient(() => {})
    const pending = client.call('math', 'add', [1, 1])
    client.failAll({ name: 'RuntimeRestarted', message: 'gone', code: 'ERUNTIME_RESTARTED' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'ERUNTIME_RESTARTED' } })
  })
})
