import { useCallback, useDeferredValue, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, GripVertical, Image, Plus, Trash2 } from 'lucide-react'
import type { ResourceRow } from '@shared/services'
import { Button, EmptyState, IconButton, Menu, SearchField, SkeletonRows, Switch, Tooltip, VirtualTable, cn, type Column, type MenuEntry } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { findTargetRef } from '@/app/ui-store'
import { formatBytes } from '@/app/visuals'
import { addResourceFiles, setPackOrder, setResourcesEnabled, trashResources, usePagedResources, useResourceAll, useResourceDetail, useWatchInstance } from '@/data/content'
import { useInstanceInfo } from '@/data/instance-info'
import { openModpackImport } from '@/data/modpacks'
import { isModpackPath, pickFiles, revealInFinder } from '@/lib/files'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import {
  AddFromInstanceSheet,
  ContentBar,
  DropOverlay,
  FileSection,
  PlaceholderCell,
  ProblemNote,
  ResourceIcon,
  RowSource,
  ScanningNote,
  TrashConfirm,
  isPlaceholder,
  realIds,
  useFileDrop,
  type ContentRow,
} from './content-parts'
import { packCompat, releasesFor } from './pack-format'
import { InspectorHeader, InspectorSection, PropertyList, SplitView, copyText, useInstanceId, useSelection } from './parts'
import { UpdatesSheet } from './updates-sheet'

type Header = { header: string; id: string }
type Row = ContentRow | Header
const isHeader = (r: Row): r is Header => 'header' in r
const DRAG_TYPE = 'application/x-amethyst-pack'

/** Resource Packs tab: the enabled load order (top wins) and the available packs (B4.2). */
export default function ResourcePacksTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  useWatchInstance(id)
  const info = useInstanceInfo(id)
  const minecraft = info.data?.minecraft
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query.trim())
  const { selection, setSelection, only } = useSelection()
  const [pendingTrash, setPendingTrash] = useState<string[] | null>(null)
  const [fromInstance, setFromInstance] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)

  const enabledQuery = useResourceAll(id, 'resourcepacks', { enabled: true })
  const available = usePagedResources(id, 'resourcepacks', { enabled: false, ...(search ? { search } : {}) })
  const enabled = useMemo(() => (enabledQuery.data ?? []).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)), [enabledQuery.data])
  const order = useMemo(() => enabled.map((p) => p.id), [enabled])
  const byId = useMemo(() => {
    const m = new Map<string, ResourceRow>()
    for (const r of enabled) m.set(r.id, r)
    for (const r of available.rows) if (r) m.set(r.id, r)
    return m
  }, [enabled, available.rows])
  const { request } = available

  const rows = useMemo<Row[]>(() => {
    const q = search.toLowerCase()
    const en = enabled.filter((p) => !q || p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
    return [
      { header: `Enabled · top overrides bottom`, id: 'h-enabled' },
      ...en,
      { header: 'Available', id: 'h-available' },
      ...available.rows.map((r, index): ContentRow => r ?? { placeholder: true, id: `\u0000p${index}`, index }),
    ]
  }, [enabled, available.rows, search])

  const setEnabled = useCallback(
    (ids: string[], on: boolean) => {
      const real = realIds(ids)
      // Enabling puts packs on top; disabling drops them from the order.
      if (on) void setPackOrder(id, [...real.filter((i) => !order.includes(i)), ...order])
      else void setResourcesEnabled(id, 'resourcepacks', real, false)
    },
    [id, order],
  )
  const toggle = (ids: string[]) => setEnabled(ids, realIds(ids).some((i) => !byId.get(i)?.enabled))
  const move = (ids: string[], delta: -1 | 1 | 'top' | 'bottom') => {
    const next = [...order]
    const sel = new Set(ids.filter((i) => next.includes(i)))
    if (!sel.size) return
    if (delta === 'top' || delta === 'bottom') {
      const rest = next.filter((x) => !sel.has(x))
      const moved = next.filter((x) => sel.has(x))
      return void setPackOrder(id, delta === 'top' ? [...moved, ...rest] : [...rest, ...moved])
    }
    const idxs = next.map((x, i) => (sel.has(x) ? i : -1)).filter((i) => i >= 0)
    if (delta < 0 ? idxs[0] === 0 : idxs[idxs.length - 1] === next.length - 1) return
    for (const i of delta < 0 ? idxs : idxs.toReversed()) {
      const j = i + delta
      ;[next[i], next[j]] = [next[j]!, next[i]!]
    }
    void setPackOrder(id, next)
  }
  const dropOn = useCallback(
    (targetId: string, e: DragEvent) => {
      const dragged = e.dataTransfer.getData(DRAG_TYPE)
      if (!dragged || dragged === targetId) return
      e.preventDefault()
      const without = order.filter((x) => x !== dragged)
      const at = without.indexOf(targetId)
      without.splice(at < 0 ? without.length : at, 0, dragged)
      void setPackOrder(id, without)
    },
    [id, order],
  )

  const drop = useFileDrop((paths) => {
    const packs = paths.filter(isModpackPath)
    if (packs[0]) openModpackImport({ path: packs[0] })
    const rest = paths.filter((p) => !isModpackPath(p))
    if (rest.length) void addResourceFiles(id, 'resourcepacks', rest)
  })
  const addFiles = async () => {
    const paths = await pickFiles('resourcepacks', { title: 'Add Resource Packs' })
    if (paths.length) await addResourceFiles(id, 'resourcepacks', paths)
  }

  // Memoised so the table's rows stay memoised while scrolling.
  const columns = useMemo<Column<Row>[]>(() => [
    {
      id: 'handle',
      title: 'Order',
      header: <span className="sr-only">Order</span>,
      width: '30px',
      align: 'center',
      cell: (r) =>
        !isHeader(r) && !isPlaceholder(r) && r.enabled ? (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, r.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            className="flex cursor-grab items-center text-label-3 hover:text-label-2 active:cursor-grabbing"
            title="Drag to change the load order (⌥⌘↑ / ⌥⌘↓)"
          >
            <GripVertical aria-label={`Position ${(r.order ?? 0) + 1}`} className="size-3.5" strokeWidth={1.5} />
          </span>
        ) : null,
    },
    {
      id: 'enabled',
      title: 'Enabled',
      header: <span className="sr-only">Enabled</span>,
      width: '42px',
      align: 'center',
      cell: (r) => (isHeader(r) || isPlaceholder(r) ? null : <Switch size="sm" checked={r.enabled} aria-label={`Enable ${r.name}`} onCheckedChange={(on) => setEnabled([r.id], on)} />),
    },
    {
      id: 'name',
      title: 'Name',
      header: 'Name',
      width: 'minmax(220px,1fr)',
      cell: (r) =>
        isHeader(r) ? null : isPlaceholder(r) ? (
          <PlaceholderCell index={r.index} request={request} />
        ) : (
          <div
            className="flex h-full min-w-0 flex-1 items-center gap-[9px]"
            onDragOver={(e) => {
              if (r.enabled && Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) e.preventDefault()
            }}
            onDrop={(e) => r.enabled && dropOn(r.id, e)}
          >
            <ResourceIcon row={r} />
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{r.name}</span>
              <span className="truncate text-meta text-label-3">{r.pending ? 'Reading…' : r.summary || r.fileName}</span>
            </span>
            {r.problem && <AlertTriangle aria-label={r.problem.message} className="size-3 shrink-0 text-orange" />}
          </div>
        ),
    },
    {
      id: 'compat',
      title: 'Compatibility',
      header: 'Compatibility',
      width: '150px',
      cell: (r) => {
        if (isHeader(r) || isPlaceholder(r)) return null
        const c = packCompat(r.packFormats, minecraft)
        if (!c) return null
        return c.ok ? (
          <span className="flex items-center gap-1 text-meta text-label-2">
            <Check className="size-3 text-label-3" /> Compatible
          </span>
        ) : (
          <Tooltip content={c.detail}>
            <span tabIndex={0} className="flex min-w-0 items-center gap-1 text-meta text-orange">
              <AlertTriangle className="size-3.5 shrink-0" /> <span className="truncate">{c.label}</span>
            </span>
          </Tooltip>
        )
      },
    },
    { id: 'source', title: 'Source', header: 'Source', width: '92px', cell: (r) => (isHeader(r) || isPlaceholder(r) ? null : <RowSource row={r} />) },
    { id: 'size', title: 'Size', header: 'Size', width: '80px', align: 'end', cell: (r) => (isHeader(r) || isPlaceholder(r) ? null : <span className="pr-1 mono text-label-2">{r.isDirectory ? 'Folder' : formatBytes(r.size)}</span>) },
  ], [setEnabled, dropOn, request, minecraft])

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const rs = realIds(keys)
      .map((k) => byId.get(k))
      .filter((p): p is ResourceRow => !!p)
    const allOn = rs.every((p) => p.enabled)
    const one = rs.length === 1 ? rs[0] : undefined
    return [
      { label: allOn ? 'Disable' : 'Enable', onSelect: () => setEnabled(rs.map((p) => p.id), !allOn) },
      { label: 'Move Up', shortcut: 'alt+mod+up', disabled: !allOn, onSelect: () => move(keys, -1) },
      { label: 'Move Down', shortcut: 'alt+mod+down', disabled: !allOn, onSelect: () => move(keys, 1) },
      { label: 'Move to Top', disabled: !allOn, onSelect: () => move(keys, 'top') },
      { kind: 'separator' },
      { label: 'Show in Finder', disabled: !one, onSelect: () => one && void api.resources.get(id, 'resourcepacks', one.id).then((d) => revealInFinder(d.path), (e: unknown) => toastError(e, 'Couldn’t show the file')) },
      { label: 'Copy Name', onSelect: () => copyText(rs.map((p) => p.name).join('\n')) },
      { kind: 'separator' },
      { label: 'Move to Trash…', shortcut: 'mod+backspace', destructive: true, onSelect: () => setPendingTrash(rs.map((p) => p.id)) },
    ]
  }

  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.altKey && e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      move(realIds(selection), e.key === 'ArrowUp' ? -1 : 1)
    }
  }

  const selected = only ? byId.get(only) : undefined
  const total = enabled.length + (search ? 0 : available.total)
  const browse = () => navigate({ to: '/discover', search: { type: 'resourcepack', target: id } })
  const addButton = (
    <Button variant="primary" icon={<Plus />} onClick={browse}>
      Add Resource Packs
    </Button>
  )
  const moreItems = [
    { label: 'Add from Files…', onSelect: () => void addFiles() },
    { label: 'Add from Another Instance…', onSelect: () => setFromInstance(true) },
  ]
  const names = Object.fromEntries([...byId.values()].map((r) => [r.id, { name: r.name, version: r.version }]))
  const loading = enabledQuery.isPending || available.isPending

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.props}>
      <ContentBar
        trailing={
          <>
            <Button onClick={() => setUpdatesOpen(true)}>Check for Updates</Button>
            <div className="flex">
              <Button variant="primary" icon={<Plus />} onClick={browse} className="!rounded-r-none">
                Add Packs
              </Button>
              <Menu
                align="end"
                items={moreItems}
                trigger={
                  <IconButton label="More ways to add" variant="primary" tooltip={false} className="ml-px !h-[26px] !w-[22px] !rounded-l-none">
                    <ChevronDown />
                  </IconButton>
                }
              />
            </div>
          </>
        }
      >
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Filter resource packs" label="Search resource packs" className="mr-1 w-[190px]" />
        {!loading && (
          <span className="flex items-baseline gap-3 pl-1 text-callout text-label-2">
            <span>
              Enabled <span className="font-mono text-[10.5px] text-label-3 tabular">{enabled.length}</span>
            </span>
            <span>
              {search ? 'Found' : 'Total'} <span className="font-mono text-[10.5px] text-label-3 tabular">{search ? available.total : total}</span>
            </span>
          </span>
        )}
        <ScanningNote scanning={available.scanning} />
      </ContentBar>
      <SplitView
        inspectorLabel="Resource pack details"
        inspector={
          selected ? (
            <PackInspector
              key={selected.id}
              instanceId={id}
              pack={selected}
              minecraft={minecraft}
              position={order.indexOf(selected.id)}
              count={order.length}
              onEnabled={(on) => setEnabled([selected.id], on)}
              onMove={(d) => move([selected.id], d)}
              onTrash={() => setPendingTrash([selected.id])}
            />
          ) : undefined
        }
      >
        {loading ? (
          <SkeletonRows rows={8} />
        ) : enabledQuery.isError || available.isError ? (
          <QueryError error={enabledQuery.error ?? available.error} onRetry={available.refetch} what="resource packs" />
        ) : total === 0 && !search ? (
          <EmptyState
            icon={<Image />}
            title="No resource packs yet"
            description="Resource packs change textures, sounds and fonts. Drop .zip files or pack folders here, or browse for packs."
            actions={
              <>
                <Button onClick={() => void addFiles()}>Add from Files…</Button>
                {addButton}
              </>
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onKeyDownCapture}>
            <VirtualTable
              aria-label="Resource packs"
              rows={rows}
              columns={columns}
              getKey={(r) => r.id}
              groupHeader={(r) => (isHeader(r) ? r.header : null)}
              rowHeight={32}
              selection={selection}
              onSelectionChange={setSelection}
              onToggle={toggle}
              onDelete={(keys) => setPendingTrash(realIds(keys))}
              rowMenu={rowMenu}
              className="flex-1"
            />
          </div>
        )}
      </SplitView>
      <DropOverlay active={drop.active} label="Add to Resource Packs" hint="Drop .zip files or pack folders." />
      <TrashConfirm
        kind="resourcepacks"
        pending={pendingTrash}
        label={pendingTrash?.length === 1 ? byId.get(pendingTrash[0] ?? '')?.name : undefined}
        onCancel={() => setPendingTrash(null)}
        onConfirm={(ids) => {
          const label = ids.length === 1 ? byId.get(ids[0] ?? '')?.name : undefined
          setSelection(new Set())
          setPendingTrash(null)
          void trashResources(id, 'resourcepacks', ids, label)
        }}
      />
      <AddFromInstanceSheet open={fromInstance} onOpenChange={setFromInstance} instanceId={id} kind="resourcepacks" />
      <UpdatesSheet open={updatesOpen} onOpenChange={setUpdatesOpen} instanceId={id} kind="resourcepacks" names={names} />
    </div>
  )
}

function PackInspector({
  instanceId,
  pack,
  minecraft,
  position,
  count,
  onEnabled,
  onMove,
  onTrash,
}: {
  instanceId: string
  pack: ResourceRow
  minecraft: string | undefined
  position: number
  count: number
  onEnabled: (on: boolean) => void
  onMove: (d: -1 | 1 | 'top') => void
  onTrash: () => void
}) {
  const detail = useResourceDetail(instanceId, 'resourcepacks', pack.id)
  const compat = packCompat(pack.packFormats, minecraft)
  const f = pack.packFormats
  return (
    <>
      <InspectorHeader icon={<ResourceIcon row={pack} size={40} />} title={pack.name} subtitle={pack.enabled ? `Position ${position + 1} of ${count} in the load order` : 'Not enabled'} />
      <div className="flex items-center justify-between px-4 pb-3">
        <label htmlFor="rp-enabled" className="text-compact">
          Enabled
        </label>
        <Switch id="rp-enabled" checked={pack.enabled} onCheckedChange={onEnabled} />
      </div>
      {pack.enabled && (
        <div className="flex gap-2 px-4 pb-3">
          <Button size="sm" icon={<ArrowUp />} onClick={() => onMove(-1)} disabled={position === 0}>
            Move Up
          </Button>
          <Button size="sm" icon={<ArrowDown />} onClick={() => onMove(1)} disabled={position === count - 1}>
            Move Down
          </Button>
        </div>
      )}
      <InspectorSection>
        <p className="text-compact whitespace-pre-line text-label-2">{detail.data?.description || pack.summary || 'No description.'}</p>
        <ProblemNote row={pack} />
      </InspectorSection>
      <InspectorSection title="Compatibility">
        <PropertyList
          rows={[
            { label: 'Pack format', value: <span className="mono">{f ? (f.min === f.max ? f.max : `${f.min}–${f.max}`) : '—'}</span> },
            { label: 'Made for', value: f ? (releasesFor(f.max) ?? '—') : '—' },
            { label: 'This instance', value: compat ? <span className={cn(compat.ok ? 'text-label' : 'text-orange')}>{compat.label}</span> : '—' },
          ]}
        />
        {compat && !compat.ok && <p className="mt-2 text-meta text-label-2">{compat.detail}</p>}
      </InspectorSection>
      <FileSection row={pack} detail={detail.data} />
      <InspectorSection>
        <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
          Move to Trash…
        </Button>
      </InspectorSection>
    </>
  )
}
