import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, FileText, FileWarning, FolderOpen, RotateCcw, XOctagon } from 'lucide-react'
import type { CrashReport } from '@shared/services'
import { Button, Checkbox, Dot, EmptyState, IconButton, SearchField, Spinner, Switch, VirtualList, cn, type VirtualListHandle } from '@/ui'
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
/** Muted level colours: errors red, warnings yellow, the rest grey. `tag` is the level column. */
const levelStyle: Record<LogLevel, { text: string; tag: string }> = {
  debug: { text: 'text-label-3', tag: 'DEBUG' },
  info: { text: 'text-label-2', tag: 'INFO' },
  warn: { text: 'text-yellow', tag: 'WARN' },
  error: { text: 'text-red', tag: 'ERROR' },
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
  const sessionDetail = log.running ? 'Current session' : exit ? exitText(exit) : log.launchId ? 'Output of the last run' : 'Play to see output'
  const nav = (
    <nav aria-label="Logs" className="flex shrink-0 items-center gap-0.5">
      <NavButton current={view === 'session'} onClick={() => setPicked('session')} title={sessionDetail} icon={log.running ? <Dot tone="green" label="Running" /> : undefined}>
        {sessionLabel}
      </NavButton>
      {hasCrash && (
        <NavButton
          current={view === 'crash'}
          onClick={() => setPicked('crash')}
          title={crash.data?.kind === 'jvm' ? 'Java crash log' : crash.data ? 'Minecraft crash report' : 'Crash summary'}
          icon={<FileWarning className="size-[13px] shrink-0 text-red" strokeWidth={1.75} />}
        >
          Crash report
        </NavButton>
      )}
    </nav>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view === 'crash' && hasCrash && exit ? (
        <CrashView nav={nav} instanceId={id} exit={exit} report={crash.data} loading={crash.isPending && crash.fetchStatus !== 'idle'} error={crash.isError ? crash.error : undefined} retry={() => void crash.refetch()} />
      ) : (
        <LogViewer nav={nav} instanceId={id} key={log.launchId ?? 'none'} />
      )}
    </div>
  )
}

function exitText(exit: ExitInfo): string {
  if (exit.killed) return 'Stopped'
  if (exit.crashed) return `Crashed${exit.code !== null ? ` (code ${exit.code})` : ''}`
  return `Exited${exit.code !== null ? ` (code ${exit.code})` : ''} after ${formatDuration(exit.durationMs)}`
}

/** A chip in the toolbar's log list (the mockup's `.chip`); the current one is filled grey. */
function NavButton({ current, onClick, icon, title, children }: { current: boolean; onClick: () => void; icon?: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      title={title}
      onClick={onClick}
      className={cn('flex h-6 items-center gap-1.5 rounded-md px-2 text-callout whitespace-nowrap text-label-2 outline-none hover:text-label focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]', current && 'bg-fill-2 text-label')}
    >
      {icon}
      {children}
    </button>
  )
}

/** The slim toolbar over a log or crash view. */
function LogToolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex h-10 shrink-0 items-center gap-2 border-b border-separator px-3">{children}</div>
}

const toolbarDivider = <span className="mx-0.5 h-4 w-px shrink-0 bg-separator" aria-hidden />

async function revealLatestLog(instanceId: string) {
  try {
    const d = await api.instances.get(instanceId)
    await api.shell.showItemInFolder(`${d.path}/logs/latest.log`).catch(() => api.shell.openFolder(d.path))
  } catch (e) {
    toastError(e, 'Couldn’t show the log in Finder')
  }
}

function LogViewer({ instanceId, nav }: { instanceId: string; nav: React.ReactNode }) {
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
      <LogToolbar>
        {nav}
        {toolbarDivider}
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
          className="w-[180px] min-w-[120px] shrink"
        />
        {q && (
          <>
            <span className="min-w-14 font-mono text-[11px] whitespace-nowrap text-label-2 tabular" aria-live="polite">
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
        <div className="ml-1 flex shrink-0 items-center gap-2.5 text-callout" role="group" aria-label="Levels">
          {LEVELS.map((l) => (
            <Checkbox key={l.level} checked={levels.has(l.level)} onCheckedChange={(on) => toggleLevel(l.level, on)} label={l.label} />
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-callout">
          <label className="flex items-center gap-1.5 pr-1">
            <Switch size="sm" checked={follow} onCheckedChange={setFollow} aria-label="Follow tail" />
            Follow
          </label>
          <Checkbox checked={timestamps} onCheckedChange={setTimestamps} label="Time" />
          {toolbarDivider}
          <IconButton label="Copy All" disabled={!rows.length} onClick={copyAll}>
            <Copy />
          </IconButton>
          <IconButton label="Reveal in Finder" onClick={() => void revealLatestLog(instanceId)}>
            <FolderOpen />
          </IconButton>
        </div>
      </LogToolbar>
      {log.dropped > 0 && <p className="shrink-0 border-b border-separator px-4 py-1 text-meta text-label-2">{log.dropped.toLocaleString()} earlier lines aren’t shown. The full log is in the logs folder.</p>}
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
            description={log.rows.length || log.running ? undefined : 'Play this instance to see the game’s output here. Older logs are in the instance’s logs folder.'}
          />
        ) : (
          <VirtualList
            ref={list}
            role="log"
            aria-label="Game log"
            items={rows}
            rowHeight={20}
            paddingY={10}
            followTail={follow}
            onAtBottomChange={setAtBottom}
            getKey={(r) => r.line.id}
            className="selectable flex-1 font-mono text-[11.5px]"
            renderRow={(r, i) => <LogRow row={r} timestamps={timestamps} query={q} current={matches[current] === i} />}
          />
        )}
        {!atBottom && rows.length > 0 && (
          <Button
            className="glass absolute right-4 bottom-3 shadow-popover"
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
        <p className={cn('shrink-0 border-t border-separator px-4 py-1.5 text-meta', exit.crashed ? 'text-red' : 'text-label-2')} data-log-exit>
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
    <div className={cn('flex h-5 items-center gap-3 px-4 leading-5 whitespace-pre', current && 'bg-[color-mix(in_srgb,var(--color-yellow)_22%,transparent)]')}>
      {timestamps && <span className={cn('shrink-0 text-label-3 tabular', continuation && 'invisible')}>{row.line.time}</span>}
      <span className={cn('w-[5ch] shrink-0', row.line.level === 'info' ? 'text-label-3' : s.text, continuation && 'invisible')} aria-label={row.line.level}>
        {s.tag}
      </span>
      <span className={cn('w-[112px] shrink-0 truncate text-label-3', continuation && 'invisible')}>{row.line.source}</span>
      <span className={cn('min-w-0 truncate', s.text)}>
        <Mark text={row.line.text} query={query} />
      </span>
      {row.count > 1 && (
        <span className="shrink-0 text-label-3 tabular" aria-label={`repeated ${row.count} times`}>
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
      <mark className="rounded-[2px] bg-[color-mix(in_srgb,var(--color-yellow)_45%,transparent)] text-label">{text.slice(i, i + query.length)}</mark>
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

function CrashView({
  instanceId,
  nav,
  exit,
  report,
  loading,
  error,
  retry,
}: {
  instanceId: string
  nav: React.ReactNode
  exit: ExitInfo
  report: CrashReport | null | undefined
  loading: boolean
  error?: unknown
  retry: () => void
}) {
  const { data: instances } = useInstances()
  const { data: detail } = useInstance(instanceId)
  const inst = instances?.find((i) => i.id === instanceId)
  const text = report?.text ?? ''
  const summary = summarizeCrash(text, exit)
  return (
    <>
      <LogToolbar>
        {nav}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
      </LogToolbar>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3.5 pb-[18px]" data-crash-view>
        <section aria-label="Crash summary" className="overflow-hidden rounded-[10px] border border-separator">
          <header className="flex h-8 items-center gap-2 border-b border-separator px-3">
            <XOctagon className="size-[13px] shrink-0 text-red" strokeWidth={1.75} />
            <h2 className="flex-1 text-meta font-semibold text-label">Minecraft crashed</h2>
            {exit.code !== null && <span className="font-mono text-[10.5px] text-label-3 tabular">exit code {exit.code}</span>}
          </header>
          <div className="flex flex-col gap-1 px-3 py-2.5 text-compact">
            <p className={summary.headline ? undefined : 'text-label-2'}>{summary.headline || 'No cause could be read from the report. The raw text is below.'}</p>
            {summary.suspects.length > 0 && (
              <p className="text-meta text-label-2">
                Suspected:{' '}
                {summary.suspects.map((s, i) => (
                  <span key={s.modId}>
                    {i > 0 && ', '}
                    <button type="button" className="font-mono text-[11px] text-label underline decoration-separator-2 underline-offset-2 hover:decoration-label-2" onClick={() => openInstance(instanceId, 'mods')}>
                      {s.name}
                    </button>
                  </span>
                ))}
              </p>
            )}
          </div>
        </section>
        {loading ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <Spinner size={20} label="Loading crash report" />
          </div>
        ) : error ? (
          <QueryError error={error} onRetry={retry} what="the crash report" />
        ) : report ? (
          <pre className="selectable rounded-[10px] border border-separator px-3 py-2.5 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-label-2">
            {text}
            {report.truncated && '\n… (truncated; the full report is in the instance folder)'}
          </pre>
        ) : (
          <p className="text-compact text-label-2">The game left no crash report. Check the session log for the last lines it printed.</p>
        )}
      </div>
    </>
  )
}
