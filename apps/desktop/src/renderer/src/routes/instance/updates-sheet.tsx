import { lazy, Suspense, useState } from 'react'
import { ArrowRight, CheckCircle2, ChevronRight } from 'lucide-react'
import type { ResourceKind, UpdateCandidate } from '@shared/services'
import { Badge, Button, Checkbox, EmptyState, Sheet, Spinner, cn } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { formatDate } from '@/app/visuals'
import { KIND_NOUN } from '@/data/content'
import { applyUpdates, useChangelog, useUpdateCandidates, useUpdatePolicy } from '@/data/market'

const Markdown = lazy(() => import('@/routes/markdown'))

const channelTone = { release: 'success', beta: 'warning', alpha: 'error' } as const

/** "Review Updates" (B4.1): old → new per row, changelogs, a checkbox each, and "Update N". */
export function UpdatesSheet({
  open,
  onOpenChange,
  instanceId,
  kind,
  names,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  instanceId: string
  kind: ResourceKind
  /** Row id → display name (and current version) for the rows in view. */
  names: Record<string, { name: string; version: string }>
}) {
  const updates = useUpdateCandidates(instanceId, kind, open)
  const prereleases = useUpdatePolicy((s) => s.prereleases[instanceId] ?? false)
  const setPolicy = useUpdatePolicy((s) => s.set)
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [options, setOptions] = useState(false)
  const list = updates.data ?? []
  const chosen = list.filter((c) => !skipped.has(c.resourceId))
  const [, many] = KIND_NOUN[kind]

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setSkipped(new Set())
        onOpenChange(o)
      }}
      title="Review Updates"
      description={updates.isFetching ? `Checking your ${many} on Modrinth and CurseForge…` : list.length ? `${list.length} of your ${many} ${list.length === 1 ? 'has' : 'have'} a newer version for this instance.` : undefined}
      width={600}
      footerLeading={
        <button type="button" className="flex items-center gap-1 text-small text-label-2 hover:text-label" aria-expanded={options} onClick={() => setOptions(!options)}>
          <ChevronRight className={cn('size-3 transition-transform', options && 'rotate-90')} /> Options
        </button>
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{list.length ? 'Cancel' : 'Done'}</Button>
          {list.length > 0 && (
            <Button
              variant="primary"
              disabled={chosen.length === 0 || busy}
              onClick={async () => {
                setBusy(true)
                const labels = Object.fromEntries(Object.entries(names).map(([id, n]) => [id, n.name]))
                await applyUpdates(instanceId, kind, chosen, labels)
                setBusy(false)
                onOpenChange(false)
              }}
            >
              {busy ? 'Updating…' : `Update ${chosen.length}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {options && (
          <div className="rounded-lg bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
            <Checkbox
              checked={prereleases}
              onCheckedChange={(on) => setPolicy(instanceId, on)}
              label="Include beta and alpha versions"
              description="Remembered for this instance. Only versions for this instance’s Minecraft version and loader are offered."
            />
          </div>
        )}
        {updates.isPending ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner label="Checking for updates" />
          </div>
        ) : updates.isError ? (
          <QueryError error={updates.error} onRetry={() => updates.refetch()} what="updates" />
        ) : list.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="text-green" />} title="Everything is up to date" description={`Files from Modrinth or CurseForge are checked by their hash. Local ${many} can’t be checked.`} className="py-8" />
        ) : (
          <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
            {list.map((c) => (
              <UpdateRow
                key={c.resourceId}
                c={c}
                name={names[c.resourceId]?.name ?? c.fileName}
                current={names[c.resourceId]?.version ?? ''}
                checked={!skipped.has(c.resourceId)}
                onChecked={(on) =>
                  setSkipped((s) => {
                    const next = new Set(s)
                    if (on) next.delete(c.resourceId)
                    else next.add(c.resourceId)
                    return next
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  )
}

function UpdateRow({ c, name, current, checked, onChecked }: { c: UpdateCandidate; name: string; current: string; checked: boolean; onChecked: (on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const log = useChangelog(c.platform, c.projectId, c.latest.versionId, open)
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2.5">
        <Checkbox checked={checked} onCheckedChange={onChecked} aria-label={`Update ${name}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium">{name}</p>
          <p className="flex items-center gap-1.5 text-small text-label-2">
            <span className="truncate">{current || c.fileName}</span>
            <ArrowRight className="size-3 shrink-0" />
            <span className="truncate text-label">{c.latest.versionNumber}</span>
            {c.latest.releaseType !== 'release' && <Badge tone={channelTone[c.latest.releaseType]}>{c.latest.releaseType}</Badge>}
            <span className="shrink-0">· {formatDate(Date.parse(c.latest.publishedAt))}</span>
          </p>
        </div>
        <Button size="sm" variant="borderless" aria-expanded={open} onClick={() => setOpen(!open)} icon={<ChevronRight className={cn('transition-transform', open && 'rotate-90')} />}>
          Changelog
        </Button>
      </div>
      {open && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-md bg-window-2 px-3 py-2">
          {log.isPending ? (
            <Spinner size={14} label="Loading changelog" />
          ) : log.isError ? (
            <p className="text-small text-red">Couldn’t load the changelog.</p>
          ) : (
            <Suspense fallback={<Spinner size={14} label="Loading" />}>
              <Markdown source={log.data ?? ''} format={c.platform === 'curseforge' ? 'html' : 'markdown'} />
            </Suspense>
          )}
        </div>
      )}
    </li>
  )
}
