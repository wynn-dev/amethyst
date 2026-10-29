import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { ModpackChangeRow, ModpackUpdatePlanView } from '@shared/services'
import { Banner, Button, Checkbox, DitherBar, EmptyState, RadioList, Segmented, Sheet, cn, recentTrigger } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { formatDate } from '@/app/visuals'
import { loaderLabel, useInstanceInfo } from '@/data/instance-info'
import { useMarketVersions } from '@/data/market'
import { reportUpdateResult, useModpackUi, useModpackUpdateCheck } from '@/data/modpacks'
import { useRunningTask } from '@/data/tasks'
import { api } from '@/lib/rpc'
import { errorMessage, toastError } from '@/lib/error-messages'
import { CardHeader, Note } from './parts'

const ACTION: Record<ModpackChangeRow['action'], string> = { add: 'Added', update: 'Updated', remove: 'Removed', conflict: 'Conflict' }
const CONFLICT: Record<NonNullable<ModpackChangeRow['conflict']>, string> = {
  'modified-replaced': 'You changed this file; the update replaces it (your copy is backed up)',
  'modified-removed': 'You changed this file; the new version removes it (your copy is backed up)',
  'unmanaged-replaced': 'A file the pack never installed is in the way (it is backed up)',
}

/** Update Modpack (B4.7): choose a version, review the per-file plan, apply with rollback. */
export default function ModpackUpdateSheet() {
  const target = useModpackUi((s) => s.updating)
  const set = useModpackUi((s) => s.set)
  const instanceId = target?.instanceId ?? ''
  const info = useInstanceInfo(instanceId)
  const up = info.data?.upstream ?? null
  const platform = up?.kind ?? 'modrinth'
  const projectId = up ? String(up.projectId) : ''
  const currentId = up ? ('versionId' in up ? up.versionId : String(up.fileId)) : ''
  const check = useModpackUpdateCheck(instanceId, !!up)
  const versions = useMarketVersions(platform, projectId, {}, !!up)
  const [chosen, setChosen] = useState<string | null>(null)
  const [plan, setPlan] = useState<ModpackUpdatePlanView | null>(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [skip, setSkip] = useState<Set<string>>(() => new Set())
  const [show, setShow] = useState<'all' | ModpackChangeRow['action']>('all')
  const task = useRunningTask((t) => t.instanceId === instanceId && (t.name === 'modpack.plan-update' || t.name === 'modpack.update'))
  const close = () => set({ updating: null })

  const list = versions.data ?? []
  const current = list.find((v) => v.id === currentId)
  const selected = chosen ?? check.data?.latest.versionId ?? null
  const counts = useMemo(() => {
    const c = { add: 0, update: 0, remove: 0, conflict: 0 }
    for (const ch of plan?.changes ?? []) c[ch.action]++
    return c
  }, [plan])

  const review = async () => {
    if (!selected) return
    setPlanning(true)
    try {
      setPlan(await api.modpacks.planUpdate(instanceId, selected))
      setSkip(new Set())
    } catch (e) {
      toastError(e, 'Couldn’t prepare the update')
    } finally {
      setPlanning(false)
    }
  }
  const apply = async () => {
    if (!plan || !target) return
    setApplying(true)
    try {
      const r = await api.modpacks.applyUpdate(plan.planId, skip.size ? { exclude: [...skip] } : {})
      reportUpdateResult(instanceId, target.name, plan.target.name, r)
      close()
    } catch (e) {
      toastError(e, `Couldn’t update “${target.name}”`)
    } finally {
      setApplying(false)
    }
  }

  const progress = task && task.fraction > 0 ? ` ${Math.round(task.fraction * 100)}%` : ''
  return (
    <Sheet
      open={!!target}
      onOpenChange={(o) => !o && !applying && close()}
      title={plan ? `Update to ${plan.target.name}` : `Update “${target?.name}”`}
      description={plan ? 'Review what changes. Files you added yourself are kept; replaced and removed files are backed up first, so you can roll back.' : undefined}
      width={620}
      origin={recentTrigger}
      footer={
        plan ? (
          <>
            <Button disabled={applying} onClick={() => setPlan(null)}>
              Back
            </Button>
            <Button variant="primary" disabled={applying} onClick={() => void apply()}>
              {applying ? `Updating…${progress}` : 'Update'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            {up && (
              <Button variant="primary" disabled={!selected || selected === currentId || planning} onClick={() => void review()}>
                {planning ? `Preparing…${progress}` : 'Review Changes'}
              </Button>
            )}
          </>
        )
      }
    >
      {!info.data ? (
        <div className="flex h-24 items-center justify-center">
          <DitherBar label="Loading" className="w-40" />
        </div>
      ) : !up ? (
        <EmptyState title="This instance doesn’t follow a modpack" description="Only instances installed from Modrinth or CurseForge can be updated this way." className="py-6" />
      ) : plan ? (
        <div className="flex animate-enter flex-col gap-3">
          <div className="grid grid-cols-4 rounded-[10px] border border-separator">
            {(['add', 'update', 'remove', 'conflict'] as const).map((a) => (
              <div key={a} className="flex flex-col gap-2 px-3.5 pt-3 pb-2.5 [&+&]:border-l [&+&]:border-separator">
                <p className={cn('h-[21px] text-[19px] leading-[21px] font-medium tracking-[-0.02em] tabular', a === 'conflict' && counts.conflict > 0 && 'text-orange')}>{counts[a]}</p>
                <p className="text-meta text-label-2">{ACTION[a]}</p>
              </div>
            ))}
          </div>
          <Note>{plan.unchanged} files stay as they are.</Note>
          {plan.runtime && (
            <Banner tone="info" icon={<ArrowRight />} title="The game version changes">
              {plan.runtime.from ? `Minecraft ${plan.runtime.from.minecraft}${plan.runtime.from.loader ? ` · ${loaderLabel(plan.runtime.from.loader.kind)} ${plan.runtime.from.loader.version}` : ''}` : 'Unknown'} →{' '}
              {`Minecraft ${plan.runtime.to.minecraft}${plan.runtime.to.loader ? ` · ${loaderLabel(plan.runtime.to.loader.kind)} ${plan.runtime.to.loader.version}` : ''}`}. Worlds are backed up first when automatic backups are on.
            </Banner>
          )}
          {plan.manual.length > 0 && (
            <Banner tone="warning" icon={<AlertTriangle />} title={`${plan.manual.length} file${plan.manual.length === 1 ? '' : 's'} will need a manual download`}>
              You’ll be shown where to get them after the update.
            </Banner>
          )}
          {plan.changes.length > 0 && (
            <section aria-label="Changes" className="overflow-hidden rounded-[10px] border border-separator">
              <div className="flex h-9 items-center justify-between gap-2 border-b border-separator px-2">
                <Segmented
                  aria-label="Show changes"
                  size="sm"
                  value={show}
                  onValueChange={setShow}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'add', label: 'Added' },
                    { value: 'update', label: 'Updated' },
                    { value: 'remove', label: 'Removed' },
                    { value: 'conflict', label: 'Conflicts' },
                  ]}
                />
                <span className="pr-1 font-mono text-[10.5px] text-label-3 tabular">{skip.size > 0 ? `${skip.size} left alone` : plan.changes.length}</span>
              </div>
              <ul className="flex max-h-[260px] flex-col divide-y divide-separator overflow-y-auto">
                {plan.changes
                  .filter((c) => show === 'all' || c.action === show)
                  .map((c) => (
                    <li key={c.path} className="flex min-h-8 items-center gap-2.5 px-3 py-1 hover:bg-hover">
                      <Checkbox
                        checked={!skip.has(c.path)}
                        aria-label={`Apply the change to ${c.path}`}
                        onCheckedChange={(on) =>
                          setSkip((s) => {
                            const next = new Set(s)
                            if (on) next.delete(c.path)
                            else next.add(c.path)
                            return next
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate font-mono text-meta', skip.has(c.path) && 'text-label-3')}>{c.path}</p>
                        {c.conflict && <p className="text-meta text-orange">{CONFLICT[c.conflict]}</p>}
                      </div>
                      <span className={cn('shrink-0 text-meta', c.action === 'conflict' ? 'text-orange' : 'text-label-2')}>{ACTION[c.action]}</span>
                    </li>
                  ))}
              </ul>
              <p className="border-t border-separator px-3 py-2 text-meta text-label-2">Untick a file to leave it as it is.</p>
            </section>
          )}
        </div>
      ) : versions.isPending || check.isPending ? (
        <div className="flex h-36 items-center justify-center">
          <DitherBar label="Checking for updates" className="w-40" />
        </div>
      ) : versions.isError ? (
        <QueryError error={new Error(errorMessage(versions.error))} onRetry={() => versions.refetch()} what="the modpack’s versions" />
      ) : (
        <div className="flex animate-enter flex-col gap-3">
          {check.data ? (
            <div className="flex flex-col gap-0.5 px-0.5">
              <p className="text-compact font-medium">{check.data.latest.name} is available</p>
              <p className="text-meta text-label-2">
                Published {formatDate(Date.parse(check.data.latest.publishedAt))} for Minecraft {check.data.latest.gameVersions.join(', ')}.
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 px-0.5 text-compact text-label-2">
              <CheckCircle2 className="size-3.5 text-green" strokeWidth={1.75} /> “{target?.name}” is up to date{current ? ` (${current.name || current.versionNumber})` : ''}. You can still switch to another version.
            </p>
          )}
          <section aria-label="Versions" className="overflow-hidden rounded-[10px] border border-separator">
            <CardHeader title="Versions" count={Math.min(list.length, 40)} />
            <div className="max-h-[300px] overflow-y-auto px-3 py-2.5">
            <RadioList
              aria-label="Version"
              value={selected ?? ''}
              onValueChange={setChosen}
              options={list.slice(0, 40).map((v) => {
                const newer = current ? Date.parse(v.publishedAt) > Date.parse(current.publishedAt) : true
                return {
                  value: v.id,
                  disabled: v.id === currentId,
                  label: (
                    <span className="flex items-center gap-2">
                      {v.name || v.versionNumber}
                      <span className={cn('text-meta', v.id !== currentId && !newer ? 'text-orange' : 'text-label-3')}>{v.id === currentId ? 'Installed' : newer ? 'Newer' : 'Downgrade'}</span>
                      {v.releaseType !== 'release' && <span className="text-meta text-orange">{v.releaseType}</span>}
                    </span>
                  ),
                  description: `${v.gameVersions.join(', ')}${v.loaders.length ? ` · ${v.loaders.join(', ')}` : ''} · ${formatDate(Date.parse(v.publishedAt))}`,
                }
              })}
            />
            </div>
          </section>
        </div>
      )}
    </Sheet>
  )
}
