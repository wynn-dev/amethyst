import { Link } from '@tanstack/react-router'
import { ChevronRight, Clock, Compass, FolderInput, Package, Play, Plus, Square, Timer } from 'lucide-react'
import { Badge, Button, EmptyState, IconButton, Skeleton, ToolbarTitle } from '@/ui'
import { useInstanceActions, useInstances, versionLabel } from '@/data/instances'
import { useAccounts } from '@/data/accounts'
import { useHomeUpdates } from '@/data/home'
import { STEP_LABELS } from '@/data/launch'
import { useInstanceTask } from '@/data/tasks'
import type { InstanceSummary } from '@/data/types'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { openInstance, runCommand } from '@/app/commands'
import { useUi } from '@/app/ui-store'
import { BlockIcon, PlayerHead, formatDuration, formatRelative } from '@/app/visuals'
import { InstanceStateIndicator } from '@/app/AppSidebar'

/** Home (B3.1): continue playing, recent instances, updates. No dashboard grid. */
export function HomePage() {
  const instances = useInstances()
  const list = instances.data ?? []
  const played = list.filter((i) => i.lastPlayedAt).toSorted((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
  const fresh = list.filter((i) => !i.lastPlayedAt).toSorted((a, b) => b.createdAt - a.createdAt)
  // Never-played instances still get a hero and a card, newest first.
  const ordered = [...played, ...fresh]
  const hero = ordered[0]
  const cards = ordered.slice(1, 9)

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
          <div className="mx-auto flex max-w-[1040px] flex-col gap-8 px-8 pt-6 pb-10">
            {hero && <ContinuePlaying inst={hero} />}
            {cards.length > 0 && (
              <section aria-labelledby="recent-h">
                <SectionHeader id="recent-h" title={played.length > 1 ? 'Recent Instances' : 'Your Instances'} />
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                  {cards.map((i) => (
                    <InstanceCard key={i.id} inst={i} />
                  ))}
                </div>
              </section>
            )}
            <Updates />
          </div>
        )}
      </div>
    </>
  )
}

function SectionHeader({ id, title, action }: { id: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between">
      <h2 id={id} className="text-title3 font-semibold">
        {title}
      </h2>
      {action}
    </div>
  )
}

function PlayButton({ inst, size = 'lg' }: { inst: InstanceSummary; size?: 'lg' | 'xl' | 'md' }) {
  const actions = useInstanceActions()
  const set = useUi((s) => s.set)
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  switch (inst.state.kind) {
    case 'running':
      return (
        <Button size={size} icon={<Square className="fill-current" />} onClick={() => actions.stop(inst)}>
          Stop
        </Button>
      )
    case 'launching':
      return (
        <Button size={size} onClick={() => actions.cancel(inst)} title="Click to cancel">
          {inst.state.step ? `${STEP_LABELS[inst.state.step]}…` : 'Launching…'}
        </Button>
      )
    case 'installing':
      return (
        <Button size={size} className="tabular" onClick={() => set({ activity: true })}>
          {progress === undefined ? 'Installing…' : `Installing ${Math.round(progress * 100)}%`}
        </Button>
      )
    case 'problem':
      return (
        <Button size={size} onClick={() => openInstance(inst.id, 'overview')}>
          Show Problem
        </Button>
      )
    default:
      return (
        <Button size={size} variant="primary" icon={<Play className="fill-current" />} aria-keyshortcuts="Meta+Enter" onClick={() => actions.launch(inst)}>
          Play
        </Button>
      )
  }
}

function ContinuePlaying({ inst }: { inst: InstanceSummary }) {
  const { data: accounts = [] } = useAccounts()
  const account = accounts.find((a) => a.active)
  return (
    <section aria-label="Continue playing" className="relative overflow-hidden rounded-2xl shadow-card">
      {/* The contract has no screenshot listing yet; the hero uses the instance's colour. */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(120% 140% at 85% 0%, hsl(${(inst.iconHue + 40) % 360} 55% 52%) 0%, transparent 60%), linear-gradient(115deg, hsl(${inst.iconHue} 45% 18%) 0%, hsl(${(inst.iconHue + 20) % 360} 50% 32%) 100%)`,
        }}
      />
      <div className="absolute inset-0 bg-linear-to-r from-black/35 to-transparent" />
      <div className="relative flex min-h-[200px] flex-col justify-end gap-4 p-6 text-white">
        <p className="text-small font-semibold tracking-[0.06em] text-white/70 uppercase">{inst.lastPlayedAt ? 'Continue Playing' : 'Ready to Play'}</p>
        <div className="flex items-center gap-4">
          <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={64} className="shadow-lg" />
          <div className="min-w-0">
            <h2 className="truncate text-large font-bold tracking-tight">{inst.name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-white/80">
              <span>{versionLabel(inst)}</span>
              {inst.lastPlayedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="size-3.5" /> {formatRelative(inst.lastPlayedAt)}
                </span>
              )}
              {inst.playTimeMs > 0 && (
                <span className="flex items-center gap-1">
                  <Timer className="size-3.5" /> {formatDuration(inst.playTimeMs)} played
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <PlayButton inst={inst} size="xl" />
          <Link
            to="/instances/$instanceId/overview"
            params={{ instanceId: inst.id }}
            onClick={(e) => {
              e.preventDefault()
              openInstance(inst.id, 'overview')
            }}
            className="flex h-9 items-center rounded-lg bg-white/15 px-4 text-title3 font-medium backdrop-blur-md hover:bg-white/25"
          >
            Open
          </Link>
          {account && (
            <span className="ml-auto flex items-center gap-2 rounded-full bg-black/25 py-1 pr-3 pl-1 text-callout backdrop-blur-md">
              <PlayerHead hue={account.hue} size={20} /> Playing as {account.name}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function InstanceCard({ inst }: { inst: InstanceSummary }) {
  return (
    <div className="group relative flex items-center gap-3 rounded-xl bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)] transition-colors duration-150 hover:bg-fill">
      <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={40} />
      <div className="min-w-0 flex-1">
        <Link
          to="/instances/$instanceId/overview"
          params={{ instanceId: inst.id }}
          className="block truncate text-body font-semibold text-label outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-3 focus-visible:after:outline-[color-mix(in_srgb,var(--accent)_55%,transparent)]"
        >
          {inst.name}
        </Link>
        <p className="flex items-center gap-1.5 truncate text-small text-label-2">
          {versionLabel(inst)}
          <InstanceStateIndicator inst={inst} />
        </p>
        {inst.lastPlayedAt && <p className="truncate text-small text-label-3">{formatRelative(inst.lastPlayedAt)}</p>}
      </div>
      <div className="relative z-10">
        <CardPlay inst={inst} />
      </div>
    </div>
  )
}

function CardPlay({ inst }: { inst: InstanceSummary }) {
  const actions = useInstanceActions()
  if (inst.state.kind === 'running')
    return (
      <IconButton label={`Stop ${inst.name}`} variant="push" onClick={() => actions.stop(inst)}>
        <Square className="fill-current" />
      </IconButton>
    )
  return (
    <IconButton label={`Play ${inst.name}`} variant="primary" disabled={inst.state.kind !== 'idle'} onClick={() => actions.launch(inst)} className="rounded-full">
      <Play className="translate-x-px fill-current" />
    </IconButton>
  )
}

function Updates() {
  const { data: updates = [], isPending } = useHomeUpdates()
  if (isPending || updates.length === 0) return null
  return (
    <section aria-labelledby="updates-h">
      <SectionHeader id="updates-h" title="Updates Available" action={<Badge tone="accent">{updates.length}</Badge>} />
      <ul className="divide-y divide-separator overflow-hidden rounded-xl bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        {updates.map((u) => (
          <li key={u.id}>
            <Link
              to={u.tab === 'mods' ? '/instances/$instanceId/mods' : '/instances/$instanceId/overview'}
              params={{ instanceId: u.instanceId }}
              className="flex h-10 items-center gap-3 px-3 text-body hover:bg-fill focus-visible:bg-fill focus-visible:outline-none"
            >
              <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
                <Package className="size-3.5" />
              </span>
              <span className="flex-1 truncate">{u.text}</span>
              <span className="text-small text-label-2">Review</span>
              <ChevronRight className="size-3.5 text-label-3" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
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
          <Link to="/discover" search={{ type: 'modpack' }} className="flex h-7 items-center gap-1.5 rounded-[7px] px-3.5 text-body font-medium text-accent hover:bg-accent-soft">
            <Compass className="size-4" /> Browse Modpacks
          </Link>
        </>
      }
    />
  )
}

function HomeSkeleton() {
  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-8 px-8 pt-6" role="status" aria-label="Loading">
      <Skeleton className="h-[200px] rounded-2xl" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[66px] rounded-xl" />
        ))}
      </div>
    </div>
  )
}
