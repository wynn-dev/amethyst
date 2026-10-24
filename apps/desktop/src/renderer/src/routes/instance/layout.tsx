import { useEffect, useState, type MouseEvent } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { ChevronDown, FolderOpen, MoreHorizontal, Play, Square, X } from 'lucide-react'
import { INSTANCE_TABS, type InstanceTab } from '@shared/menu'
import { Alert, Button, EmptyState, IconButton, Menu, Segmented, Skeleton, ToolbarTitle, cn, type MenuEntry } from '@/ui'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { TAB_LABELS, notYetAvailable, openInstance } from '@/app/commands'
import { useUi } from '@/app/ui-store'
import { BlockIcon } from '@/app/visuals'
import { instanceActions, useInstance, useInstances, versionLabel } from '@/data/instances'
import { useWorlds } from '@/data/content'
import { useAccounts } from '@/data/accounts'
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
            <div className="flex items-center gap-2.5 pl-1" role="status" aria-label="Loading instance">
              <Skeleton className="size-7 rounded-md" />
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

  return (
    <>
      <PageToolbar
        separator={false}
        leading={<ToolbarTitle icon={<BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={28} />} title={inst.name} subtitle={versionLabel(inst)} />}
        trailing={
          <>
            <PlayButton inst={inst} />
            <IconButton label="Show in Finder" shortcut="shift+mod+r" onClick={() => void instanceActions.revealInFinder(inst)}>
              <FolderOpen />
            </IconButton>
            <OverflowMenu inst={inst} />
          </>
        }
      />
      <div className="flex h-10 shrink-0 items-center justify-center border-b border-separator px-3">
        <Segmented
          aria-label="Instance sections"
          value={tab}
          onValueChange={(t) => openInstance(inst.id, t)}
          options={INSTANCE_TABS.map((t) => ({ value: t, label: TAB_LABELS[t] }))}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </>
  )
}

function OverflowMenu({ inst }: { inst: InstanceSummary }) {
  const set = useUi((s) => s.set)
  const target = { id: inst.id, name: inst.name }
  const items: MenuEntry[] = [
    // TODO(wire): modpack export belongs to the modpack area.
    { label: 'Export Modpack…', shortcut: 'shift+mod+e', onSelect: () => notYetAvailable('Export Modpack') },
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

/**
 * Split Play button. The main part reflects state: Play → Installing 42% (opens Activity) →
 * Launching… (cancels) → Stop (asks first; ⌥-click force quits). ▾ opens a click menu.
 */
function PlayButton({ inst }: { inst: InstanceSummary }) {
  const set = useUi((s) => s.set)
  const { data: accounts = [] } = useAccounts()
  const { data: worlds = [] } = useWorlds(inst.id)
  const [confirmStop, setConfirmStop] = useState(false)
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  const s = inst.state

  let label = 'Play'
  let icon = <Play className="fill-current" />
  let variant: 'primary' | 'push' = 'primary'
  let onClick: (e: MouseEvent) => void = () => instanceActions.launch(inst)
  if (s.kind === 'installing') {
    label = progress === undefined ? 'Installing…' : `Installing ${Math.round(progress * 100)}%`
    icon = <span className="size-3.5 rounded-full border-2 border-on-accent/40 border-t-on-accent animate-spin" aria-hidden />
    onClick = () => set({ activity: true })
  } else if (s.kind === 'launching') {
    label = s.step ? `${STEP_LABELS[s.step]}…` : 'Launching…'
    icon = <X />
    variant = 'push'
    onClick = () => instanceActions.cancel(inst)
  } else if (s.kind === 'running') {
    label = 'Stop'
    icon = <Square className="fill-current" />
    variant = 'push'
    onClick = (e) => (e.altKey ? instanceActions.stop(inst, true) : setConfirmStop(true))
  }

  const menu: MenuEntry[] = [
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
    { kind: 'separator' },
    { label: 'Repair Files', onSelect: () => instanceActions.repair(inst) },
    { label: 'Launch Options…', onSelect: () => openInstance(inst.id, 'settings') },
  ]

  return (
    <div className="flex items-center">
      <Button
        variant={variant}
        size="lg"
        icon={icon}
        onClick={onClick}
        aria-keyshortcuts={s.kind === 'running' ? 'Meta+.' : 'Meta+Enter'}
        title={s.kind === 'running' ? 'Stop (⌘.) — ⌥-click to force quit' : s.kind === 'idle' ? 'Play (⌘↩)' : undefined}
        disabled={s.kind === 'problem'}
        className={cn('min-w-[88px] rounded-r-none', s.kind === 'installing' && 'tabular')}
      >
        {label}
      </Button>
      <Menu
        align="end"
        items={menu}
        trigger={
          <Button
            variant={variant}
            size="lg"
            aria-label="Launch options"
            className={cn('rounded-l-none !px-1.5', variant === 'primary' ? 'border-l border-l-black/15' : 'border-l border-l-separator')}
          >
            <ChevronDown />
          </Button>
        }
      />
      <Alert
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={`Stop “${inst.name}”?`}
        message="Minecraft will be asked to quit. Unsaved progress since the last autosave may be lost."
        confirmLabel="Stop"
        destructive
        onConfirm={() => instanceActions.stop(inst)}
      />
    </div>
  )
}

