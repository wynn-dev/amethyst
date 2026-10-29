import { lazy, Suspense, useState } from 'react'
import { CheckCircle2, ChevronRight } from 'lucide-react'
import type { ResourceKind, UpdateCandidate } from '@shared/services'
import { Button, Checkbox, EmptyState, Sheet, Spinner, cn } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { shortDate } from './content-parts'
import { KIND_NOUN } from '@/data/content'
import { applyUpdates, useChangelog, useUpdateCandidates, useUpdatePolicy } from '@/data/market'

const Markdown = lazy(() => import('@/routes/markdown'))

/** Pre-release channels are named in quiet status colour; releases need no label. */
const channelText = { beta: 'text-yellow', alpha: 'text-orange' } as const

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
        <button type="button" className="flex items-center gap-1 text-meta text-label-2 hover:text-label" aria-expanded={options} onClick={() => setOptions(!options)}>
          <ChevronRight className={cn('size-3 transition-transform duration-(--duration-spring) ease-spring', options && 'rotate-90')} /> Options
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
          <div className="animate-enter rounded-[10px] border border-separator p-3">
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
          <EmptyState icon={<CheckCircle2 strokeWidth={1.5} />} title="Everything is up to date" description={`Files from Modrinth or CurseForge are checked by their hash. Local ${many} can’t be checked.`} className="py-8" />
        ) : (
          <ul aria-label="Updates" className="flex flex-col divide-y divide-separator overflow-hidden rounded-[10px] border border-separator">
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
    <li>
      <div className="flex min-h-[34px] items-center gap-2.5 px-3 py-1.5">
        <Checkbox checked={checked} onCheckedChange={onChecked} aria-label={`Update ${name}`} />
        <p className="min-w-0 flex-1 truncate text-compact font-medium">{name}</p>
        <p className="flex min-w-0 shrink items-baseline gap-[5px] mono text-label-2">
          <span className="truncate">{current || c.fileName}</span>
          <span aria-hidden className="shrink-0 text-accent">
            →
          </span>
          <span className="sr-only">to</span>
          <span className="truncate text-label">{c.latest.versionNumber}</span>
        </p>
        {c.latest.releaseType !== 'release' && <span className={cn('shrink-0 text-meta', channelText[c.latest.releaseType])}>{c.latest.releaseType}</span>}
        <span className="w-[62px] shrink-0 text-right mono text-label-3">{shortDate(Date.parse(c.latest.publishedAt))}</span>
        <Button size="sm" variant="borderless" className="text-label-2" aria-expanded={open} onClick={() => setOpen(!open)} icon={<ChevronRight className={cn('transition-transform duration-(--duration-spring) ease-spring', open && 'rotate-90')} />}>
          Changelog
        </Button>
      </div>
      {open && (
        <div className="max-h-56 animate-enter overflow-y-auto border-t border-separator px-9 py-2.5">
          {log.isPending ? (
            <Spinner size={14} label="Loading changelog" />
          ) : log.isError ? (
            <p className="text-meta text-red">Couldn’t load the changelog.</p>
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
