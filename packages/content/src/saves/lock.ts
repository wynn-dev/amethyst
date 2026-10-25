/**
 * Is a world open in Minecraft right now?
 *
 * While a world is loaded, current Minecraft versions keep `<world>/session.lock` open and hold
 * an exclusive lock on it (`FileChannel.tryLock`, an `fcntl` record lock on macOS). Node cannot
 * test an `fcntl` lock, but it can ask who has the file open: `/usr/sbin/lsof -t` lists the PIDs
 * holding any of the given files (exit status 1 when none do). Older versions (before the
 * directory lock) only open the file briefly, so callers must still combine this with "the
 * launcher's own game is running"; this probe adds games started by other launchers (external
 * instance folders) and worlds still open after a runtime restart.
 *
 * The probe is cheap (one `lsof` for any number of worlds) and bounded by a timeout. When it
 * cannot answer (no `lsof`, a timeout, another OS) it returns `undefined`, never a guess.
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'

const LSOF = '/usr/sbin/lsof'
const DEFAULT_TIMEOUT_MS = 5000

export interface SessionLockOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * PIDs of the processes that have the `session.lock` of any of `worldDirs` open: `[]` when none
 * do (or no world has a lock file), `undefined` when that cannot be determined.
 */
export async function sessionLockHolders(worldDirs: readonly string[], options: SessionLockOptions = {}): Promise<number[] | undefined> {
  const locks: string[] = []
  for (const dir of worldDirs) {
    const file = path.join(dir, 'session.lock')
    // oxlint-disable-next-line no-await-in-loop -- a handful of worlds
    if ((await lstat(file).catch(() => undefined))?.isFile()) locks.push(file)
  }
  if (locks.length === 0) return []
  if (process.platform !== 'darwin') return undefined
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-t', '-w', '--', ...locks],
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}), windowsHide: true },
      (error, stdout) => {
        const pids = String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^\d+$/.test(l))
          .map(Number)
        if (pids.length > 0) return resolve(pids)
        // Exit status 1 with no output: nobody has the files open.
        if (!error || (error as { code?: unknown }).code === 1) return resolve([])
        resolve(undefined)
      },
    )
  })
}

/** True when a world's `session.lock` is held open, false when not, `undefined` when unknown. */
export async function isWorldOpen(worldDir: string, options: SessionLockOptions = {}): Promise<boolean | undefined> {
  const holders = await sessionLockHolders([worldDir], options)
  return holders === undefined ? undefined : holders.length > 0
}
