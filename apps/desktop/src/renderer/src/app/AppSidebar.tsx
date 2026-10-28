import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { AlertTriangle, ArrowUpCircle, Compass, Folder, House, PanelLeft, Plus, Search, SlidersHorizontal } from 'lucide-react'
import type { InstanceTab } from '@shared/menu'
import {
  ContextMenu,
  Dot,
  IconButton,
  Kbd,
  ProgressRing,
  SearchField,
  SourceList,
  SourceListDisclosure,
  SourceListHeader,
  SourceListItem,
  Spinner,
  VirtualList,
  cn,
  flight,
  indicatorClass,
  useSlidingIndicator,
  type MenuEntry,
} from '@/ui'
import { chooseInstanceIcon, libraryActions, useInstanceActions, useInstanceFolders, useInstances, versionLabel } from '@/data/instances'
import { useInstanceTask } from '@/data/tasks'
import { updaterActions, useUpdaterState } from '@/data/updater'
import type { InstanceFolder, InstanceSummary } from '@/data/types'
import { useAppearance } from '@/data/appearance'
import { openInstance, openSettings } from './commands'
import { openModpackExport } from '@/data/modpacks'
import { SIDEBAR_MAX, SIDEBAR_MIN, useUi } from './ui-store'
import { BlockIcon } from './visuals'
import { AccountChip } from './AccountChip'
import { markOnce } from '@/lib/perf'

type Row =
  | { kind: 'header'; key: string; title: string; action?: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void }
  | { kind: 'nav'; key: string; to: '/' | '/discover'; label: string; icon: ReactNode }
  | { kind: 'folder'; key: string; folder: InstanceFolder; count: number }
  | { kind: 'instance'; key: string; inst: InstanceSummary; indent: number }
  | { kind: 'note'; key: string; text: string; retry?: () => void }

// Rows are 26 px plus a 1 px gap; section headers carry 10 px of space above them.
const HEIGHT: Record<Row['kind'], number> = { header: 38, nav: 27, folder: 27, instance: 27, note: 26 }
/** Rows above this count are virtualised. */
const VIRTUALISE_AT = 50

export function AppSidebar() {
  const { data: instances = [], isPending, isError, refetch } = useInstances()
  const { data: folders = [] } = useInstanceFolders()
  const filter = useUi((s) => s.sidebarFilter)
  const filterOpen = useUi((s) => s.sidebarFilterOpen)
  const setUi = useUi((s) => s.set)
  const width = useUi((s) => s.sidebarWidth)
  const translucent = useAppearance().vibrancy
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [instancesOpen, setInstancesOpen] = useState(true)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const selectedId = pathname.startsWith('/instances/') ? pathname.split('/')[2] : undefined
  // Startup timing: the instance list is on screen (docs/PERFORMANCE.md).
  useEffect(() => {
    if (!isPending) markOnce('sidebar-instances')
  }, [isPending])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      { kind: 'nav', key: 'home', to: '/', label: 'Home', icon: <House /> },
      { kind: 'nav', key: 'discover', to: '/discover', label: 'Discover', icon: <Compass /> },
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
          <ContextMenu
            items={[
              { label: 'Rename Folder…', onSelect: () => setUi({ renameFolder: { id: row.folder.id, name: row.folder.name } }) },
              { kind: 'separator' },
              { label: 'Remove Folder', destructive: true, onSelect: () => void libraryActions.deleteFolder(row.folder.id, row.folder.name) },
            ]}
          >
            <div>
              <SourceListDisclosure
                label={row.folder.name}
                icon={<Folder />}
                count={row.count}
                open={row.folder.expanded}
                onOpenChange={(expanded) => void libraryActions.setFolderExpanded(row.folder.id, expanded)}
              />
            </div>
          </ContextMenu>
        )
      case 'instance':
        return <InstanceRow inst={row.inst} indent={row.indent} selected={row.inst.id === selectedId} folders={folders} />
      case 'note':
        return (
          <p className="flex h-full items-center gap-2 px-2 text-small text-label-3">
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

  const virtual = rows.length > VIRTUALISE_AT
  // The selection pill slides between rows; long (virtualised) lists use a static pill instead,
  // since the selected row may not be rendered.
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '.sl-row[aria-current="page"]', pathname)
  const pill = <span ref={indicator} aria-hidden className={indicatorClass} />

  return (
    <aside
      aria-label="Sidebar"
      style={{ width }}
      className={cn('relative flex h-full shrink-0 flex-col shadow-[inset_-1px_0_0_var(--color-separator)]', translucent ? 'bg-transparent' : 'bg-window-2')}
    >
      {/* Traffic-light inset; the empty space drags the window. */}
      <div className="drag flex h-12 shrink-0 items-center justify-end px-2">
        <IconButton label="Hide Sidebar" shortcut="ctrl+mod+s" className="text-label-3" onClick={() => setUi({ sidebarCollapsed: true })}>
          <PanelLeft />
        </IconButton>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-2.5 pb-2">
        <button
          id="sidebar-search"
          type="button"
          aria-label="Search"
          aria-keyshortcuts="Meta+K"
          onClick={() => setUi({ palette: true })}
          className="flex h-7 items-center gap-[7px] rounded-[7px] bg-fill pr-[5px] pl-2 text-left text-compact text-label-3 hairline transition-colors duration-150 hover:text-label-2"
        >
          <Search aria-hidden className="size-3.5" />
          <span className="flex-1">Search</span>
          <Kbd shortcut="mod+k" boxed />
        </button>
        {(filterOpen || filter) && (
          <SearchField
            id="sidebar-filter"
            value={filter}
            onValueChange={(v) => setUi({ sidebarFilter: v })}
            onBlur={() => !filter && setUi({ sidebarFilterOpen: false })}
            placeholder="Filter instances"
            label="Filter instances"
            autoFocus={filterOpen}
          />
        )}
      </div>

      <SourceList aria-label="Library and instances" indicator={!virtual} className="min-h-0 flex-1 !gap-0 !px-0">
        <div ref={list} className="h-full min-h-0">
          {virtual ? (
            <VirtualList
              items={rows}
              rowHeight={(r) => HEIGHT[r.kind]}
              getKey={(r) => r.key}
              aria-label="Instances"
              className="h-full px-2 pb-2"
              renderRow={(r) => <SidebarRowFrame row={r}>{renderRow(r)}</SidebarRowFrame>}
            />
          ) : (
            <div role="list" className="relative h-full overflow-y-auto px-2 pb-2">
              {pill}
              {rows.map((r) => (
                <div key={r.key} role={r.kind === 'header' ? 'presentation' : 'listitem'} style={{ height: HEIGHT[r.kind] }}>
                  <SidebarRowFrame row={r}>{renderRow(r)}</SidebarRowFrame>
                </div>
              ))}
            </div>
          )}
        </div>
      </SourceList>

      <div className="shrink-0 border-t border-separator px-2 py-2">
        <RestartToUpdate />
        <div className="flex items-center gap-1">
          <AccountChip />
          <IconButton label="Settings" shortcut="mod+comma" onClick={() => openSettings()}>
            <SlidersHorizontal />
          </IconButton>
        </div>
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
  const setUi = useUi((s) => s.set)
  const tab = useRouterState({ select: (s) => (s.location.pathname.split('/')[3] as InstanceTab | undefined) ?? 'overview' })
  const progress = useInstanceTask(inst.id)
  const running = inst.state.kind === 'running'
  const target = { id: inst.id, name: inst.name }

  const menu: MenuEntry[] = [
    running
      ? { label: 'Stop', shortcut: 'mod+period', onSelect: () => actions.stop(inst) }
      : { label: 'Play', shortcut: 'mod+enter', disabled: inst.state.kind !== 'idle', onSelect: () => actions.launch(inst) },
    { kind: 'separator' },
    { label: 'Show in Finder', onSelect: () => void actions.revealInFinder(inst) },
    { label: 'Duplicate…', onSelect: () => setUi({ duplicate: target }) },
    { label: 'Rename…', onSelect: () => setUi({ rename: target }) },
    { label: 'Change Icon…', onSelect: () => void chooseInstanceIcon(inst) },
    { kind: 'separator' },
    { label: inst.pinned ? 'Unpin' : 'Pin', onSelect: () => void libraryActions.togglePin(inst) },
    {
      kind: 'sub',
      label: 'Move to Folder',
      items: [
        ...folders.map<MenuEntry>((f) => ({ kind: 'check', label: f.name, checked: inst.folderId === f.id, onCheckedChange: () => void libraryActions.moveToFolder(inst, f.id) })),
        { kind: 'check', label: 'None', checked: !inst.folderId, onCheckedChange: () => void libraryActions.moveToFolder(inst, null) },
        { kind: 'separator' },
        { label: 'New Folder…', onSelect: () => setUi({ newFolder: { move: target } }) },
      ],
    },
    { label: 'Export Modpack…', onSelect: () => openModpackExport(inst.id, inst.name) },
    { kind: 'separator' },
    { label: inst.external ? 'Remove from Amethyst…' : 'Move to Trash…', destructive: true, onSelect: () => setUi({ trash: target }) },
  ]

  return (
    <ContextMenu items={menu}>
      <div>
        <SourceListItem
          listItem={false}
          indent={indent}
          selected={selected}
          icon={<BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={18} />}
          label={inst.name}
          detail={inst.minecraft || undefined}
          trailing={<InstanceStateIndicator inst={inst} />}
          progress={inst.state.kind === 'installing' ? (progress ?? 0) : undefined}
          render={(p) => (
            <Link
              to={`/instances/$instanceId/${tab}`}
              params={{ instanceId: inst.id }}
              title={`${inst.name} · ${versionLabel(inst)}`}
              onClick={(e) => {
                e.preventDefault()
                // The header's tile flies in from this one (motion.ts).
                flight.mark(inst.id, e.currentTarget.querySelector('[data-art]'))
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
  const progress = useInstanceTask(inst.state.kind === 'installing' ? inst.id : undefined)
  switch (inst.state.kind) {
    case 'installing':
      return <ProgressRing value={progress} size={12} stroke={1.75} label={progress === undefined ? 'Installing' : `Installing, ${Math.round(progress * 100)}%`} />
    case 'launching':
      return <Spinner size={12} label="Launching" />
    case 'running':
      return <Dot tone="green" label="Running" />
    case 'problem':
      return (
        <span role="img" aria-label={inst.state.message} title={inst.state.message} className="flex text-orange">
          <AlertTriangle className="size-[13px]" />
        </span>
      )
    default:
      return null
  }
}

/** "Restart to Update" pill above the account chip once an update is downloaded (B14). Never a bare badge. */
function RestartToUpdate() {
  const state = useUpdaterState()
  if (state.status !== 'ready') return null
  return (
    <button
      type="button"
      onClick={() => void updaterActions.restart()}
      title={`Amethyst ${state.version} is ready`}
      className="mb-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-[7px] bg-accent-fill text-callout font-medium text-on-accent hover:bg-accent-hover"
    >
      <ArrowUpCircle className="size-3.5" /> Restart to Update
    </button>
  )
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

