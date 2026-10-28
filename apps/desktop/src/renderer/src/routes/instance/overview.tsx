import type { ReactNode } from 'react'
import { AlertTriangle, Check, Info, XOctagon } from 'lucide-react'
import type { ResourceRow } from '@shared/services'
import { Button, DitherBar, Dot, Skeleton, Spinner, cn } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { openInstance } from '@/app/commands'
import { formatDate, formatDuration, formatRelative } from '@/app/visuals'
import { useContentCounts, useWorlds } from '@/data/content'
import { installInstance, instanceActions, updateInstance, useInstallStatus, useInstance } from '@/data/instances'
import { javaActions, useJavaRecommendation } from '@/data/java'
import { STEP_LABELS, launchInstance, useLaunchEntry } from '@/data/launch'
import { openModpackUpdate } from '@/data/modpacks'
import { useAppSettings, useSystemInfo } from '@/data/settings'
import { useInstanceTask } from '@/data/tasks'
import { describeError } from '@/lib/error-messages'
import type { InstanceDetail, InstanceIssue } from '@/data/types'
import { Card, CardRow, KeyValueRow, RowText, SOURCE_LABEL, StatStrip, WorldThumb, cardRowClass, useInstanceId, type StatItem } from './parts'

/** Overview tab: status and fixes, figures, recent worlds, the runtime and the upstream modpack (B3.2). */
export default function OverviewTab() {
  const id = useInstanceId()
  const q = useInstance(id)
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} what="the overview" />
  const inst = q.data
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-[18px]">
        {inst ? (
          <>
            <Status inst={inst} />
            <Stats inst={inst} />
            <div className="grid grid-cols-1 items-start gap-3 min-[900px]:grid-cols-[1.25fr_1fr]">
              <div className="flex min-w-0 flex-col gap-3">
                <RecentWorlds inst={inst} />
                <Runtime inst={inst} />
              </div>
              <div className="flex min-w-0 flex-col gap-3">
                <Activity inst={inst} />
                {inst.upstream && <Modpack inst={inst} />}
              </div>
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-[34px] rounded-[10px]" />
            <Skeleton className="h-[66px] rounded-[10px]" />
            <Skeleton className="h-40 rounded-[10px]" />
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Status                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Problems with a fix each: install state, Java, the last launch or crash. */
function useIssues(inst: InstanceDetail): { issues: InstanceIssue[]; notes: string[]; loading: boolean } {
  const status = useInstallStatus(inst.id)
  const java = useJavaRecommendation(inst.state.kind === 'problem' ? '' : inst.id)
  const launch = useLaunchEntry(inst.id)
  const issues: InstanceIssue[] = []
  const notes: string[] = []
  const target = { id: inst.id, name: inst.name }

  if (inst.state.kind === 'problem') issues.push({ id: 'state', severity: 'error', title: inst.state.message })
  if (launch?.phase === 'failed' && launch.failure && launch.failure.code !== 'ECANCELLED') {
    const f = describeError(launch.failure)
    issues.push({ id: 'launch', severity: 'error', title: `The last launch failed: ${f.title}`, ...(f.message ? { description: f.message } : {}), action: { label: 'Try Again', run: () => void launchInstance(target) } })
  }
  if (launch?.exit?.crashed && launch.phase === 'exited') {
    issues.push({ id: 'crash', severity: 'warning', title: 'The last session crashed', action: { label: 'Show Logs', run: () => openInstance(inst.id, 'logs') } })
  }
  if (status.data && !status.data.installed && !status.data.installing && inst.state.kind === 'idle') {
    issues.push({ id: 'install', severity: 'warning', title: 'The game isn’t installed yet', description: 'It installs automatically when you press Play, or now.', action: { label: 'Install', run: () => void installInstance(target) } })
  }
  const rec = java.data
  if (rec?.pinnedUnavailable) {
    issues.push({ id: 'java-pinned', severity: 'warning', title: 'The chosen Java runtime is missing', description: 'Automatic selection is used instead.', action: { label: 'Use Automatic', run: () => void updateInstance(inst.id, { overrides: { javaPath: null } }, 'the Java choice') } })
  }
  if (rec?.rosetta) {
    issues.push({ id: 'java-rosetta', severity: 'warning', title: `Java runs under Rosetta (x86_64)`, description: 'A native runtime starts faster and uses less power.', action: { label: `Get arm64 Java ${rec.major}`, run: () => void javaActions.install(rec.major) } })
  }
  if (rec?.willInstall) notes.push(`Java ${rec.major} will be downloaded automatically on first launch.`)
  else if (rec?.java) notes.push(`Java ${rec.java.version} (${[rec.java.vendor, rec.java.arch].filter(Boolean).join(', ')}) will be used.`)
  return { issues, notes, loading: status.isPending }
}

const statusRow = 'flex min-h-[34px] items-center gap-2.5 rounded-[10px] border border-separator px-3 py-1 text-compact'

/**
 * One compact row while all is well (or while the instance is busy); a card of problems, each
 * with its fix, when something needs attention.
 */
function Status({ inst }: { inst: InstanceDetail }) {
  const { issues, notes, loading } = useIssues(inst)
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  const s = inst.state
  // Busy states describe themselves; the notes are about the next launch.
  if (s.kind === 'installing' || s.kind === 'launching' || s.kind === 'running') {
    const pct = progress === undefined ? undefined : Math.round(progress * 100)
    return (
      <div className={statusRow} role="status" data-status={s.kind}>
        {s.kind === 'running' ? <Dot tone="green" label="Running" /> : <Spinner size={14} />}
        <span className="shrink-0 font-medium">{s.kind === 'running' ? 'Playing now' : s.kind === 'launching' ? (s.step ? `${STEP_LABELS[s.step]}…` : 'Launching…') : 'Installing…'}</span>
        {s.kind === 'installing' ? (
          <>
            <DitherBar value={progress} label="Install progress" className="ml-1 max-w-[220px] flex-1" />
            {pct !== undefined && <span className="font-mono text-[11px] text-label-2 tabular">{pct}%</span>}
            <span className="flex-1" />
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-meta text-label-2">{notes[0]}</span>
        )}
      </div>
    )
  }
  if (loading) {
    return (
      <div className={statusRow}>
        <Spinner size={14} />
        <span className="text-label-2">Checking this instance…</span>
      </div>
    )
  }
  if (!issues.length) {
    return (
      <div className={statusRow} data-status="ready">
        <Check className="size-[15px] shrink-0 text-label-2" strokeWidth={1.75} />
        <span className="shrink-0 font-medium">Ready to play</span>
        <span className="min-w-0 flex-1 truncate text-meta text-label-2">{notes[0] ?? 'No problems found with this instance.'}</span>
      </div>
    )
  }
  return (
    <Card title="Status" count={issues.length}>
      {issues.map((issue) => (
        <CardRow key={issue.id}>
          {issue.severity === 'error' ? <XOctagon className="size-[15px] shrink-0 text-red" strokeWidth={1.75} /> : <AlertTriangle className="size-[15px] shrink-0 text-yellow" strokeWidth={1.75} />}
          <RowText title={<span className="font-normal">{issue.title}</span>} subtitle={issue.description} />
          {issue.action && (
            <Button size="md" variant={issue.severity === 'error' ? 'primary' : 'push'} onClick={issue.action.run}>
              {issue.action.label}
            </Button>
          )}
        </CardRow>
      ))}
      {notes.map((n) => (
        <CardRow key={n}>
          <Info className="size-[15px] shrink-0 text-label-3" strokeWidth={1.5} />
          <span className="text-meta text-label-2">{n}</span>
        </CardRow>
      ))}
    </Card>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Figures                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Play time as a figure and a unit: "45 min", "1.5 h", "31 h". */
function playTimeFigure(ms: number): { value: string; unit: string } {
  if (ms < 3_600_000) return { value: String(Math.round(ms / 60_000)), unit: ms ? 'min' : 'h' }
  const h = ms / 3_600_000
  return { value: h < 10 ? String(Math.round(h * 10) / 10) : String(Math.round(h)), unit: 'h' }
}

const figure = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString())

function Stats({ inst }: { inst: InstanceDetail }) {
  const modded = inst.loader.kind !== 'vanilla'
  const { data: c } = useContentCounts(inst.id, modded)
  const played = playTimeFigure(inst.playTimeMs)
  const off = c?.mods !== undefined && c.modsEnabled !== undefined ? c.mods - c.modsEnabled : 0
  const open = (tab: Parameters<typeof openInstance>[1]) => () => openInstance(inst.id, tab)
  const packs: StatItem = { label: 'Resource packs', value: figure(c?.resourcePacks), onClick: open('resource-packs') }
  const items: StatItem[] = [
    { label: 'Played', value: played.value, unit: played.unit },
    ...(modded ? [{ label: 'Mods', value: figure(c?.mods), ...(off > 0 ? { unit: `${off} off` } : {}), onClick: open('mods') }] : []),
    { label: 'Worlds', value: figure(c?.worlds), onClick: open('worlds') },
    packs,
    ...(modded ? [] : [{ label: 'Shaders', value: figure(c?.shaders), onClick: open('shaders') }]),
  ]
  return <StatStrip label="Summary" items={items} />
}

/* ------------------------------------------------------------------------------------------ */
/* Worlds                                                                                       */
/* ------------------------------------------------------------------------------------------ */

const WORLDS_SHOWN = 3
const playedAt = (w: ResourceRow) => w.world?.lastPlayed ?? w.mtimeMs

function RecentWorlds({ inst }: { inst: InstanceDetail }) {
  const worlds = useWorlds(inst.id)
  const list = (worlds.data ?? []).toSorted((a, b) => playedAt(b) - playedAt(a))
  return (
    <Card title="Worlds" count={worlds.data ? list.length : undefined}>
      {worlds.isPending ? (
        <CardRow tall>
          <Skeleton className="h-[30px] w-[52px] rounded-[5px]" />
          <Skeleton className="h-2.5 w-32" />
        </CardRow>
      ) : list.length === 0 ? (
        <CardRow tall className="text-label-2">
          No worlds yet. Worlds you create in the game appear here.
        </CardRow>
      ) : (
        <>
          {list.slice(0, WORLDS_SHOWN).map((w) => (
            <button key={w.id} type="button" onClick={() => openInstance(inst.id, 'worlds')} className={cn(cardRowClass(true), 'text-left outline-none hover:bg-hover focus-visible:bg-hover')}>
              <WorldThumb world={w} />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="shrink-0 text-meta text-label-2">{playedAt(w) ? formatRelative(playedAt(w)) : ''}</span>
            </button>
          ))}
          {list.length > WORLDS_SHOWN && (
            <button type="button" onClick={() => openInstance(inst.id, 'worlds')} className={cn(cardRowClass(), 'text-left text-meta text-label-2 outline-none hover:bg-hover hover:text-label focus-visible:bg-hover')}>
              Show all {list.length} worlds
            </button>
          )}
        </>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Runtime                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const VENDORS: [RegExp, string][] = [
  [/azul/i, 'Zulu'],
  [/adoptium|temurin|eclipse/i, 'Temurin'],
  [/amazon|corretto/i, 'Corretto'],
  [/microsoft/i, 'Microsoft'],
  [/graal/i, 'GraalVM'],
  [/oracle/i, 'Oracle'],
]
const vendorName = (v: string | null) => (v ? (VENDORS.find(([re]) => re.test(v))?.[1] ?? v.replace(/,? (Inc|Ltd|Corporation|Systems)\.?/g, '')) : 'Java')
const gb = (mb: number) => `${Math.round((mb / 1024) * 10) / 10} GB`
const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

function Runtime({ inst }: { inst: InstanceDetail }) {
  const rec = useJavaRecommendation(inst.id)
  const status = useInstallStatus(inst.id)
  const global = useAppSettings().game
  const system = useSystemInfo()
  const mem = inst.overrides.memory ?? (global.memory.mode === 'manual' ? global.memory : { mode: 'auto' as const, maxMB: 0 })
  const total = system.data ? `of ${gb(system.data.totalMemoryMB)}` : undefined
  const java = rec.data?.java
  const mono = 'font-mono text-[11.5px]'
  return (
    <Card title="Runtime">
      <KeyValueRow label="Version" trailing={status.data && !status.data.installed ? 'Not installed' : undefined}>
        <span className={mono}>{inst.versionId || inst.minecraft || '—'}</span>
      </KeyValueRow>
      <KeyValueRow label="Java" trailing={java ? <span className={mono}>{java.arch === 'x64' ? 'x86_64' : java.arch}</span> : rec.data?.willInstall ? 'downloads on first launch' : undefined}>
        {rec.isPending ? <span className="text-label-3">…</span> : java ? `${vendorName(java.vendor)} ${java.version}` : rec.data ? `Java ${rec.data.major}` : <span className="text-label-2">Chosen when the version is known</span>}
      </KeyValueRow>
      <KeyValueRow label="Memory" trailing={total}>
        {mem.mode === 'auto' ? 'Automatic' : gb(mem.maxMB)}
      </KeyValueRow>
      <button type="button" title="Show in Finder" onClick={() => void instanceActions.revealInFinder(inst)} className={cn(cardRowClass(), 'group text-left outline-none hover:bg-hover focus-visible:bg-hover')}>
        <span className="w-[76px] shrink-0 text-meta text-label-2">Folder</span>
        <span className={cn('selectable min-w-0 flex-1 truncate', mono)}>{tilde(inst.path)}</span>
      </button>
    </Card>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Activity and the modpack                                                                     */
/* ------------------------------------------------------------------------------------------ */

function Activity({ inst }: { inst: InstanceDetail }) {
  const launch = useLaunchEntry(inst.id)
  const exit = launch?.exit
  const rows: { key: string; text: ReactNode; at: string }[] = []
  if (exit) {
    const verb = exit.crashed ? 'Crashed after' : exit.killed ? 'Stopped after' : 'Played for'
    rows.push({ key: 'session', text: `${verb} ${formatDuration(exit.durationMs)}`, at: formatRelative(exit.at) })
  } else if (inst.lastPlayedAt) {
    rows.push({ key: 'played', text: 'Last played', at: formatRelative(inst.lastPlayedAt) })
  }
  if (inst.playTimeMs > 0) rows.push({ key: 'total', text: `${formatDuration(inst.playTimeMs)} played in total`, at: '' })
  if (inst.upstream) {
    rows.push({
      key: 'pack',
      text: (
        <>
          Installed {inst.upstream.projectName} <span className="font-mono text-[11.5px] text-label-2">{inst.upstream.version}</span>
        </>
      ),
      at: '',
    })
  }
  rows.push({ key: 'created', text: inst.upstream ? `Created from ${SOURCE_LABEL[inst.upstream.source]}` : 'Created', at: formatDate(inst.createdAt) })
  return (
    <Card title="Activity">
      {rows.map((r) => (
        <CardRow key={r.key}>
          <span className="min-w-0 flex-1 truncate">{r.text}</span>
          {r.at && <span className="shrink-0 text-meta text-label-2">{r.at}</span>}
        </CardRow>
      ))}
    </Card>
  )
}

function Modpack({ inst }: { inst: InstanceDetail }) {
  const up = inst.upstream!
  const newer = up.latestVersion && up.latestVersion !== up.version ? up.latestVersion : undefined
  return (
    <Card
      title="Modpack"
      action={
        <Button variant="borderless" size="sm" className="-mr-1.5" onClick={() => openModpackUpdate(inst.id, inst.name)}>
          Version History…
        </Button>
      }
    >
      <KeyValueRow label="Project">{inst.homepageUrl || up.projectName}</KeyValueRow>
      <KeyValueRow label="Source">{SOURCE_LABEL[up.source]}</KeyValueRow>
      <KeyValueRow label="Version" trailing={newer && <span className="font-mono text-[11.5px] text-label">→ {newer}</span>}>
        <span className="font-mono text-[11.5px]">{up.version}</span>
      </KeyValueRow>
      <CardRow className="justify-end">
        <Button onClick={() => openModpackUpdate(inst.id, inst.name)}>Check for Updates…</Button>
      </CardRow>
    </Card>
  )
}
