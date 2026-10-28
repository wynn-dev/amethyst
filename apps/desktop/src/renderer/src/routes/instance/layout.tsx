import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { Folder, MoreHorizontal, Play, Square, X } from 'lucide-react'
import { INSTANCE_TABS, type InstanceTab } from '@shared/menu'
import { Alert, Button, ContextMenu, Dot, DitherProgress, EmptyState, IconButton, Menu, Skeleton, TabStrip, ToolbarTitle, cn, flight, flyFrom, type MenuEntry } from '@/ui'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { TAB_LABELS, openInstance } from '@/app/commands'
import { useUi } from '@/app/ui-store'
import { BlockIcon } from '@/app/visuals'
import { instanceActions, loaderName, useInstance, useInstances } from '@/data/instances'
import { useContentCounts, useWorlds } from '@/data/content'
import { useAccounts } from '@/data/accounts'
import { openModpackExport } from '@/data/modpacks'
import { STEP_LABELS } from '@/data/launch'
import { useInstanceTask } from '@/data/tasks'
import { api } from '@/lib/rpc'
import type { InstanceSummary } from '@/data/types'
import { useInstanceId } from './parts'

/** Instance detail: toolbar with title and Play, the tab strip (⌘1–⌘7), and the active tab (B3.2). */
export function InstanceLayout() {
  const id = useInstanceId()
  const { data: list } = useInstances()
  const detail = useInstance(id)
  const navigate = useNavigate()
  const tab = useRouterState({ select: (s) => (s.location.pathname.split('/')[3] as InstanceTab | undefined) ?? 'overview' })
  // The list carries live state (installing/running); fall back to the detail while the list loads.
  const inst = list?.find((i) => i.id === id) ?? detail.data ?? undefined

  // Opening an instance records it for "recent" sorting (also when reached by a link).
  useEffect(() => {
    if (id) void api.instances.markOpened(id).catch(() => {})
  }, [id])

  if (detail.isError) {
    return (
      <>
        <PageToolbar />
        <QueryError error={detail.error} onRetry={() => detail.refetch()} what="this instance" />
      </>
    )
  }

  if (!inst && (detail.isPending || !list)) {
    return (
      <>
        <PageToolbar
          leading={
            <div className="flex items-center gap-2.5" role="status" aria-label="Loading instance">
              <Skeleton className="size-7 rounded-[7px]" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-2 w-20" />
              </div>
            </div>
          }
        />
        <div className="flex-1" />
      </>
    )
  }

  if (!inst) {
    return (
      <>
        <PageToolbar />
        <EmptyState
          title="Instance not found"
          description="It may have been moved to the Trash or removed from the launcher."
          actions={
            <Button variant="primary" onClick={() => navigate({ to: '/' })}>
              Go Home
            </Button>
          }
        />
      </>
    )
  }

  return <InstanceView inst={inst} tab={tab} />
}

/** A tab count, hidden when zero or unknown. */
const count = (n: number | undefined) => (n ? n : undefined)

/** The header (art, name, "version · loader · N mods", actions, Play) and the tab strip. */
function InstanceView({ inst, tab }: { inst: InstanceSummary; tab: InstanceTab }) {
  const modded = inst.loader.kind !== 'vanilla'
  const { data: counts } = useContentCounts(inst.id, modded)
  const tabCounts: Partial<Record<InstanceTab, number | undefined>> = {
    mods: count(counts?.mods),
    'resource-packs': count(counts?.resourcePacks),
    shaders: count(counts?.shaders),
    worlds: count(counts?.worlds),
  }
  const subtitle = [
    inst.minecraft || 'Unknown version',
    modded ? [loaderName(inst.loader.kind), inst.loader.version].filter(Boolean).join(' ') : 'Vanilla',
    modded && counts?.mods !== undefined ? `${counts.mods} ${counts.mods === 1 ? 'mod' : 'mods'}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <PageToolbar
        separator={false}
        leading={<ToolbarTitle icon={<HeaderArt inst={inst} />} title={inst.name} subtitle={subtitle} />}
        trailing={
          <IconButton label="Show in Finder" shortcut="shift+mod+r" onClick={() => void instanceActions.revealInFinder(inst)}>
            <Folder />
          </IconButton>
        }
        end={
          <>
            <OverflowMenu inst={inst} />
            <PlayButton inst={inst} />
          </>
        }
      />
      <div className="flex h-9 shrink-0 items-center border-b border-separator px-2.5">
        <TabStrip
          aria-label="Instance sections"
          value={tab}
          onValueChange={(t) => openInstance(inst.id, t)}
          items={INSTANCE_TABS.map((t) => ({ value: t, label: TAB_LABELS[t], count: tabCounts[t] }))}
        />
      </div>
      {/* Each tab is its own route, so the pane enters fresh. */}
      <div key={tab} className="flex min-h-0 flex-1 animate-enter flex-col">
        <Outlet />
      </div>
    </>
  )
}

/** The header tile. When the instance was picked from the sidebar, it flies in from that row's tile. */
function HeaderArt({ inst }: { inst: InstanceSummary }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const from = flight.take(inst.id)
    if (from && ref.current) flyFrom(ref.current, from)
  }, [inst.id])
  return (
    <span ref={ref} className="flex">
      <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={28} />
    </span>
  )
}

/** Launch choices: in the More menu and on the Play button's context menu. */
function useLaunchMenu(inst: InstanceSummary): MenuEntry[] {
  const { data: accounts = [] } = useAccounts()
  const { data: worlds = [] } = useWorlds(inst.id)
  const s = inst.state
  return [
    {
      kind: 'sub',
      label: 'Launch as',
      disabled: s.kind !== 'idle' && s.kind !== 'problem',
      items: accounts.length
        ? accounts.map<MenuEntry>((a) => ({
            label: a.status === 'needs-sign-in' ? `${a.name} (session expired)` : a.name,
            onSelect: () => instanceActions.launch(inst, { accountId: a.id }),
          }))
        : [{ label: 'No accounts', disabled: true }],
    },
    {
      kind: 'sub',
      label: 'Launch into World',
      disabled: s.kind !== 'idle' && s.kind !== 'problem',
      items: worlds.length
        ? worlds.map<MenuEntry>((w) => ({ label: w.name, onSelect: () => instanceActions.launch(inst, { quickPlay: { type: 'singleplayer', world: w.id } }) }))
        : [{ label: 'No worlds', disabled: true }],
    },
    { label: 'Repair Files', onSelect: () => instanceActions.repair(inst) },
    { label: 'Launch Options…', onSelect: () => openInstance(inst.id, 'settings') },
  ]
}

function OverflowMenu({ inst }: { inst: InstanceSummary }) {
  const set = useUi((s) => s.set)
  const target = { id: inst.id, name: inst.name }
  const launch = useLaunchMenu(inst)
  const items: MenuEntry[] = [
    ...launch,
    { kind: 'separator' },
    { label: 'Export Modpack…', shortcut: 'shift+mod+e', onSelect: () => openModpackExport(inst.id, inst.name) },
    { label: 'Duplicate…', shortcut: 'mod+d', onSelect: () => set({ duplicate: target }) },
    { label: 'Rename…', onSelect: () => set({ rename: target }) },
    { label: 'Change Version…', onSelect: () => set({ changeVersion: target }) },
    { label: 'Open Logs', shortcut: 'mod+l', onSelect: () => openInstance(inst.id, 'logs') },
    { kind: 'separator' },
    { label: inst.external ? 'Remove from Amethyst…' : 'Move to Trash…', shortcut: 'mod+backspace', destructive: true, onSelect: () => set({ trash: target }) },
  ]
  return (
    <Menu
      align="end"
      items={items}
      trigger={
        <IconButton label="More Actions">
          <MoreHorizontal />
        </IconButton>
      }
    />
  )
}

/** One label of the Play pill; the inactive ones blur out downwards while the pill morphs. */
const layer = (on: boolean) =>
  cn(
    'absolute inset-0 flex items-center gap-1.5 whitespace-nowrap transition-[opacity,filter,translate] duration-200 ease-[var(--ease-mac)]',
    !on && 'pointer-events-none translate-y-1 opacity-0 blur-[3px]',
  )

/** Pill widths per state; the button morphs between them on the UI spring. */
const PLAY_WIDTH = { idle: 74, busy: 220, run: 112 } as const

/**
 * The Play button morphs with the instance's state: Play → a dithered progress pill showing the
 * stage and percentage (installing opens Activity; launching cancels on click) → Running, which
 * stops (asks first; ⌥-click force quits). Right-click offers the launch choices.
 */
function PlayButton({ inst }: { inst: InstanceSummary }) {
  const set = useUi((s) => s.set)
  const [confirmStop, setConfirmStop] = useState(false)
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  const menu = useLaunchMenu(inst)
  const s = inst.state

  const mode = s.kind === 'installing' || s.kind === 'launching' ? 'busy' : s.kind === 'running' ? 'run' : 'idle'
  const pct = s.kind === 'installing' && progress !== undefined ? Math.round(progress * 100) : undefined
  const stage = s.kind === 'installing' ? 'Installing' : s.kind === 'launching' ? (s.step ? STEP_LABELS[s.step] : 'Launching') : ''

  let label = 'Play'
  let title: string | undefined = s.kind === 'idle' ? 'Play (⌘↩)' : undefined
  let onClick: (e: MouseEvent) => void = () => instanceActions.launch(inst)
  if (s.kind === 'installing') {
    label = pct === undefined ? 'Installing…' : `Installing ${pct}%`
    title = 'Show in Activity'
    onClick = () => set({ activity: true })
  } else if (s.kind === 'launching') {
    label = `${stage}…`
    title = 'Cancel launch'
    onClick = () => instanceActions.cancel(inst)
  } else if (s.kind === 'running') {
    label = 'Stop'
    title = 'Stop (⌘.) — ⌥-click to force quit'
    onClick = (e) => (e.altKey ? instanceActions.stop(inst, true) : setConfirmStop(true))
  }

  return (
    <>
      <ContextMenu items={menu}>
        <button
          type="button"
          aria-label={label}
          aria-keyshortcuts={s.kind === 'running' ? 'Meta+.' : 'Meta+Enter'}
          title={title}
          disabled={s.kind === 'problem'}
          onClick={onClick}
          style={{ width: PLAY_WIDTH[mode] }}
          className={cn(
            'group relative ml-1 h-7 shrink-0 overflow-hidden rounded-lg text-compact font-semibold outline-none disabled:opacity-45',
            'transition-[width,background-color,color,box-shadow] duration-(--duration-spring) ease-spring focus-visible:shadow-[0_0_0_2px_var(--focus-ring)]',
            mode === 'idle' && 'bg-accent-fill text-on-accent hover:bg-accent-hover',
            mode === 'busy' && 'bg-fill text-label hairline-strong',
            mode === 'run' && 'text-label shadow-[inset_0_0_0_1px_var(--color-separator-2)] hover:bg-hover',
          )}
        >
          {mode === 'busy' && <DitherProgress value={progress} alpha={0.28} className="absolute inset-0" />}
          <span aria-hidden className={cn(layer(mode === 'idle'), 'justify-center')}>
            <Play className="size-3 fill-current" strokeWidth={0} />
            Play
          </span>
          <span aria-hidden className={cn(layer(mode === 'busy'), 'justify-between px-[11px] font-medium')}>
            <span key={stage} className="min-w-0 animate-enter truncate">
              {stage}
            </span>
            {pct !== undefined ? (
              <span className="font-mono text-[11px] text-label-2 tabular">{pct}%</span>
            ) : (
              s.kind === 'launching' && <X className="size-3 text-label-3 group-hover:text-label" />
            )}
          </span>
          <span aria-hidden className={cn(layer(mode === 'run'), 'justify-center font-medium')}>
            <Dot tone="green" label="" pulse={mode === 'run'} />
            Running
            <span className="ml-1 flex border-l border-separator-2 pl-2 text-label-2 group-hover:text-label">
              <Square className="size-[9px] fill-current" strokeWidth={0} />
            </span>
          </span>
        </button>
      </ContextMenu>
      <Alert
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={`Stop “${inst.name}”?`}
        message="Minecraft will be asked to quit. Unsaved progress since the last autosave may be lost."
        confirmLabel="Stop"
        destructive
        onConfirm={() => instanceActions.stop(inst)}
      />
    </>
  )
}
