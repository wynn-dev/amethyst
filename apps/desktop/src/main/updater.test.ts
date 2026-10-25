import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeAutoUpdater extends EventEmitter {
  autoDownload = false
  allowPrerelease = false
  autoInstallOnAppQuit = false
  allowDowngrade = true
  logger: unknown
  checkForUpdates = vi.fn<() => Promise<{ downloadPromise?: Promise<unknown> } | null>>(async () => null)
  quitAndInstall = vi.fn<() => void>()
}

const fake = new FakeAutoUpdater()
const electron = { isPackaged: true }

vi.mock('electron', () => ({ app: { get isPackaged() { return electron.isPackaged } } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: fake } }))
vi.mock('./rpc/server', () => ({ emitMain: vi.fn<() => void>() }))

const { Updater } = await import('./updater')

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  fake.removeAllListeners()
  fake.checkForUpdates.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Updater', () => {
  it('keeps checking automatically after an update that downloaded fails to install', async () => {
    const updater = new Updater()
    expect(updater.enabled).toBe(true)
    updater.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)

    // The update downloads: periodic checks pause while it waits for a restart.
    fake.emit('update-downloaded', { version: '0.1.0-nightly.2' })
    expect(updater.state.status).toBe('ready')
    await vi.advanceTimersByTimeAsync(8 * HOUR)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)

    // Squirrel.Mac rejects it (for example a bad signature): checks must resume.
    fake.emit('error', new Error('Code signature did not match'))
    expect(updater.state.status).toBe('error')
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3)
    updater.stop()
  })

  it('does not restart checks after the app stopped the updater', async () => {
    const updater = new Updater()
    updater.start()
    await vi.advanceTimersByTimeAsync(10_000)
    updater.stop()
    fake.emit('error', new Error('late failure'))
    await vi.advanceTimersByTimeAsync(8 * HOUR)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('ignores AMETHYST_DISABLE_UPDATES and AMETHYST_SMOKE in a packaged build without their flags', () => {
    vi.stubEnv('AMETHYST_DISABLE_UPDATES', '1')
    vi.stubEnv('AMETHYST_SMOKE', '1')
    expect(new Updater().enabled).toBe(true)
    const argv = process.argv
    process.argv = [...argv, '--amethyst-disable-updates']
    try {
      expect(new Updater().enabled).toBe(false)
    } finally {
      process.argv = argv
    }
  })
})
