import { useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowDown, ArrowUp, Check, GripVertical, Image, Plus } from 'lucide-react'
import { Button, EmptyState, SearchField, SkeletonRows, Switch, Tooltip, VirtualTable, type Column, type MenuEntry } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable } from '@/app/commands'
import { findTargetRef } from '@/app/ui-store'
import { BlockIcon, formatBytes } from '@/app/visuals'
import { useResourcePacks, useSetResourcePackOrder } from '@/data/content'
import type { ResourcePack } from '@/data/types'
import { InspectorHeader, InspectorSection, PropertyList, SourceBadge, SplitView, SubToolbar, copyText, useInstanceId, useSelection } from './parts'

type Row = ResourcePack | { header: string; key: string }
const isHeader = (r: Row): r is { header: string; key: string } => 'header' in r

/** Resource Packs tab: the enabled load order (top wins) and the available packs (B4.2). */
export default function ResourcePacksTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  const packs = useResourcePacks(id)
  const setOrder = useSetResourcePackOrder(id)
  const [query, setQuery] = useState('')
  const { selection, setSelection, only } = useSelection()

  const all = useMemo(() => packs.data ?? [], [packs.data])
  const enabled = useMemo(() => all.filter((p) => p.enabled).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)), [all])
  const byId = useMemo(() => new Map(all.map((p) => [p.id, p])), [all])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (p: ResourcePack) => !q || p.name.toLowerCase().includes(q)
    const en = enabled.filter(match)
    const av = all.filter((p) => !p.enabled && match(p))
    return [
      { header: `Enabled (load order) — top overrides bottom`, key: 'h-enabled' },
      ...en,
      { header: 'Available', key: 'h-available' },
      ...av,
    ]
  }, [all, enabled, query])

  const order = enabled.map((p) => p.id)
  const setEnabled = (ids: string[], on: boolean) => {
    if (on) setOrder.mutate([...ids.filter((i) => !order.includes(i)), ...order])
    else setOrder.mutate(order.filter((i) => !ids.includes(i)))
  }
  const toggle = (ids: string[]) => setEnabled(ids, ids.some((i) => !byId.get(i)?.enabled))
  const move = (ids: string[], delta: -1 | 1) => {
    const next = [...order]
    const sel = new Set(ids.filter((i) => next.includes(i)))
    if (!sel.size) return
    const idxs = next.map((x, i) => (sel.has(x) ? i : -1)).filter((i) => i >= 0)
    if (delta < 0 ? idxs[0] === 0 : idxs[idxs.length - 1] === next.length - 1) return
    for (const i of delta < 0 ? idxs : idxs.toReversed()) {
      const j = i + delta
      ;[next[i], next[j]] = [next[j]!, next[i]!]
    }
    setOrder.mutate(next)
  }

  const columns: Column<Row>[] = [
    {
      id: 'handle',
      title: 'Order',
      header: <span className="sr-only">Order</span>,
      width: '28px',
      align: 'center',
      cell: (r) => (!isHeader(r) && r.enabled ? <GripVertical aria-label={`Position ${(r.order ?? 0) + 1}`} className="size-3.5 text-label-3" /> : null),
    },
    {
      id: 'enabled',
      title: 'Enabled',
      header: <span className="sr-only">Enabled</span>,
      width: '42px',
      align: 'center',
      cell: (r) => (isHeader(r) ? null : <Switch size="sm" checked={r.enabled} aria-label={`Enable ${r.name}`} onCheckedChange={(on) => setEnabled([r.id], on)} />),
    },
    {
      id: 'name',
      title: 'Name',
      header: 'Name',
      width: 'minmax(220px,1fr)',
      cell: (r) =>
        isHeader(r) ? null : (
          <div className="flex min-w-0 items-center gap-2.5">
            <BlockIcon hue={r.hue} label={r.name} size={24} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{r.name}</span>
              <span className="truncate text-small text-label-2">{r.description}</span>
            </div>
          </div>
        ),
    },
    {
      id: 'compat',
      title: 'Compatibility',
      header: 'Compatibility',
      width: '128px',
      cell: (r) =>
        isHeader(r) ? null : r.compatible ? (
          <span className="flex items-center gap-1 text-small text-label-2">
            <Check className="size-3.5 text-green" /> Compatible
          </span>
        ) : (
          <Tooltip content={`Pack format ${r.packFormat} was made for Minecraft ${r.madeFor}. Some textures may be missing or look wrong.`}>
            <span tabIndex={0} className="flex items-center gap-1 text-small text-orange">
              <AlertTriangle className="size-3.5" /> Made for {r.madeFor}
            </span>
          </Tooltip>
        ),
    },
    { id: 'source', title: 'Source', header: 'Source', width: '96px', cell: (r) => (isHeader(r) ? null : <SourceBadge source={r.source} />) },
    { id: 'size', title: 'Size', header: 'Size', width: '76px', align: 'end', cell: (r) => (isHeader(r) ? null : <span className="text-label-2">{formatBytes(r.sizeBytes)}</span>) },
  ]

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const rs = keys.map((k) => byId.get(k)).filter((p): p is ResourcePack => !!p)
    const allOn = rs.every((p) => p.enabled)
    return [
      { label: allOn ? 'Disable' : 'Enable', onSelect: () => setEnabled(keys, !allOn) },
      { label: 'Move Up', shortcut: 'alt+mod+up', disabled: !allOn, onSelect: () => move(keys, -1) },
      { label: 'Move Down', shortcut: 'alt+mod+down', disabled: !allOn, onSelect: () => move(keys, 1) },
      { kind: 'separator' },
      { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
      { label: 'Copy Name', onSelect: () => copyText(rs.map((p) => p.name).join('\n')) },
      { kind: 'separator' },
      { label: 'Move to Trash…', destructive: true, onSelect: () => notYetAvailable('Moving resource packs to the Trash') },
    ]
  }

  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.altKey && e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      move([...selection], e.key === 'ArrowUp' ? -1 : 1)
    }
  }

  const selected = only ? byId.get(only) : undefined
  const addButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => navigate({ to: '/discover', search: { type: 'resourcepack', target: id } })}>
      Add Resource Packs
    </Button>
  )

  return (
    <>
      <SubToolbar
        trailing={
          <>
            <Button onClick={() => notYetAvailable('Add from Files')}>Add from Files…</Button>
            {addButton}
          </>
        }
      >
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Search resource packs" className="w-[220px]" />
        {packs.data && <span className="text-small text-label-2 tabular">{`${enabled.length} enabled · ${all.length} total`}</span>}
      </SubToolbar>
      <SplitView
        inspectorLabel="Resource pack details"
        inspector={
          selected ? (
            <>
              <InspectorHeader icon={<BlockIcon hue={selected.hue} label={selected.name} size={44} />} title={selected.name} subtitle={selected.enabled ? `Position ${(selected.order ?? 0) + 1} in load order` : 'Not enabled'} />
              <div className="flex items-center justify-between px-4 pb-3">
                <label htmlFor="rp-enabled" className="text-body">
                  Enabled
                </label>
                <Switch id="rp-enabled" checked={selected.enabled} onCheckedChange={(on) => setEnabled([selected.id], on)} />
              </div>
              {selected.enabled && (
                <div className="flex gap-2 px-4 pb-3">
                  <Button size="sm" icon={<ArrowUp />} onClick={() => move([selected.id], -1)} disabled={selected.order === 0}>
                    Move Up
                  </Button>
                  <Button size="sm" icon={<ArrowDown />} onClick={() => move([selected.id], 1)} disabled={selected.order === enabled.length - 1}>
                    Move Down
                  </Button>
                </div>
              )}
              <InspectorSection>
                <p className="text-callout">{selected.description}</p>
              </InspectorSection>
              <InspectorSection title="Details">
                <PropertyList
                  rows={[
                    { label: 'Pack format', value: selected.packFormat },
                    { label: 'Compatibility', value: selected.compatible ? 'Compatible' : `Made for ${selected.madeFor}` },
                    { label: 'Size', value: formatBytes(selected.sizeBytes) },
                    { label: 'Source', value: <SourceBadge source={selected.source} /> },
                  ]}
                />
              </InspectorSection>
            </>
          ) : (
            <p className="m-auto px-6 text-center text-body text-label-3">Select a resource pack to see its details</p>
          )
        }
      >
        {packs.isPending ? (
          <SkeletonRows rows={8} className="pt-2" />
        ) : packs.isError ? (
          <QueryError error={packs.error} onRetry={() => packs.refetch()} what="resource packs" />
        ) : all.length === 0 ? (
          <EmptyState icon={<Image />} title="No resource packs yet" description="Resource packs change textures, sounds and fonts. Drop .zip files here or browse for packs." actions={addButton} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onKeyDownCapture}>
            <VirtualTable
              aria-label="Resource packs"
              rows={rows}
              columns={columns}
              getKey={(r) => (isHeader(r) ? r.key : r.id)}
              groupHeader={(r) => (isHeader(r) ? r.header : null)}
              rowHeight={40}
              selection={selection}
              onSelectionChange={setSelection}
              onToggle={toggle}
              rowMenu={rowMenu}
              className="flex-1"
            />
          </div>
        )}
      </SplitView>
    </>
  )
}
