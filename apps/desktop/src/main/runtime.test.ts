import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  pid = 424242
  exitOnShutdown = false
  postMessage = vi.fn<(msg: { t?: string }) => void>((msg) => {
    if (msg?.t === 'shutdown' && this.exitOnShutdown) setTimeout(() => this.emit('exit', 0), 5)
  })
  kill = vi.fn<() => void>()
}

const children: FakeChild[] = []

vi.mock('electron', () => ({
  app: { on: vi.fn<() => void>(), isPackaged: true, getPath: () => '/tmp/amethyst-test', getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { on: vi.fn<() => void>(), handle: vi.fn<() => void>() },
  MessageChannelMain: vi.fn<() => void>(),
  safeStorage: {},
  session: { fromPartition: () => ({}) },
  shell: {},
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
  },
  webContents: { getAllWebContents: () => [] },
}))

// Electron-only addition to `process`.
Object.assign(process, { getSystemVersion: () => '15.0' })
const { RuntimeSupervisor } = await import('./runtime')

afterEach(() => {
  vi.restoreAllMocks()
  children.length = 0
})

describe('RuntimeSupervisor.shutdown', () => {
  it('SIGKILLs a runtime that does not exit in time (it traps SIGTERM)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const supervisor = new RuntimeSupervisor()
    supervisor.start()
    const child = children[0] as FakeChild
    await supervisor.shutdown(20)
    expect(child.postMessage).toHaveBeenCalledWith({ t: 'shutdown' })
    expect(kill).toHaveBeenCalledWith(child.pid, 'SIGKILL')
  })

  it('leaves a runtime that exits on its own alone', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const supervisor = new RuntimeSupervisor()
    supervisor.start()
    const child = children[0] as FakeChild
    child.exitOnShutdown = true
    await supervisor.shutdown(1_000)
    expect(kill).not.toHaveBeenCalled()
    // No restart after an orderly exit.
    await new Promise((r) => setTimeout(r, 300))
    expect(children).toHaveLength(1)
  })
})
