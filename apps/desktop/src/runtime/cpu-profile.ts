/**
 * Dev flag `AMETHYST_RUNTIME_CPU_PROF=<dir>` (the benchmark's `--cpu-prof`): profile the runtime
 * from boot to shutdown with the inspector and write a `.cpuprofile` (open it in Chrome DevTools).
 * Node's `--cpu-prof` flag is not honoured by Electron utility processes, hence the inspector.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import path from 'node:path'

let session: Session | undefined

export async function startCpuProfile(): Promise<void> {
  if (!process.env.AMETHYST_RUNTIME_CPU_PROF || session) return
  session = new Session()
  session.connect()
  await session.post('Profiler.enable')
  await session.post('Profiler.setSamplingInterval', { interval: 500 })
  await session.post('Profiler.start')
}

/** Stop profiling and write the profile; a no-op unless profiling. */
export async function stopCpuProfile(): Promise<void> {
  const dir = process.env.AMETHYST_RUNTIME_CPU_PROF
  if (!dir || !session) return
  const { profile } = await session.post('Profiler.stop')
  session.disconnect()
  session = undefined
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `runtime-${process.pid}.cpuprofile`), JSON.stringify(profile))
}
