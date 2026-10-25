import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, FileText, FileWarning, FolderOpen, Radio, RotateCcw, XOctagon } from 'lucide-react'
import type { CrashReport } from '@shared/services'
import { Badge, Button, Checkbox, EmptyState, IconButton, SearchField, Spinner, Switch, VirtualList, cn, type VirtualListHandle } from '@/ui'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { QueryError } from '@/app/RouteStates'
import { openInstance } from '@/app/commands'
import { copyToClipboard } from '@/app/clipboard'
import { findTargetRef } from '@/app/ui-store'
import { formatDuration } from '@/app/visuals'
import { instanceActions, useInstance, useInstances } from '@/data/instances'
import { useLaunchEntry, type ExitInfo } from '@/data/launch'
import { useGameLog } from '@/data/logs'
import type { CrashSummary, LogLevel, LogLine } from '@/data/types'
import { useInstanceId } from './parts'

const LEVELS: { level: LogLevel; label: string }[] = [
  { level: 'info', label: 'Info' },
  { level: 'warn', label: 'Warn' },
  { level: 'error', label: 'Error' },
  { level: 'debug', label: 'Debug' },
]
const levelStyle: Record<LogLevel, { text: string; glyph: string; row?: string }> = {
  debug: { text: 'text-label-3', glyph: '·' },
  info: { text: 'text-label-2', glyph: 'ℹ' },
  warn: { text: 'text-orange', glyph: '⚠', row: 'bg-[color-mix(in_srgb,var(--color-orange)_7%,transparent)]' },
  error: { text: 'text-red', glyph: '⨯', row: 'bg-[color-mix(in_srgb,var(--color-red)_8%,transparent)]' },
}

interface Row {
  line: LogLine
  count: number
}

/** Collapses consecutive identical lines into one row with a ×N count. */
export function collapse(lines: readonly LogLine[]): Row[] {
  const out: Row[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    if (prev && prev.line.text === line.text && prev.line.level === line.level && prev.line.source === line.source) prev.count++
    else out.push({ line, count: 1 })
  }
  return out
}

type View = 'session' | 'crash'

/** Logs tab: the live console (or the last session) and the crash report view (B3.3). */
export default function LogsTab() {
  const id = useInstanceId()
  const log = useGameLog(id)
  const launch = useLaunchEntry(id)
  const exit = launch?.phase === 'exited' ? launch.exit : undefined
  const crash = useQuery({
    queryKey: ['crash', id, log.launchId, exit?.at ?? 0],
    enabled: !!exit?.crashed || !!exit?.crashReportPath,
    queryFn: async (): Promise<CrashReport | null> => {
      try {
        return await api.launch.openCrashReport(id)
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOT_FOUND') return null
        throw e
      }
    },
  })
  const hasCrash = !!exit?.crashed
  // A new crash brings its report forward; a new run brings the live log forward.
  const runKey = `${log.launchId}:${exit?.at ?? 0}`
  const [pick, setPick] = useState<{ view: View; runKey: string }>()
  const view: View = pick?.runKey === runKey ? pick.view : hasCrash ? 'crash' : 'session'
  const setPicked = (v: View) => setPick({ view: v, runKey })

  const sessionLabel = log.running ? 'Live' : log.launchId ? 'Last session' : 'Game output'
  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Logs" className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-r border-separator bg-window-2/60 px-2 py-2">
        <h3 className="px-2 pt-1 pb-1 text-small font-semibold text-label-3">{log.running ? 'Running' : 'This session'}</h3>
        <ul className="flex flex-col gap-px">
          <li>
            <NavButton current={view === 'session'} onClick={() => setPicked('session')} icon={log.running ? <Radio className="size-4 shrink-0 text-green" /> : <FileText className="size-4 shrink-0 text-label-2" />}>
              <span className="truncate text-body">{sessionLabel}</span>
              <span className="truncate text-small text-label-2">
                {log.running ? 'Current session' : exit ? exitText(exit) : log.launchId ? 'Output of the last run' : 'Play to see output'}
              </span>
            </NavButton>
          </li>
          {hasCrash && (
            <li>
              <NavButton current={view === 'crash'} onClick={() => setPicked('crash')} icon={<FileWarning className="size-4 shrink-0 text-red" />}>
                <span className="truncate text-body">Crash report</span>
                <span className="truncate text-small text-label-2">{crash.data?.kind === 'jvm' ? 'Java crash log' : crash.data ? 'Minecraft crash report' : 'Crash summary'}</span>
              </NavButton>
            </li>
          )}
        </ul>
        <p className="mt-auto px-2 pt-3 text-small text-label-3">Older logs are in the instance’s logs folder.</p>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {view === 'crash' && hasCrash && exit ? (
          <CrashView instanceId={id} exit={exit} report={crash.data} loading={crash.isPending && crash.fetchStatus !== 'idle'} error={crash.isError ? crash.error : undefined} retry={() => void crash.refetch()} />
        ) : (
          <LogViewer instanceId={id} key={log.launchId ?? 'none'} />
        )}
      </div>
    </div>
  )
}

function exitText(exit: ExitInfo): string {
  if (exit.killed) return 'Stopped'
  if (exit.crashed) return `Crashed${exit.code !== null ? ` (code ${exit.code})` : ''}`
  return `Exited${exit.code !== null ? ` (code ${exit.code})` : ''} after ${formatDuration(exit.durationMs)}`
}

function NavButton({ current, onClick, icon, children }: { current: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-fill', current && 'bg-selection')}
    >
      {icon}
      <span className="flex min-w-0 flex-col">{children}</span>
    </button>
  )
}

async function revealLatestLog(instanceId: string) {
  try {
    const d = await api.instances.get(instanceId)
    await api.shell.showItemInFolder(`${d.path}/logs/latest.log`).catch(() => api.shell.openFolder(d.path))
  } catch (e) {
    toastError(e, 'Couldn’t show the log in Finder')
  }
}

function LogViewer({ instanceId }: { instanceId: string }) {
  const log = useGameLog(instanceId)
  const launch = useLaunchEntry(instanceId)
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(['info', 'warn', 'error']))
  const [follow, setFollow] = useState(true)
  const [timestamps, setTimestamps] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const [matchIndex, setMatchIndex] = useState(0)
  const list = useRef<VirtualListHandle>(null)

  const rows = useMemo(() => collapse(log.rows.filter((l) => levels.has(l.level))), [log.rows, levels])
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => (q ? rows.flatMap((r, i) => (r.line.text.toLowerCase().includes(q) || r.line.source.toLowerCase().includes(q) ? [i] : [])) : []), [rows, q])
  const current = matches.length ? Math.min(matchIndex, matches.length - 1) : -1

  const step = (d: number) => {
    if (!matches.length) return
    const next = (current + d + matches.length) % matches.length
    setMatchIndex(next)
    setFollow(false)
    list.current?.scrollToIndex(matches[next]!, 'center')
  }
  // ⌘G / ⇧⌘G from the menu bar.
  useEffect(() => {
    const on = (e: Event) => step((e as CustomEvent<number>).detail)
    window.addEventListener('amethyst:find-step', on)
    return () => window.removeEventListener('amethyst:find-step', on)
  })

  const toggleLevel = (l: LogLevel, on: boolean) => {
    const next = new Set(levels)
    if (on) next.add(l)
    else next.delete(l)
    setLevels(next)
  }

  const copyAll = () => {
    const text = rows.map((r) => `[${r.line.time}] [${r.line.thread}/${r.line.level.toUpperCase()}] (${r.line.source}) ${r.line.text}${r.count > 1 ? ` ×${r.count}` : ''}`).join('\n')
    copyToClipboard(text, `Copied ${rows.length} lines`)
  }

  const exit = launch?.phase === 'exited' && launch.launchId === log.launchId ? launch.exit : undefined
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
        <SearchField
          ref={findTargetRef}
          value={query}
          onValueChange={(v) => {
            setQuery(v)
            setMatchIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
          placeholder="Search log"
          className="w-[200px]"
        />
        {q && (
          <>
            <span className="min-w-14 text-small text-label-2 tabular" aria-live="polite">
              {matches.length ? `${current + 1} of ${matches.length}` : 'No matches'}
            </span>
            <IconButton label="Previous Match" shortcut="shift+mod+g" size="sm" disabled={!matches.length} onClick={() => step(-1)}>
              <ChevronUp />
            </IconButton>
            <IconButton label="Next Match" shortcut="mod+g" size="sm" disabled={!matches.length} onClick={() => step(1)}>
              <ChevronDown />
            </IconButton>
          </>
        )}
        <div className="ml-1 flex items-center gap-2.5" role="group" aria-label="Levels">
          {LEVELS.map((l) => (
            <Checkbox key={l.level} checked={levels.has(l.level)} onCheckedChange={(on) => toggleLevel(l.level, on)} label={l.label} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <label className="flex items-center gap-1.5 pr-1 text-body">
            <Switch size="sm" checked={follow} onCheckedChange={setFollow} aria-label="Follow tail" />
            Follow
          </label>
          <Checkbox checked={timestamps} onCheckedChange={setTimestamps} label="Time" />
          <span className="mx-1 h-5 w-px bg-separator" aria-hidden />
          <IconButton label="Copy All" disabled={!rows.length} onClick={copyAll}>
            <Copy />
          </IconButton>
          <IconButton label="Reveal in Finder" onClick={() => void revealLatestLog(instanceId)}>
            <FolderOpen />
          </IconButton>
        </div>
      </div>
      {log.dropped > 0 && <p className="shrink-0 border-b border-separator bg-fill px-3 py-1 text-small text-label-2">{log.dropped.toLocaleString()} earlier lines aren’t shown. The full log is in the logs folder.</p>}
      <div className="relative flex min-h-0 flex-1 flex-col bg-window">
        {log.loading && !log.rows.length ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={20} label="Loading log" />
          </div>
        ) : log.error && !log.rows.length ? (
          <QueryError error={log.error} onRetry={() => openInstance(instanceId, 'logs')} what="the log" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title={log.rows.length ? 'No lines at these levels' : log.running ? 'Waiting for output…' : 'No output yet'}
            description={log.rows.length || log.running ? undefined : 'Play this instance to see the game’s output here.'}
          />
        ) : (
          <VirtualList
            ref={list}
            role="log"
            aria-label="Game log"
            items={rows}
            rowHeight={18}
            paddingY={6}
            followTail={follow}
            onAtBottomChange={setAtBottom}
            getKey={(r) => r.line.id}
            className="selectable flex-1 font-mono text-callout"
            renderRow={(r, i) => <LogRow row={r} timestamps={timestamps} query={q} current={matches[current] === i} />}
          />
        )}
        {!atBottom && rows.length > 0 && (
          <Button
            className="absolute right-5 bottom-4 shadow-popover"
            icon={<ArrowDownToLine />}
            onClick={() => {
              list.current?.scrollToBottom()
              setFollow(true)
            }}
          >
            Jump to Bottom
          </Button>
        )}
      </div>
      {exit && (
        <p className={cn('shrink-0 border-t border-separator px-3 py-1.5 text-small', exit.crashed ? 'text-red' : 'text-label-2')} data-log-exit>
          {exit.killed ? 'Stopped by you' : exit.crashed ? `Game crashed${exit.code !== null ? ` (code ${exit.code})` : ''}` : `Game exited${exit.code !== null ? ` (code ${exit.code})` : ''}`} after{' '}
          {formatDuration(exit.durationMs)}
        </p>
      )}
    </>
  )
}

function LogRow({ row, timestamps, query, current }: { row: Row; timestamps: boolean; query: string; current: boolean }) {
  const s = levelStyle[row.line.level]
  const continuation = row.line.id !== String(row.line.n)
  return (
    <div className={cn('flex h-[18px] items-center gap-2 px-3 leading-[18px] whitespace-pre', s.row, current && 'bg-[color-mix(in_srgb,var(--color-yellow)_30%,transparent)]')}>
      {timestamps && <span className={cn('shrink-0 text-label-3', continuation && 'invisible')}>{row.line.time}</span>}
      <span className={cn('w-3 shrink-0 text-center', s.text, continuation && 'invisible')} aria-label={row.line.level}>
        {s.glyph}
      </span>
      <span className={cn('w-[112px] shrink-0 truncate text-label-3', continuation && 'invisible')}>{row.line.source}</span>
      <span className={cn('min-w-0 truncate', row.line.level === 'error' ? 'text-red' : row.line.level === 'warn' ? 'text-orange' : 'text-label')}>
        <Mark text={row.line.text} query={query} />
      </span>
      {row.count > 1 && (
        <span className="shrink-0 rounded-full bg-fill-2 px-1.5 font-sans text-caption leading-4 font-semibold text-label-2" aria-label={`repeated ${row.count} times`}>
          ×{row.count}
        </span>
      )}
    </div>
  )
}

function Mark({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const i = text.toLowerCase().indexOf(query)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-[color-mix(in_srgb,var(--color-yellow)_55%,transparent)] text-label">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

/** A heuristic headline and suspects from a crash report (best effort; the raw text is below). */
export function summarizeCrash(text: string, exit: ExitInfo): CrashSummary {
  const lines = text.split('\n')
  const description = lines.find((l) => l.startsWith('Description:'))?.slice('Description:'.length).trim()
  const exception = lines.find((l) => /^\S+(Exception|Error)(:|$)/.test(l.trim()))?.trim()
  let headline = description ?? exception ?? ''
  if (/OutOfMemoryError/.test(text)) headline = 'Out of memory. Give the game more memory in the instance’s Settings tab.'
  else if (exit.nativeLoadError === 'architecture') headline = 'A native library was built for a different processor.'
  else if (exit.nativeLoadError === 'unsatisfied-link') headline = 'A native library couldn’t be loaded.'
  const suspects: CrashSummary['suspects'] = []
  for (const m of text.matchAll(/(?:Mod ID|modid):?\s*'?([a-z0-9_-]{2,64})'?/gi)) {
    const modId = m[1]!.toLowerCase()
    if (!['minecraft', 'forge', 'neoforge', 'fabricloader', 'java'].includes(modId) && !suspects.some((s) => s.modId === modId)) suspects.push({ modId, name: modId })
    if (suspects.length >= 3) break
  }
  return { exitCode: exit.code ?? -1, headline, suspects }
}

function CrashView({ instanceId, exit, report, loading, error, retry }: { instanceId: string; exit: ExitInfo; report: CrashReport | null | undefined; loading: boolean; error?: unknown; retry: () => void }) {
  const { data: instances } = useInstances()
  const { data: detail } = useInstance(instanceId)
  const inst = instances?.find((i) => i.id === instanceId)
  const text = report?.text ?? ''
  const summary = summarizeCrash(text, exit)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-crash-view>
      <section aria-label="Crash summary" className="m-4 mb-0 rounded-xl bg-[color-mix(in_srgb,var(--color-red)_7%,transparent)] p-4 shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--color-red)_25%,transparent)]">
        <div className="flex items-start gap-3">
          <XOctagon className="mt-0.5 size-5 shrink-0 text-red" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-title3 font-semibold">Minecraft crashed</h2>
              {exit.code !== null && <Badge tone="error">Exit code {exit.code}</Badge>}
            </div>
            {summary.headline && <p className="mt-1 text-body">{summary.headline}</p>}
            {summary.suspects.length > 0 && (
              <p className="mt-1.5 text-callout text-label-2">
                Suspected:{' '}
                {summary.suspects.map((s, i) => (
                  <span key={s.modId}>
                    {i > 0 && ', '}
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => openInstance(instanceId, 'mods')}>
                      {s.name}
                    </button>
                  </span>
                ))}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={!text} onClick={() => copyToClipboard(text, 'Copied crash report')}>
                Copy Report
              </Button>
              <Button
                disabled={!report?.path && !detail}
                onClick={() =>
                  void (report?.path ? api.shell.showItemInFolder(report.path) : detail ? api.shell.openFolder(detail.path) : Promise.resolve()).catch((e: unknown) => toastError(e, 'Couldn’t show it in Finder'))
                }
              >
                Reveal in Finder
              </Button>
              <Button variant="primary" icon={<RotateCcw />} disabled={!inst || inst.state.kind !== 'idle'} onClick={() => inst && instanceActions.launch(inst)}>
                Relaunch
              </Button>
            </div>
          </div>
        </div>
      </section>
      {loading ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <Spinner size={20} label="Loading crash report" />
        </div>
      ) : error ? (
        <QueryError error={error} onRetry={retry} what="the crash report" />
      ) : report ? (
        <pre className="selectable m-4 rounded-lg bg-surface p-3 font-mono text-callout leading-[18px] whitespace-pre-wrap text-label shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
          {text}
          {report.truncated && '\n… (truncated; the full report is in the instance folder)'}
        </pre>
      ) : (
        <p className="m-4 text-body text-label-2">The game left no crash report. Check the session log for the last lines it printed.</p>
      )}
    </div>
  )
}
