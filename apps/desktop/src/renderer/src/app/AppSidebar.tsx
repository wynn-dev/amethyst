import { useMemo, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { AlertTriangle, Compass, Folder, House, PanelLeft, Plus } from 'lucide-react'
import type { InstanceTab } from '@shared/menu'
import {
  ContextMenu,
  Dot,
  IconButton,
  ProgressRing,
  SearchField,
  SourceList,
  SourceListDisclosure,
  SourceListHeader,
  SourceListItem,
  Spinner,
  VirtualList,
  cn,
  type MenuEntry,
} from '@/ui'
import { useInstanceActions, useInstanceFolders, useInstances, useUpdateFolder, useUpdateInstance, versionLabel } from '@/data/instances'
import type { InstanceFolder, InstanceSummary } from '@/data/types'
import { useSettings } from '@/data/settings'
import { notYetAvailable, openInstance } from './commands'
import { openModpackExport } from '@/data/modpacks'
import { SIDEBAR_MAX, SIDEBAR_MIN, useUi } from './ui-store'
import { BlockIcon } from './visuals'
import { AccountChip } from './AccountChip'

type Row =
  | { kind: 'header'; key: string; title: string; action?: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void }
  | { kind: 'nav'; key: string; to: '/' | '/discover'; label: string; icon: ReactNode }
  | { kind: 'folder'; key: string; folder: InstanceFolder; count: number }
  | { kind: 'instance'; key: string; inst: InstanceSummary; indent: number }
  | { kind: 'note'; key: string; text: string; retry?: () => void }

const HEIGHT: Record<Row['kind'], number> = { header: 34, nav: 29, folder: 29, instance: 40, note: 28 }
/** Rows above this count are virtualised. */
const VIRTUALISE_AT = 50

export function AppSidebar() {
  const { data: instances = [], isPending, isError, refetch } = useInstances()
  const { data: folders = [] } = useInstanceFolders()
  const updateFolder = useUpdateFolder()
  const filter = useUi((s) => s.sidebarFilter)
  const setUi = useUi((s) => s.set)
  const width = useUi((s) => s.sidebarWidth)
  const translucent = useSettings().translucentSidebar
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [instancesOpen, setInstancesOpen] = useState(true)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const selectedId = pathname.startsWith('/instances/') ? pathname.split('/')[2] : undefined

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      { kind: 'nav', key: 'home', to: '/', label: 'Home', icon: <House className="size-4" /> },
      { kind: 'nav', key: 'discover', to: '/discover', label: 'Discover', icon: <Compass className="size-4" /> },
    ]
    const q = filter.trim().toLowerCase()
    if (q) {
      const hits = instances.filter((i) => i.name.toLowerCase().includes(q) || i.minecraft.includes(q))
      out.push({ kind: 'header', key: 'h-results', title: 'Instances' })
      if (!hits.length) out.push({ kind: 'note', key: 'none', text: `No instances match “${filter.trim()}”` })
      for (const inst of hits) out.push({ kind: 'instance', key: inst.id, inst, indent: 0 })
      return out
    }
    const pinned = instances.filter((i) => i.pinned)
    if (pinned.length) {
      out.push({ kind: 'header', key: 'h-pinned', title: 'Pinned', open: pinnedOpen, onOpenChange: setPinnedOpen })
      if (pinnedOpen) for (const inst of pinned) out.push({ kind: 'instance', key: `pin-${inst.id}`, inst, indent: 0 })
    }
    out.push({
      kind: 'header',
      key: 'h-instances',
      title: 'Instances',
      open: instancesOpen,
      onOpenChange: setInstancesOpen,
      action: (
        <IconButton label="New Instance" shortcut="mod+n" size="sm" onClick={() => setUi({ newInstance: true })}>
          <Plus />
        </IconButton>
      ),
    })
    if (!instancesOpen) return out
    if (isError) out.push({ kind: 'note', key: 'error', text: 'Couldn’t load instances', retry: () => refetch() })
    else if (!isPending && instances.length === 0) out.push({ kind: 'note', key: 'empty', text: 'No instances yet' })
    for (const folder of folders) {
      const members = instances.filter((i) => i.folderId === folder.id && !i.pinned)
      out.push({ kind: 'folder', key: `f-${folder.id}`, folder, count: members.length })
      if (folder.expanded) for (const inst of members) out.push({ kind: 'instance', key: inst.id, inst, indent: 1 })
    }
    for (const inst of instances) if (!inst.pinned && !folders.some((f) => f.id === inst.folderId)) out.push({ kind: 'instance', key: inst.id, inst, indent: 0 })
    return out
  }, [instances, folders, filter, pinnedOpen, instancesOpen, isPending, isError, refetch, setUi])

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'header':
        return <SourceListHeader title={row.title} action={row.action} open={row.open} onOpenChange={row.onOpenChange} />
      case 'nav': {
        const selected = row.to === '/' ? pathname === '/' : pathname.startsWith(row.to)
        return (
          <SourceListItem
            listItem={false}
            icon={row.icon}
            label={row.label}
            selected={selected}
            render={(p) => <Link to={row.to} search={row.to === '/discover' ? {} : undefined} {...p} />}
          />
        )
      }
      case 'folder':
        return (
          <SourceListDisclosure
            label={row.folder.name}
            icon={<Folder className="size-4" />}
            count={row.count}
            open={row.folder.expanded}
            onOpenChange={(expanded) => updateFolder.mutate({ id: row.folder.id, patch: { expanded } })}
          />
        )
      case 'instance':
        return <InstanceRow inst={row.inst} indent={row.indent} selected={row.inst.id === selectedId} folders={folders} />
      case 'note':
        return (
          <p className="flex items-center gap-2 px-2.5 py-1.5 text-small text-label-3">
            {row.text}
            {row.retry && (
              <button type="button" onClick={row.retry} className="font-medium text-accent hover:underline">
                Retry
              </button>
            )}
          </p>
        )
    }
  }

  return (
    <aside
      aria-label="Sidebar"
      style={{ width }}
      className={cn('relative flex h-full shrink-0 flex-col', translucent ? 'bg-transparent' : 'bg-window-2')}
    >
      {/* Traffic-light inset; the empty space drags the window. */}
      <div className="drag flex h-[52px] shrink-0 items-center justify-end px-2.5">
        <IconButton label="Hide Sidebar" shortcut="ctrl+mod+s" onClick={() => setUi({ sidebarCollapsed: true })}>
          <PanelLeft />
        </IconButton>
      </div>

      <SourceList aria-label="Library and instances" className="min-h-0 flex-1 !gap-0 !px-0">
        {rows.length > VIRTUALISE_AT ? (
          <VirtualList
            items={rows}
            rowHeight={(r) => HEIGHT[r.kind]}
            getKey={(r) => r.key}
            aria-label="Instances"
            className="h-full px-2.5 pb-2"
            renderRow={(r) => <SidebarRowFrame row={r}>{renderRow(r)}</SidebarRowFrame>}
          />
        ) : (
          <div role="list" className="h-full overflow-y-auto px-2.5 pb-2">
            {rows.map((r) => (
              <div key={r.key} role={r.kind === 'header' ? 'presentation' : 'listitem'} style={{ height: HEIGHT[r.kind] }}>
                <SidebarRowFrame row={r}>{renderRow(r)}</SidebarRowFrame>
              </div>
            ))}
          </div>
        )}
      </SourceList>

      <div className="shrink-0 px-2.5 pt-1.5 pb-2.5">
        <SearchField
          id="sidebar-filter"
          value={filter}
          onValueChange={(v) => setUi({ sidebarFilter: v })}
          placeholder="Filter"
          label="Filter instances"
          className="mb-2"
        />
        <AccountChip />
      </div>

      <ResizeHandle />
    </aside>
  )
}

function SidebarRowFrame({ row, children }: { row: Row; children: ReactNode }) {
  return <div className={cn('flex h-full flex-col', row.kind === 'header' ? 'justify-end' : 'justify-start pb-px')}>{children}</div>
}

function InstanceRow({ inst, indent, selected, folders }: { inst: InstanceSummary; indent: number; selected: boolean; folders: InstanceFolder[] }) {
  const actions = useInstanceActions()
  const update = useUpdateInstance()
  const setUi = useUi((s) => s.set)
  const tab = useRouterState({ select: (s) => (s.location.pathname.split('/')[3] as InstanceTab | undefined) ?? 'overview' })
  const running = inst.state.kind === 'running'

  const menu: MenuEntry[] = [
    running ? { label: 'Stop', shortcut: 'mod+period', onSelect: () => actions.stop(inst) } : { label: 'Play', shortcut: 'mod+enter', onSelect: () => actions.launch(inst) },
    { kind: 'separator' },
    { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
    { label: 'Duplicate…', onSelect: () => setUi({ duplicate: { id: inst.id, name: inst.name } }) },
    { label: 'Rename', onSelect: () => notYetAvailable('Rename') },
    { label: 'Change Icon…', onSelect: () => notYetAvailable('Change Icon') },
    { kind: 'separator' },
    { label: inst.pinned ? 'Unpin' : 'Pin', onSelect: () => update.mutate({ id: inst.id, patch: { pinned: !inst.pinned } }) },
    {
      kind: 'sub',
      label: 'Move to Folder',
      items: [
        ...folders.map<MenuEntry>((f) => ({ kind: 'check', label: f.name, checked: inst.folderId === f.id, onCheckedChange: () => update.mutate({ id: inst.id, patch: { folderId: f.id } }) })),
        { kind: 'check', label: 'None', checked: !inst.folderId, onCheckedChange: () => update.mutate({ id: inst.id, patch: { folderId: undefined } }) },
        { kind: 'separator' },
        { label: 'New Folder…', onSelect: () => notYetAvailable('New Folder') },
      ],
    },
    { label: 'Export Modpack…', onSelect: () => openModpackExport(inst.id, inst.name) },
    { kind: 'separator' },
    { label: 'Move to Trash…', destructive: true, onSelect: () => setUi({ trash: { id: inst.id, name: inst.name } }) },
  ]

  return (
    <ContextMenu items={menu}>
      <div>
        <SourceListItem
          listItem={false}
          indent={indent}
          selected={selected}
          icon={<BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={20} />}
          label={inst.name}
          secondary={versionLabel(inst)}
          trailing={<InstanceStateIndicator inst={inst} />}
          progress={inst.state.kind === 'installing' ? inst.state.progress : undefined}
          render={(p) => (
            <Link
              to={`/instances/$instanceId/${tab}`}
              params={{ instanceId: inst.id }}
              onClick={(e) => {
                e.preventDefault()
                openInstance(inst.id)
              }}
              onDoubleClick={() => inst.state.kind === 'idle' && actions.launch(inst)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey) {
                  e.preventDefault()
                  actions.launch(inst)
                }
              }}
              {...p}
            />
          )}
        />
      </div>
    </ContextMenu>
  )
}

export function InstanceStateIndicator({ inst }: { inst: InstanceSummary }) {
  switch (inst.state.kind) {
    case 'installing':
      return <ProgressRing value={inst.state.progress} size={14} label={`Installing, ${Math.round(inst.state.progress * 100)}%`} />
    case 'launching':
      return <Spinner size={14} label="Launching" />
    case 'running':
      return <Dot tone="green" label="Running" />
    case 'problem':
      return (
        <span role="img" aria-label={inst.state.message} title={inst.state.message} className="flex text-orange">
          <AlertTriangle className="size-3.5" />
        </span>
      )
    default:
      return null
  }
}

const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))

/** Drag the trailing edge to resize (180–320 px). Double-click resets. Arrow keys work too. */
function ResizeHandle() {
  const width = useUi((s) => s.sidebarWidth)
  const set = useUi((s) => s.set)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onDoubleClick={() => set({ sidebarWidth: 220 })}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') set({ sidebarWidth: clamp(width - 10) })
        if (e.key === 'ArrowRight') set({ sidebarWidth: clamp(width + 10) })
      }}
      onPointerDown={(e) => {
        const startX = e.clientX
        const start = width
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent) => set({ sidebarWidth: clamp(start + ev.clientX - startX) })
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
      className="no-drag absolute top-0 -right-[3px] z-20 h-full w-[6px] cursor-col-resize outline-none focus-visible:bg-accent/50"
    />
  )
}

