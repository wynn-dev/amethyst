import { useEffect, useSyncExternalStore } from 'react'
import type { GameLogLine } from '@shared/services'
import type { Events } from '@shared/events'
import { api, subscribe } from '@/lib/rpc'
import type { LogLevel, LogLine } from './types'

/*
 * The live game log of one instance. While a log view is mounted it holds a `subscribeLog`
 * reference; the runtime then pushes `launch:log` batches (≤ 10 per second, ≤ 500 lines each),
 * which are appended to a bounded buffer here. Only a `gap` (lines skipped by the runtime) or a
 * view opening mid-run pages lines in with `getLog`. The view re-renders once per batch.
 */

/** Source lines kept (the runtime keeps the last 5,000 per instance too). */
const MAX_SOURCE_LINES = 5_000
const PAGE = 5_000

const LEVEL: Record<GameLogLine['level'], LogLevel> = { TRACE: 'debug', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', FATAL: 'error' }
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** One game line → one row per text line (stack traces continue on their own rows). */
export function toRows(l: GameLogLine): LogLine[] {
  const time = timeFmt.format(l.time)
  const level = l.stream === 'stderr' && l.level === 'INFO' ? 'warn' : LEVEL[l.level]
  const source = l.logger ? (l.logger.split('.').pop() ?? l.logger) : l.stream === 'stderr' ? 'stderr' : ''
  const parts = l.text.split('\n')
  return parts.map((text, i) => ({ id: i === 0 ? String(l.seq) : `${l.seq}.${i}`, n: l.seq, time, level, thread: l.thread ?? '', source, text: i === 0 ? text : text.replace(/\t/g, '    ') }))
}

export interface GameLogSnapshot {
  launchId: string | null
  rows: LogLine[]
  running: boolean
  /** Lines older than the runtime's buffer. */
  dropped: number
  loading: boolean
  error: unknown
}

class LogBuffer {
  launchId: string | null = null
  rows: LogLine[] = []
  sourceLines = 0
  nextSeq = 0
  dropped = 0
  running = false
  loading = true
  error: unknown = null
  #pending: Events['launch:log'][] = []
  #snapshot: GameLogSnapshot | undefined
  readonly listeners = new Set<() => void>()
  refs = 0
  #unsubscribe: (() => void) | undefined

  constructor(readonly instanceId: string) {}

  snapshot(): GameLogSnapshot {
    this.#snapshot ??= { launchId: this.launchId, rows: this.rows, running: this.running, dropped: this.dropped, loading: this.loading, error: this.error }
    return this.#snapshot
  }

  #changed() {
    this.#snapshot = undefined
    for (const l of this.listeners) l()
  }

  #reset(launchId: string | null) {
    this.launchId = launchId
    this.rows = []
    this.sourceLines = 0
    this.nextSeq = 0
    this.dropped = 0
  }

  #append(lines: GameLogLine[]) {
    const fresh = lines.filter((l) => l.seq >= this.nextSeq)
    if (!fresh.length) return
    const added = fresh.flatMap(toRows)
    let rows = this.rows.concat(added)
    this.sourceLines += fresh.length
    this.nextSeq = fresh[fresh.length - 1]!.seq + 1
    // Trim in chunks so a busy log doesn't copy the array on every batch.
    if (this.sourceLines > MAX_SOURCE_LINES * 1.1) {
      const cutSeq = this.nextSeq - MAX_SOURCE_LINES
      const firstKept = rows.findIndex((r) => r.n >= cutSeq)
      this.dropped += rows.slice(0, Math.max(0, firstKept)).filter((r) => r.id === String(r.n)).length
      rows = firstKept > 0 ? rows.slice(firstKept) : rows
      this.sourceLines = MAX_SOURCE_LINES
    }
    this.rows = rows
  }

  async #page(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential by definition
      const page = await api.launch.getLog(this.instanceId, { since: this.nextSeq, limit: PAGE })
      if (page.launchId !== this.launchId) {
        this.#reset(page.launchId)
        this.dropped = page.dropped
      }
      this.running = page.running
      this.#append(page.lines)
      if (page.lines.length < PAGE) return
    }
  }

  async start() {
    this.#unsubscribe = subscribe('launch:log', (e) => {
      if (e.instanceId !== this.instanceId) return
      if (this.loading) this.#pending.push(e)
      else void this.#apply(e)
    })
    const stopState = subscribe('launch:state', (e) => {
      if (e.instanceId !== this.instanceId) return
      const running = e.state === 'running' || e.state === 'preparing'
      if (e.state === 'preparing' && e.launchId !== this.launchId) this.#reset(e.launchId)
      if (running !== this.running || e.state === 'preparing') {
        this.running = running
        this.#changed()
      }
    })
    const unsubLog = this.#unsubscribe
    this.#unsubscribe = () => {
      unsubLog()
      stopState()
    }
    try {
      await api.launch.subscribeLog(this.instanceId)
      await this.#page()
      this.error = null
    } catch (e) {
      this.error = e
    }
    this.loading = false
    const queued = this.#pending
    this.#pending = []
    for (const e of queued) await this.#apply(e, false)
    this.#changed()
  }

  async #apply(e: Events['launch:log'], notify = true) {
    if (e.launchId !== this.launchId) this.#reset(e.launchId)
    this.running = true
    if (e.gap || (e.lines[0] && e.lines[0].seq > this.nextSeq)) {
      try {
        await this.#page()
      } catch {
        // The live lines still show; the gap stays visible as a jump in sequence numbers.
      }
    }
    this.#append(e.lines)
    if (notify) this.#changed()
  }

  stop() {
    this.#unsubscribe?.()
    void api.launch.unsubscribeLog(this.instanceId).catch(() => {})
  }
}

const buffers = new Map<string, LogBuffer>()

function acquire(instanceId: string): LogBuffer {
  let b = buffers.get(instanceId)
  if (!b) {
    b = new LogBuffer(instanceId)
    buffers.set(instanceId, b)
  }
  if (b.refs++ === 0) void b.start()
  return b
}

function release(b: LogBuffer) {
  if (--b.refs > 0) return
  b.stop()
  buffers.delete(b.instanceId)
}

const EMPTY: GameLogSnapshot = { launchId: null, rows: [], running: false, dropped: 0, loading: true, error: null }

/** The last run's output of an instance, live while the game runs. */
export function useGameLog(instanceId: string): GameLogSnapshot {
  useEffect(() => {
    if (!instanceId) return
    const b = acquire(instanceId)
    return () => release(b)
  }, [instanceId])
  return useSyncExternalStore(
    (onChange) => {
      const b = buffers.get(instanceId)
      if (!b) return () => {}
      b.listeners.add(onChange)
      return () => b.listeners.delete(onChange)
    },
    () => buffers.get(instanceId)?.snapshot() ?? EMPTY,
  )
}
