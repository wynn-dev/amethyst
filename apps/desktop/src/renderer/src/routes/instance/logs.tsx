import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, FileText, FileWarning, FolderOpen, Radio, RotateCcw, Share, Trash2, XOctagon } from 'lucide-react'
import { Badge, Button, Checkbox, EmptyState, IconButton, SearchField, SkeletonRows, Spinner, Switch, VirtualList, cn, toast, type VirtualListHandle } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable, openInstance } from '@/app/commands'
import { findTargetRef } from '@/app/ui-store'
import { formatBytes } from '@/app/visuals'
import { instanceActions, useInstances } from '@/data/instances'
import { useCrashReport, useLogFiles, useLogLines } from '@/data/misc'
import type { LogFile, LogLevel, LogLine } from '@/data/types'
import { copyText, useInstanceId } from './parts'

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
export function collapse(lines: LogLine[]): Row[] {
  const out: Row[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    if (prev && prev.line.text === line.text && prev.line.level === line.level && prev.line.source === line.source) prev.count++
    else out.push({ line, count: 1 })
  }
  return out
}

const dayFmt = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' })
function dayLabel(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return dayFmt.format(d)
}

/** Logs tab: live console and log/crash history (B3.3). */
export default function LogsTab() {
  const id = useInstanceId()
  const files = useLogFiles(id)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const list = useMemo(() => files.data ?? [], [files.data])
  const fileId = picked && list.some((f) => f.id === picked) ? picked : list[0]?.id
  const file = list.find((f) => f.id === fileId)

  const groups = useMemo(() => {
    const out: { label: string; files: LogFile[] }[] = []
    for (const f of list) {
      const label = f.kind === 'live' ? 'Running' : dayLabel(f.createdAt)
      const g = out.find((x) => x.label === label)
      if (g) g.files.push(f)
      else out.push({ label, files: [f] })
    }
    return out
  }, [list])

  if (files.isError) return <QueryError error={files.error} onRetry={() => files.refetch()} what="logs" />

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Log files" className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-r border-separator bg-window-2/60 px-2 py-2">
        {files.isPending && <SkeletonRows rows={5} />}
        {!files.isPending && list.length === 0 && <p className="px-2 py-3 text-small text-label-3">No logs yet. Launch the game to create one.</p>}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label} className="mb-2">
            <h3 className="px-2 pt-1 pb-1 text-small font-semibold text-label-3">{g.label}</h3>
            <ul className="flex flex-col gap-px">
              {g.files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-current={f.id === fileId ? 'true' : undefined}
                    onClick={() => setPicked(f.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-fill',
                      f.id === fileId && 'bg-selection',
                    )}
                  >
                    {f.kind === 'live' ? (
                      <Radio className="size-4 shrink-0 text-green" />
                    ) : f.kind === 'crash' ? (
                      <FileWarning className="size-4 shrink-0 text-red" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-label-2" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body">{f.kind === 'live' ? 'Live' : f.kind === 'crash' ? 'Crash report' : f.name}</span>
                      <span className="truncate text-small text-label-2">
                        {f.kind === 'live' ? 'Current session' : f.kind === 'crash' ? f.name.replace(/^crash-/, '').replace(/-client\.txt$/, '') : formatBytes(f.sizeBytes)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {!file ? (
          files.isPending ? null : <EmptyState icon={<FileText />} title="No log selected" />
        ) : file.kind === 'crash' ? (
          <CrashView key={file.id} instanceId={id} file={file} />
        ) : (
          <LogViewer key={file.id} instanceId={id} file={file} />
        )}
      </div>
    </div>
  )
}

function LogViewer({ instanceId, file }: { instanceId: string; file: LogFile }) {
  const lines = useLogLines(instanceId, file.id)
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(['info', 'warn', 'error']))
  const [follow, setFollow] = useState(file.kind === 'live')
  const [timestamps, setTimestamps] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const [matchIndex, setMatchIndex] = useState(0)
  const list = useRef<VirtualListHandle>(null)

  const rows = useMemo(() => collapse((lines.data ?? []).filter((l) => levels.has(l.level))), [lines.data, levels])
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
    copyText(text, `Copied ${rows.length} lines`)
  }

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
          <IconButton label="Copy All" onClick={copyAll}>
            <Copy />
          </IconButton>
          <IconButton label="Reveal in Finder" onClick={() => notYetAvailable('Reveal in Finder')}>
            <FolderOpen />
          </IconButton>
          <IconButton label="Share…" onClick={() => notYetAvailable('Sharing logs')}>
            <Share />
          </IconButton>
          <IconButton label="Move to Trash" disabled={file.kind === 'live'} onClick={() => notYetAvailable('Moving logs to the Trash')}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col bg-window">
        {lines.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={20} label="Loading log" />
          </div>
        ) : lines.isError ? (
          <QueryError error={lines.error} onRetry={() => lines.refetch()} what="this log" />
        ) : rows.length === 0 ? (
          <EmptyState title={lines.data?.length ? 'No lines at these levels' : file.kind === 'live' ? 'Waiting for output…' : 'This log is empty'} />
        ) : (
          <VirtualList
            ref={list}
            role="log"
            aria-label={`${file.name} log`}
            items={rows}
            rowHeight={18}
            paddingY={6}
            followTail={follow}
            onAtBottomChange={setAtBottom}
            getKey={(r) => String(r.line.n)}
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
              if (file.kind === 'live') setFollow(true)
            }}
          >
            Jump to Bottom
          </Button>
        )}
      </div>
    </>
  )
}

function LogRow({ row, timestamps, query, current }: { row: Row; timestamps: boolean; query: string; current: boolean }) {
  const s = levelStyle[row.line.level]
  return (
    <div className={cn('flex h-[18px] items-center gap-2 px-3 leading-[18px] whitespace-pre', s.row, current && 'bg-[color-mix(in_srgb,var(--color-yellow)_30%,transparent)]')}>
      {timestamps && <span className="shrink-0 text-label-3">{row.line.time}</span>}
      <span className={cn('w-3 shrink-0 text-center', s.text)} aria-label={row.line.level}>
        {s.glyph}
      </span>
      <span className="w-[112px] shrink-0 truncate text-label-3">{row.line.source}</span>
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

function CrashView({ instanceId, file }: { instanceId: string; file: LogFile }) {
  const report = useCrashReport(instanceId, file.id)
  const { data: instances } = useInstances()
  const inst = instances?.find((i) => i.id === instanceId)
  if (report.isPending)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} label="Loading crash report" />
      </div>
    )
  if (report.isError) return <QueryError error={report.error} onRetry={() => report.refetch()} what="the crash report" />
  const { text, summary } = report.data
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section aria-label="Crash summary" className="m-4 mb-0 rounded-xl bg-[color-mix(in_srgb,var(--color-red)_7%,transparent)] p-4 shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--color-red)_25%,transparent)]">
        <div className="flex items-start gap-3">
          <XOctagon className="mt-0.5 size-5 shrink-0 text-red" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-title3 font-semibold">Minecraft crashed</h2>
              <Badge tone="error">Exit code {summary.exitCode}</Badge>
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
              <Button onClick={() => notYetAvailable('Opening the crash report')}>Open Crash Report</Button>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(text)
                  toast({ kind: 'success', title: 'Copied crash report' })
                }}
              >
                Copy Report
              </Button>
              <Button onClick={() => notYetAvailable('Reveal in Finder')}>Reveal in Finder</Button>
              <Button variant="primary" icon={<RotateCcw />} disabled={!inst || inst.state.kind !== 'idle'} onClick={() => inst && instanceActions.launch(inst)}>
                Relaunch
              </Button>
            </div>
          </div>
        </div>
      </section>
      <pre className="selectable m-4 rounded-lg bg-surface p-3 font-mono text-callout leading-[18px] whitespace-pre-wrap text-label shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        {text}
      </pre>
    </div>
  )
}
