import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, XOctagon } from 'lucide-react'
import { Badge, Button, Skeleton, cn } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable, openInstance, runCommand } from '@/app/commands'
import { ArtTile, formatBytes, formatDate, formatDuration, formatRelative } from '@/app/visuals'
import { useInstance } from '@/data/instances'
import type { InstanceDetail, InstanceIssue } from '@/data/types'
import { useInstanceId } from './parts'

/** Overview tab: status and fixes, summary counts, screenshots and the upstream modpack (B3.2). */
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
        {inst && <Screenshots inst={inst} />}
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

function runIssueAction(inst: InstanceDetail, issue: InstanceIssue) {
  switch (issue.action?.command) {
    case 'mods.updates':
      return openInstance(inst.id, 'mods')
    case 'instance.repair':
      return runCommand('instance.repair')
    case 'java.download':
      return notYetAvailable('Java download')
    default:
      return notYetAvailable(issue.action?.label ?? 'This action')
  }
}

function StatusCard({ inst }: { inst: InstanceDetail }) {
  if (!inst.issues.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        <CheckCircle2 className="size-5 text-green" />
        <div>
          <p className="text-body font-medium">Ready to play</p>
          <p className="text-small text-label-2">No problems found with this instance.</p>
        </div>
      </div>
    )
  }
  return (
    <Card title="Status">
      <ul className="flex flex-col divide-y divide-separator">
        {inst.issues.map((issue) => (
          <li key={issue.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
            {issue.severity === 'error' ? <XOctagon className="size-4 shrink-0 text-red" /> : <AlertTriangle className="size-4 shrink-0 text-orange" />}
            <span className="flex-1 text-body">{issue.title}</span>
            {issue.action && (
              <Button size="md" variant={issue.severity === 'error' ? 'primary' : 'push'} onClick={() => runIssueAction(inst, issue)}>
                {issue.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Stat({ label, value, onClick }: { label: string; value: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-small text-label-2">{label}</span>
      <span className="text-title2 font-semibold tabular">{value}</span>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="flex flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-fill">
      {body}
    </button>
  ) : (
    <div className="flex flex-col gap-0.5 px-2 py-1.5">{body}</div>
  )
}

function Summary({ inst }: { inst: InstanceDetail }) {
  const c = inst.counts
  return (
    <Card title="Summary">
      <div className="grid grid-cols-4 gap-1">
        <Stat label="Mods" value={inst.loader.kind === 'vanilla' ? '—' : `${c.modsEnabled} / ${c.modsTotal}`} onClick={() => openInstance(inst.id, 'mods')} />
        <Stat label="Resource Packs" value={c.resourcePacks} onClick={() => openInstance(inst.id, 'resource-packs')} />
        <Stat label="Shaders" value={c.shaders} onClick={() => openInstance(inst.id, 'shaders')} />
        <Stat label="Worlds" value={c.worlds} onClick={() => openInstance(inst.id, 'worlds')} />
        <Stat label="Last Played" value={<span className="text-body font-medium">{inst.lastPlayedAt ? formatRelative(inst.lastPlayedAt) : 'Never'}</span>} />
        <Stat label="Play Time" value={<span className="text-body font-medium">{inst.playTimeMs ? formatDuration(inst.playTimeMs) : '—'}</span>} />
        <Stat label="Size on Disk" value={<span className="text-body font-medium">{formatBytes(inst.diskBytes)}</span>} />
        <Stat label="Created" value={<span className="text-body font-medium">{formatDate(inst.createdAt)}</span>} />
      </div>
    </Card>
  )
}

function UpstreamCard({ inst }: { inst: InstanceDetail }) {
  const up = inst.upstream!
  const hasUpdate = up.latestVersion && up.latestVersion !== up.version
  return (
    <Card
      title="Modpack"
      action={
        <Button variant="borderless" size="sm" onClick={() => notYetAvailable('Version history')}>
          Version History…
        </Button>
      }
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">{up.projectName}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-small text-label-2">
            <Badge tone={up.source === 'modrinth' ? 'success' : 'warning'}>{up.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</Badge>
            Installed {up.version}
            {hasUpdate ? <span className="text-accent">· {up.latestVersion} available</span> : <span>· Up to date</span>}
          </p>
        </div>
        <Button variant={hasUpdate ? 'primary' : 'push'} onClick={() => notYetAvailable('Modpack update')}>
          {hasUpdate ? 'Update…' : 'Check for Updates'}
        </Button>
      </div>
    </Card>
  )
}

function Screenshots({ inst }: { inst: InstanceDetail }) {
  return (
    <Card title="Screenshots" action={<span className="text-small text-label-2">{inst.screenshots.length}</span>}>
      {inst.screenshots.length === 0 ? (
        <p className="text-body text-label-2">Press F2 in game to take a screenshot.</p>
      ) : (
        <ul className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1" aria-label="Screenshots">
          {inst.screenshots.map((s) => (
            <li key={s.id} className="shrink-0">
              <button
                type="button"
                aria-label={`Screenshot from ${formatDate(s.takenAt)}`}
                onClick={() => notYetAvailable('Screenshot preview')}
                className="block overflow-hidden rounded-lg shadow-card transition-transform duration-150 hover:scale-[1.02] focus-visible:scale-[1.02]"
              >
                <ArtTile hue={s.hue} className="h-[90px] w-[160px]" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
