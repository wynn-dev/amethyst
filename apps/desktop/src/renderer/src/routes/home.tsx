import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { Compass, FolderInput, Package, Play, Plus, Square } from 'lucide-react'
import { Button, Dot, EmptyState, IconButton, Skeleton, Spinner, ToolbarTitle, flight } from '@/ui'
import { loaderName, useInstanceActions, useInstances } from '@/data/instances'
import { useContentCounts } from '@/data/content'
import { useHomeUpdates } from '@/data/home'
import { useInstanceTask } from '@/data/tasks'
import type { InstanceSummary } from '@/data/types'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { openInstance, runCommand } from '@/app/commands'
import { useUi } from '@/app/ui-store'
import { BlockIcon, formatRelative } from '@/app/visuals'
import { InstanceStateIndicator } from '@/app/AppSidebar'
import { markOnce } from '@/lib/perf'
import { Card, RowText, cardRowClass } from './instance/parts'

/** Instances listed under "Jump back in" (B3.1: up to 8 recent ones; the sidebar has them all). */
const RECENT = 8

/** Home (B3.1): jump back into recent instances, and updates. No dashboard grid, no hero. */
export function HomePage() {
  const instances = useInstances()
  const list = instances.data ?? []
  const played = list.filter((i) => i.lastPlayedAt).toSorted((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
  const fresh = list.filter((i) => !i.lastPlayedAt).toSorted((a, b) => b.createdAt - a.createdAt)
  // Never-played instances follow the played ones, newest first.
  const recent = [...played, ...fresh].slice(0, RECENT)
  // Startup timing: Home shows the instances (docs/PERFORMANCE.md).
  useEffect(() => {
    if (!instances.isPending) markOnce('home-instances')
  }, [instances.isPending])

  return (
    <>
      <PageToolbar leading={<ToolbarTitle title="Home" />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {instances.isPending ? (
          <HomeSkeleton />
        ) : instances.isError ? (
          <QueryError error={instances.error} onRetry={() => instances.refetch()} what="your instances" />
        ) : list.length === 0 ? (
          <FirstInstance />
        ) : (
          <div className="flex flex-col gap-3 px-4 pt-3.5 pb-[18px]">
            <Card title="Jump back in">
              {recent.map((i) => (
                <RecentRow key={i.id} inst={i} />
              ))}
            </Card>
            <Updates instances={list} />
          </div>
        )}
      </div>
    </>
  )
}

/** "1.21.1 · Fabric 0.16.9 · 47 mods", like the instance header. */
function useMetaLine(inst: InstanceSummary): string {
  const modded = inst.loader.kind !== 'vanilla'
  const { data: counts } = useContentCounts(inst.id, modded)
  return [
    inst.minecraft || 'Unknown version',
    modded ? [loaderName(inst.loader.kind), inst.loader.version].filter(Boolean).join(' ') : 'Vanilla',
    modded && counts?.mods !== undefined ? `${counts.mods} ${counts.mods === 1 ? 'mod' : 'mods'}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One instance: art, name, meta and last played. The row opens the instance; the trailing button plays it. */
function RecentRow({ inst }: { inst: InstanceSummary }) {
  const actions = useInstanceActions()
  const meta = useMetaLine(inst)
  return (
    <div data-instance-row className={`group relative ${cardRowClass(true)} hover:bg-hover has-[a:focus-visible]:bg-hover`}>
      <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={28} />
      <RowText
        title={
          <Link
            to="/instances/$instanceId/overview"
            params={{ instanceId: inst.id }}
            onClick={(e) => {
              e.preventDefault()
              // The header's tile flies in from this one (motion.ts).
              flight.mark(inst.id, e.currentTarget.closest('[data-instance-row]')?.querySelector('[data-art]'))
              openInstance(inst.id, 'overview')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault()
                actions.launch(inst)
              }
            }}
            className="text-label outline-none after:absolute after:inset-0"
          >
            {inst.name}
          </Link>
        }
        subtitle={meta}
      />
      <RowStatus inst={inst} />
      <div className="relative z-10 -mr-1.5 flex">
        <RowPlay inst={inst} />
      </div>
    </div>
  )
}

/** Last played, or what the instance is doing right now. */
function RowStatus({ inst }: { inst: InstanceSummary }) {
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  const s = inst.state
  let text: string
  if (s.kind === 'running') text = 'Running'
  else if (s.kind === 'launching') text = 'Launching…'
  else if (s.kind === 'installing') text = progress === undefined ? 'Installing…' : `Installing ${Math.round(progress * 100)}%`
  else if (s.kind === 'problem') text = 'Needs attention'
  else text = inst.lastPlayedAt ? formatRelative(inst.lastPlayedAt) : 'Never played'
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-meta whitespace-nowrap text-label-2 tabular">
      {s.kind === 'running' ? <Dot tone="green" label="Running" /> : s.kind !== 'idle' && s.kind !== 'launching' && <InstanceStateIndicator inst={inst} />}
      {text}
    </span>
  )
}

/** The inline Play control. It follows the instance state like the sidebar row does. */
function RowPlay({ inst }: { inst: InstanceSummary }) {
  const actions = useInstanceActions()
  const set = useUi((s) => s.set)
  switch (inst.state.kind) {
    case 'running':
      return (
        <IconButton label={`Stop ${inst.name}`} onClick={() => actions.stop(inst)}>
          <Square className="fill-current" />
        </IconButton>
      )
    case 'launching':
      return (
        <IconButton label={`Cancel launching ${inst.name}`} onClick={() => actions.cancel(inst)}>
          <Spinner size={13} />
        </IconButton>
      )
    case 'installing':
      return (
        <IconButton label="Show Activity" onClick={() => set({ activity: true })}>
          <Play className="translate-x-px fill-current opacity-40" />
        </IconButton>
      )
    case 'problem':
      return (
        <Button size="md" onClick={() => openInstance(inst.id, 'overview')}>
          Show Problem
        </Button>
      )
    default:
      return (
        <IconButton label={`Play ${inst.name}`} className="text-label! [&_svg]:size-[13px]" onClick={() => actions.launch(inst)}>
          <Play className="translate-x-px fill-current" />
        </IconButton>
      )
  }
}

function Updates({ instances }: { instances: InstanceSummary[] }) {
  const { data: updates = [], isPending } = useHomeUpdates()
  if (isPending || updates.length === 0) return null
  const byId = new Map(instances.map((i) => [i.id, i]))
  return (
    <Card title="Updates" count={updates.length}>
      {updates.map((u) => {
        const inst = byId.get(u.instanceId)
        return (
          <Link
            key={u.id}
            to={u.tab === 'mods' ? '/instances/$instanceId/mods' : '/instances/$instanceId/overview'}
            params={{ instanceId: u.instanceId }}
            className={`${cardRowClass()} outline-none hover:bg-hover focus-visible:bg-hover`}
          >
            {inst ? <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={18} /> : <Package className="size-[15px] text-label-2" strokeWidth={1.5} />}
            <span className="min-w-0 flex-1 truncate">{u.text}</span>
            <span className="flex h-[26px] shrink-0 items-center rounded-[7px] px-2.5 text-callout hairline-strong">Review</span>
          </Link>
        )
      })}
    </Card>
  )
}

function FirstInstance() {
  const set = useUi((s) => s.set)
  return (
    <EmptyState
      size="lg"
      className="h-full"
      icon={<Package strokeWidth={1.25} />}
      title="Create your first instance"
      description="An instance is a separate Minecraft installation with its own version, mods and worlds."
      actions={
        <>
          <Button size="lg" variant="primary" icon={<Plus />} onClick={() => set({ newInstance: true })}>
            New Instance
          </Button>
          <Button size="lg" onClick={() => runCommand('file.importModpack')}>
            Import Modpack…
          </Button>
          <Button size="lg" icon={<FolderInput />} onClick={() => set({ newInstance: true, newInstanceSource: 'folder' })}>
            Add Existing Folder…
          </Button>
          <Link to="/discover" search={{ type: 'modpack' }} className="flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-compact font-medium text-label hover:bg-hover">
            <Compass className="size-[15px]" strokeWidth={1.5} /> Browse Modpacks
          </Link>
        </>
      }
    />
  )
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-3.5" role="status" aria-label="Loading">
      <div className="overflow-hidden rounded-[10px] border border-separator">
        <div className="flex h-8 items-center border-b border-separator px-3">
          <Skeleton className="h-2.5 w-24" />
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-[46px] items-center gap-2.5 border-t border-separator px-3 first-of-type:border-t-0">
            <Skeleton className="size-7 rounded-[7px]" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5" style={{ width: 90 + ((i * 37) % 60) }} />
              <Skeleton className="h-2 w-40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
