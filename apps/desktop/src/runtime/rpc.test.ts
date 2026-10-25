import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { describe, expect, it } from 'vitest'
import type { RpcMessage } from '@shared/rpc'
import { attachPort, emit, registerService } from './rpc'

/** A MessagePortMain stand-in that structured-clones like the real one (and throws the same way). */
class FakePort extends EventEmitter {
  sent: RpcMessage[] = []
  postMessage(msg: RpcMessage) {
    this.sent.push(structuredClone(msg))
  }
  start() {}
}

const nextMessage = (port: FakePort) =>
  new Promise<RpcMessage>((resolve) => {
    const check = () => (port.sent.length ? resolve(port.sent.shift() as RpcMessage) : setTimeout(check, 1))
    check()
  })

describe('runtime rpc', () => {
  it('answers with ENOTCLONEABLE instead of never answering when a result cannot be cloned', async () => {
    registerService('cloneTest' as never, { async bad() { return { ok: 1, fn: () => 1 } }, async good() { return { ok: 1 } } } as never)
    const port = new FakePort()
    attachPort(port as unknown as MessagePortMain)

    port.emit('message', { data: { t: 'req', id: 1, service: 'cloneTest', method: 'bad', args: [] } })
    expect(await nextMessage(port)).toMatchObject({ t: 'res', id: 1, result: { ok: false, error: { code: 'ENOTCLONEABLE' } } })

    port.emit('message', { data: { t: 'req', id: 2, service: 'cloneTest', method: 'good', args: [] } })
    expect(await nextMessage(port)).toEqual({ t: 'res', id: 2, result: { ok: true, value: { ok: 1 } } })

    // An uncloneable event payload is dropped (and logged), not thrown into the emitter.
    expect(() => emit('settings:changed', { keys: [], patch: { f: () => 1 } } as never)).not.toThrow()
    port.emit('close')
  })
})
