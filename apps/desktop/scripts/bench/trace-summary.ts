/* oxlint-disable no-console -- a CLI that reports on stdout */
/**
 * Summarise a Chrome trace written by the benchmark (`pnpm bench --trace`):
 *
 *   pnpm --filter @amethyst/desktop exec tsx scripts/bench/trace-summary.ts <trace.json>
 *
 * Prints, per process and thread, the tasks longer than 50 ms with the events that took most of
 * their time, plus the total time spent in style recalculation, layout and forced (synchronous)
 * layouts from script: the usual signs of layout thrash.
 */
import { readFile } from 'node:fs/promises'

interface TraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: { name?: string; data?: { stackTrace?: unknown } }
}

const file = process.argv[2]
if (!file) {
  console.error('usage: trace-summary.ts <trace.json>')
  process.exit(2)
}
const raw = JSON.parse(await readFile(file, 'utf8')) as TraceEvent[] | { traceEvents: TraceEvent[] }
const events = Array.isArray(raw) ? raw : raw.traceEvents

const processNames = new Map<number, string>()
const threadNames = new Map<string, string>()
for (const e of events) {
  if (e.ph !== 'M') continue
  if (e.name === 'process_name') processNames.set(e.pid, e.args?.name ?? '')
  if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name ?? '')
}
const where = (e: TraceEvent) => `${processNames.get(e.pid) ?? e.pid} / ${threadNames.get(`${e.pid}:${e.tid}`) ?? e.tid}`

const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
// Top-level tasks of each thread's message loop (older traces name them RunTask).
const taskName = complete.some((e) => e.name === 'ThreadControllerImpl::RunTask') ? 'ThreadControllerImpl::RunTask' : 'RunTask'
const tasks = complete.filter((e) => e.name === taskName)
const long = tasks.filter((e) => (e.dur ?? 0) > 50_000).toSorted((a, b) => (b.dur ?? 0) - (a.dur ?? 0))

const byThread = new Map<string, TraceEvent[]>()
for (const e of complete) {
  const k = `${e.pid}:${e.tid}`
  let list = byThread.get(k)
  if (!list) byThread.set(k, (list = []))
  list.push(e)
}

console.log(`${tasks.length} tasks, ${long.length} longer than 50 ms`)
const over16 = new Map<string, number>()
for (const t of tasks) if ((t.dur ?? 0) > 16_000) over16.set(where(t), (over16.get(where(t)) ?? 0) + 1)
for (const [thread, n] of [...over16.entries()].toSorted((a, b) => b[1] - a[1])) console.log(`  ${n} tasks > 16 ms on ${thread}`)
for (const t of long.slice(0, 20)) {
  const inner = (byThread.get(`${t.pid}:${t.tid}`) ?? []).filter((e) => e !== t && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + (t.dur ?? 0))
  const totals = new Map<string, number>()
  for (const e of inner) totals.set(e.name, (totals.get(e.name) ?? 0) + (e.dur ?? 0))
  const top = [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, d]) => `${n} ${(d / 1000).toFixed(1)}`)
    .join(', ')
  console.log(`  ${((t.dur ?? 0) / 1000).toFixed(1)} ms  ${where(t)}  [${top}]`)
}

const sum = (name: string) => complete.filter((e) => e.name === name).reduce((a, e) => a + (e.dur ?? 0), 0) / 1000
const forced = complete.filter((e) => e.name === 'Layout' && e.args?.data?.stackTrace).length
console.log(`style recalc ${sum('UpdateLayoutTree').toFixed(1)} ms, layout ${sum('Layout').toFixed(1)} ms (${forced} forced from script), paint ${sum('Paint').toFixed(1)} ms`)
