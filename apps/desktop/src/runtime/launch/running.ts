/**
 * Games outlive the runtime: they are spawned detached (their own process group), so a runtime
 * restart (crash, update) must not forget them. Every running game is recorded in
 * `running-games.json` with its pid and the kernel's start time for that pid; at boot the live
 * ones are adopted again. The start time guards against pid reuse: a record only matches a
 * process whose pid *and* start time are unchanged.
 */
import { execFile } from 'node:child_process'
import type { GameProcess, LaunchResult } from '@amethyst/game'
import { JsonDocument } from '../store/json-store'
import { asRecord, readInt, readString } from '../util/parse'

export interface RunningRecord {
  instanceId: string
  launchId: string
  pid: number
  /** `Date.now()` at spawn (play time and `startedAt` in the UI). */
  startedAt: number
  /** The process start time reported by `ps -o lstart=` (C locale), compared verbatim. */
  processStart: string
  versionId?: string
}

/** Reads a process's start time, or `undefined` when there is no such process. */
export type ProcessStartReader = (pid: number) => Promise<string | undefined>

/** `ps -o lstart= -p <pid>` in the C locale: `Sat Oct 25 10:00:00 2026`, or `undefined`. */
export const processStartTime: ProcessStartReader = (pid) =>
  new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 1) {
      resolve(undefined)
      return
    }
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 5_000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim()
      resolve(err || !out ? undefined : out)
    })
  })

/** True while a process with this pid exists (even one owned by another user). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface RunningDoc {
  games: RunningRecord[]
}

function parseRecord(raw: unknown): RunningRecord | undefined {
  const o = asRecord(raw)
  const instanceId = readString(o.instanceId)
  const launchId = readString(o.launchId)
  const pid = readInt(o.pid, 2)
  const startedAt = readInt(o.startedAt, 0)
  const processStart = readString(o.processStart)
  const versionId = readString(o.versionId)
  if (!instanceId || !launchId || pid === undefined || startedAt === undefined || !processStart) return undefined
  return { instanceId, launchId, pid, startedAt, processStart, ...(versionId ? { versionId } : {}) }
}

/** The persisted list of running games. Writes are serialised by the document. */
export class RunningGamesStore {
  readonly #doc: JsonDocument<RunningDoc>
  #loaded: Promise<unknown> | undefined

  constructor(file: string) {
    this.#doc = new JsonDocument<RunningDoc>(
      file,
      {
        version: 1,
        parse: (raw) => ({ games: (Array.isArray(raw.games) ? raw.games : []).map(parseRecord).filter((r): r is RunningRecord => r !== undefined) }),
        defaults: () => ({ games: [] }),
      },
      { backup: false },
    )
  }

  async #ready(): Promise<void> {
    this.#loaded ??= this.#doc.load().catch(() => undefined)
    await this.#loaded
  }

  async list(): Promise<RunningRecord[]> {
    await this.#ready()
    return this.#doc.value.games
  }

  async add(record: RunningRecord): Promise<void> {
    await this.#ready()
    await this.#doc.update((d) => ({ games: [...d.games.filter((g) => g.launchId !== record.launchId && g.instanceId !== record.instanceId), record] }))
  }

  async remove(launchId: string): Promise<void> {
    await this.#ready()
    if (!this.#doc.value.games.some((g) => g.launchId === launchId)) return
    await this.#doc.update((d) => ({ games: d.games.filter((g) => g.launchId !== launchId) }))
  }

  async replace(games: RunningRecord[]): Promise<void> {
    await this.#ready()
    await this.#doc.update(() => ({ games }))
  }

  async flush(): Promise<void> {
    await this.#doc.flush()
  }
}

/**
 * A {@link GameProcess} for a game started by an earlier runtime. It is not our child, so its exit
 * is noticed by polling `kill(pid, 0)` (only while it runs) and the exit code is unknown. Signals
 * go to its process group, and only after the start time still matches (no pid reuse).
 */
export function adoptedProcess(record: RunningRecord, options: { pollMs: number; alive?: (pid: number) => boolean; processStart?: ProcessStartReader }): GameProcess {
  const alive = options.alive ?? isAlive
  const readStart = options.processStart ?? processStartTime
  let killed = false
  let done = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (r: LaunchResult) => void
  const exited = new Promise<LaunchResult>((r) => (resolve = r))
  const finish = () => {
    if (done) return
    done = true
    clearInterval(poll)
    clearTimeout(killTimer)
    resolve({ exitCode: null, signal: null, crashed: false, killed, ready: true, durationMs: Date.now() - record.startedAt })
  }
  const poll = setInterval(() => {
    if (!alive(record.pid)) finish()
  }, options.pollMs)
  poll.unref?.()
  const send = async (sig: NodeJS.Signals) => {
    if (done || (await readStart(record.pid)) !== record.processStart) return
    try {
      process.kill(-record.pid, sig)
    } catch {
      try {
        process.kill(record.pid, sig)
      } catch {
        // Already gone.
      }
    }
  }
  return {
    pid: record.pid,
    startedAt: record.startedAt,
    get ready() {
      return true
    },
    exited,
    kill: (timeoutMs = 10_000) => {
      if (!done && !killed) {
        killed = true
        void send('SIGTERM')
        killTimer = setTimeout(() => void send('SIGKILL'), timeoutMs)
      }
      return exited
    },
  }
}
