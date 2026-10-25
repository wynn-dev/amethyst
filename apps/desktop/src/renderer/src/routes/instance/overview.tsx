import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Info, XOctagon } from 'lucide-react'
import type { ResourceKind } from '@shared/services'
import { Badge, Button, Skeleton, Spinner, cn } from '@/ui'
import { api } from '@/lib/rpc'
import { QueryError } from '@/app/RouteStates'
import { openInstance } from '@/app/commands'
import { formatDate, formatDuration, formatRelative } from '@/app/visuals'
import { installInstance, instanceActions, updateInstance, useInstallStatus, useInstance } from '@/data/instances'
import { javaActions, useJavaRecommendation } from '@/data/java'
import { launchInstance, useLaunchEntry } from '@/data/launch'
import { openModpackUpdate } from '@/data/modpacks'
import { describeError } from '@/lib/error-messages'
import type { InstanceDetail, InstanceIssue } from '@/data/types'
import { useInstanceId } from './parts'

/** Overview tab: status and fixes, summary counts and the upstream modpack (B3.2). */
export default function OverviewTab() {
  const id = useInstanceId()
  const q = useInstance(id)
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} what="the overview" />
  const inst = q.data
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-5 px-6 py-5">
        {inst ? <StatusCard inst={inst} /> : <Skeleton className="h-16 rounded-xl" />}
        {inst ? <Summary inst={inst} /> : <Skeleton className="h-28 rounded-xl" />}
        {inst?.upstream && <UpstreamCard inst={inst} />}
      </div>
    </div>
  )
}

function Card({ title, children, action, className }: { title: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('rounded-xl bg-surface p-4 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]', className)}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-body font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

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

function StatusCard({ inst }: { inst: InstanceDetail }) {
  const { issues, notes, loading } = useIssues(inst)
  if (loading) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        <Spinner size={16} />
        <p className="text-body text-label-2">Checking this instance…</p>
      </div>
    )
  }
  if (!issues.length) {
    const running = inst.state.kind === 'running'
    return (
      <div className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]" data-status="ready">
        <CheckCircle2 className="size-5 shrink-0 text-green" />
        <div className="min-w-0">
          <p className="text-body font-medium">{running ? 'Playing now' : inst.state.kind === 'installing' ? 'Installing…' : 'Ready to play'}</p>
          <p className="text-small text-label-2">{notes[0] ?? 'No problems found with this instance.'}</p>
        </div>
      </div>
    )
  }
  return (
    <Card title="Status">
      <ul className="flex flex-col divide-y divide-separator">
        {issues.map((issue) => (
          <li key={issue.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
            {issue.severity === 'error' ? <XOctagon className="size-4 shrink-0 text-red" /> : <AlertTriangle className="size-4 shrink-0 text-orange" />}
            <span className="min-w-0 flex-1">
              <span className="block text-body">{issue.title}</span>
              {issue.description && <span className="block text-small text-label-2">{issue.description}</span>}
            </span>
            {issue.action && (
              <Button size="md" variant={issue.severity === 'error' ? 'primary' : 'push'} onClick={issue.action.run}>
                {issue.action.label}
              </Button>
            )}
          </li>
        ))}
        {notes.map((n) => (
          <li key={n} className="flex items-center gap-3 py-2 last:pb-0">
            <Info className="size-4 shrink-0 text-label-3" />
            <span className="text-small text-label-2">{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Row totals of the content folders (one small `resources.list` page each). */
function useContentCounts(id: string, modded: boolean) {
  return useQuery({
    queryKey: ['overview', 'counts', id],
    staleTime: 30_000,
    queryFn: async () => {
      const total = (kind: ResourceKind, enabled?: boolean) =>
        api.resources
          .list(id, kind, { limit: 1, ...(enabled === undefined ? {} : { enabled }) })
          .then((p) => p.total)
          .catch(() => undefined)
      const [mods, modsEnabled, resourcePacks, shaders, worlds] = await Promise.all([
        modded ? total('mods') : undefined,
        modded ? total('mods', true) : undefined,
        total('resourcepacks'),
        total('shaderpacks'),
        total('saves'),
      ])
      return { mods, modsEnabled, resourcePacks, shaders, worlds }
    },
  })
}

function Stat({ label, value, onClick }: { label: string; value: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-small text-label-2">{label}</span>
      <span className="text-title2 font-semibold tabular">{value}</span>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="flex min-w-0 flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-fill">
      {body}
    </button>
  ) : (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">{body}</div>
  )
}

const n = (v: number | undefined) => (v === undefined ? '—' : v)

function Summary({ inst }: { inst: InstanceDetail }) {
  const modded = inst.loader.kind !== 'vanilla'
  const { data: c } = useContentCounts(inst.id, modded)
  const small = (text: string) => <span className="block truncate text-body font-medium">{text}</span>
  return (
    <Card
      title="Summary"
      action={
        <Button variant="borderless" size="sm" onClick={() => void instanceActions.revealInFinder(inst)}>
          Show in Finder
        </Button>
      }
    >
      <div className="grid grid-cols-4 gap-1">
        <Stat label="Mods" value={!modded ? '—' : c?.mods === undefined ? '—' : `${n(c.modsEnabled)} / ${c.mods}`} onClick={modded ? () => openInstance(inst.id, 'mods') : undefined} />
        <Stat label="Resource Packs" value={n(c?.resourcePacks)} onClick={() => openInstance(inst.id, 'resource-packs')} />
        <Stat label="Shaders" value={n(c?.shaders)} onClick={() => openInstance(inst.id, 'shaders')} />
        <Stat label="Worlds" value={n(c?.worlds)} onClick={() => openInstance(inst.id, 'worlds')} />
        <Stat label="Last Played" value={small(inst.lastPlayedAt ? formatRelative(inst.lastPlayedAt) : 'Never')} />
        <Stat label="Play Time" value={small(inst.playTimeMs ? formatDuration(inst.playTimeMs) : '—')} />
        <Stat label="Game Version" value={small(inst.versionId || 'Not installed')} />
        <Stat label="Created" value={small(formatDate(inst.createdAt))} />
      </div>
    </Card>
  )
}

function UpstreamCard({ inst }: { inst: InstanceDetail }) {
  const up = inst.upstream!
  return (
    <Card
      title="Modpack"
      action={
        <Button variant="borderless" size="sm" onClick={() => openModpackUpdate(inst.id, inst.name)}>
          Version History…
        </Button>
      }
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium">{inst.homepageUrl || up.projectName}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-small text-label-2">
            <Badge tone={up.source === 'modrinth' ? 'success' : 'warning'}>{up.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</Badge>
            Installed version {up.version}
          </p>
        </div>
        <Button onClick={() => openModpackUpdate(inst.id, inst.name)}>Check for Updates…</Button>
      </div>
    </Card>
  )
}
