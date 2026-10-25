import { describe, expect, it } from 'vitest'
import { runPreLaunchCommand } from './service'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const run = (command: string, timeoutMs: number, signal = new AbortController().signal) =>
  runPreLaunchCommand(command, { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, signal, timeoutMs })

describe('runPreLaunchCommand', () => {
  it('resolves promptly when the command backgrounds a process that keeps the pipes open', async () => {
    const t = performance.now()
    const r = await run('sleep 30 & echo $! >&2', 20_000)
    expect(performance.now() - t).toBeLessThan(5_000)
    expect(r.code).toBe(0)
    const pid = Number(r.stderr.trim())
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 'SIGKILL')
  })

  it('kills the whole process group on timeout instead of hanging', async () => {
    const t = performance.now()
    const r = await run('sleep 30 & echo $! >&2; wait', 300)
    expect(performance.now() - t).toBeLessThan(5_000)
    expect(r.code).toBeNull()
    const pid = Number(r.stderr.trim())
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(pid)).toBe(false)
  })

  it('rejects and kills the group when the launch is cancelled', async () => {
    const controller = new AbortController()
    const pending = run('sleep 30', 20_000, controller.signal)
    setTimeout(() => controller.abort(new Error('cancelled')), 100)
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('reports the exit code and stderr tail', async () => {
    await expect(run('echo nope >&2; exit 3', 20_000)).resolves.toEqual({ code: 3, stderr: 'nope\n' })
  })
})
