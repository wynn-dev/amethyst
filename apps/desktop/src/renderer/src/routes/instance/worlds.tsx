import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Archive, Copy as CopyIcon, Download, Globe2, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { BackupRow, ResourceRow } from '@shared/services'
import { Alert, Badge, Button, EmptyState, Menu, SearchField, SkeletonRows, Spinner, VirtualTable, type Column, type MenuEntry, type SortState } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { findTargetRef } from '@/app/ui-store'
import { formatBytes, formatDate, formatRelative } from '@/app/visuals'
import {
  addResourceFiles,
  createBackup,
  deleteBackup,
  exportWorld,
  pruneBackups,
  restoreBackup,
  trashResources,
  useBackups,
  usePagedResources,
  useResourceDetail,
  useWatchInstance,
  type ListQuery,
} from '@/data/content'
import { openModpackImport } from '@/data/modpacks'
import { isModpackPath, pickFiles, pickFolder, pickSaveFile, revealInFinder } from '@/lib/files'
import { api } from '@/lib/rpc'
import { reportError } from '@/lib/error-text'
import { toast } from '@/ui/toast-store'
import { AddFromInstanceSheet, DropOverlay, PlaceholderCell, ResourceIcon, ScanningNote, TrashConfirm, isPlaceholder, realIds, useFileDrop, useTableRows, type ContentRow } from './content-parts'
import { CopyButton, InspectorHeader, InspectorSection, PropertyList, SplitView, SubToolbar, copyText, useInstanceId, useSelection } from './parts'

const MODE: Record<string, string> = { survival: 'Survival', creative: 'Creative', adventure: 'Adventure', spectator: 'Spectator' }
const REASON: Record<BackupRow['reason'], string> = {
  manual: 'Manual',
  'pre-launch': 'Before launch',
  'pre-version-change': 'Before version change',
  'pre-modpack-update': 'Before modpack update',
  'pre-restore': 'Before restore',
  unknown: 'Backup',
}
const SORTS: Record<string, ListQuery['sort']> = { name: 'name', played: 'modified' }
const modeOf = (w: ResourceRow) => (w.world?.hardcore ? 'Hardcore' : w.world?.gameMode ? MODE[w.world.gameMode] : '—')

/** Worlds tab: saves with backups, export and import (B4.4). */
export default function WorldsTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  useWatchInstance(id)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState>({ column: 'played', direction: 'desc' })
  const list = usePagedResources(id, 'saves', { ...(query.trim() ? { search: query.trim() } : {}), ...(sort && SORTS[sort.column] ? { sort: SORTS[sort.column], direction: sort.direction } : {}) })
  const rows = useTableRows(list)
  const { selection, setSelection, only } = useSelection()
  const [pendingTrash, setPendingTrash] = useState<string[] | null>(null)
  const [fromInstance, setFromInstance] = useState(false)
  const byId = useMemo(() => new Map(list.rows.flatMap((r) => (r ? [[r.id, r] as const] : []))), [list.rows])
  const { request } = list

  const drop = useFileDrop((paths) => {
    const packs = paths.filter(isModpackPath)
    if (packs[0]) openModpackImport({ path: packs[0] })
    const rest = paths.filter((p) => !isModpackPath(p))
    if (rest.length) void addResourceFiles(id, 'saves', rest)
  })
  const importZip = async () => {
    const paths = await pickFiles('saves', { title: 'Import World' })
    if (paths.length) await addResourceFiles(id, 'saves', paths)
  }
  const importFolder = async () => {
    const dir = await pickFolder('Import a World Folder')
    if (dir) await addResourceFiles(id, 'saves', [dir])
  }

  const columns: Column<ContentRow>[] = [
    {
      id: 'name',
      title: 'Name',
      header: 'World',
      width: 'minmax(220px,1fr)',
      sortValue: () => 0,
      cell: (w) =>
        isPlaceholder(w) ? (
          <PlaceholderCell index={w.index} request={request} />
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <ResourceIcon row={w} size={28} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{w.name}</span>
              <span className="truncate text-small text-label-2">{w.fileName}</span>
            </div>
          </div>
        ),
    },
    { id: 'mode', title: 'Game Mode', header: 'Game Mode', width: '96px', cell: (w) => (isPlaceholder(w) ? null : <span className="text-label-2">{modeOf(w)}</span>) },
    {
      id: 'played',
      title: 'Last Played',
      header: 'Last Played',
      width: '116px',
      sortValue: () => 0,
      cell: (w) => (isPlaceholder(w) ? null : <span className="text-label-2">{w.world?.lastPlayed ? formatRelative(w.world.lastPlayed) : w.mtimeMs ? formatRelative(w.mtimeMs) : '—'}</span>),
    },
    { id: 'version', title: 'Version', header: 'Version', width: '80px', cell: (w) => (isPlaceholder(w) ? null : <span className="text-label-2">{w.version || '—'}</span>) },
  ]

  const doExport = async (w: ResourceRow) => {
    const out = await pickSaveFile(`${w.name}.zip`, [{ name: 'Zip archive', extensions: ['zip'] }], `Export “${w.name}”`)
    if (out) await exportWorld(id, w.id, w.name, out)
  }
  const duplicate = async (w: ResourceRow) => {
    try {
      const d = await api.resources.get(id, 'saves', w.id)
      await addResourceFiles(id, 'saves', [d.path])
    } catch (e) {
      reportError(`Couldn’t duplicate “${w.name}”`, e)
    }
  }
  const play = (w: ResourceRow) => {
    toast({ kind: 'info', title: `Launching into “${w.name}”…` })
    api.launch.launch(id, { quickPlay: { type: 'singleplayer', world: w.fileName } }).catch((e: unknown) => reportError(`Couldn’t launch into “${w.name}”`, e))
  }

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const ws = realIds(keys)
      .map((k) => byId.get(k))
      .filter((w): w is ResourceRow => !!w)
    const one = ws.length === 1 ? ws[0] : undefined
    return [
      { label: 'Play This World', disabled: !one, onSelect: () => one && play(one) },
      { kind: 'separator' },
      { label: 'Back Up', disabled: !one, onSelect: () => one && void createBackup(id, one.id, one.name) },
      { label: 'Export…', disabled: !one, onSelect: () => one && void doExport(one) },
      { label: 'Duplicate', disabled: !one, onSelect: () => one && void duplicate(one) },
      { label: 'Show in Finder', disabled: !one, onSelect: () => one && void api.resources.get(id, 'saves', one.id).then((d) => revealInFinder(d.path), (e: unknown) => reportError('Couldn’t show the world', e)) },
      { label: 'Copy Name', onSelect: () => copyText(ws.map((w) => w.name).join('\n')) },
      { kind: 'separator' },
      { label: 'Move to Trash…', shortcut: 'mod+backspace', destructive: true, onSelect: () => setPendingTrash(ws.map((w) => w.id)) },
    ]
  }

  const selected = only ? byId.get(only) : undefined
  const importMenu = (
    <Menu
      align="end"
      items={[
        { label: 'Import World Archive (.zip)…', onSelect: () => void importZip() },
        { label: 'Import World Folder…', onSelect: () => void importFolder() },
        { label: 'Add from Another Instance…', onSelect: () => setFromInstance(true) },
        { kind: 'separator' },
        { label: 'Browse Worlds…', onSelect: () => navigate({ to: '/discover', search: { type: 'world', target: id } }) },
      ]}
      trigger={
        <Button variant="primary" icon={<Plus />}>
          Add World
        </Button>
      }
    />
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.props}>
      <SubToolbar trailing={importMenu}>
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Search worlds" className="w-[220px]" />
        {!list.isPending && <span className="text-small text-label-2 tabular">{list.total === 1 ? '1 world' : `${list.total} worlds`}</span>}
        <ScanningNote scanning={list.scanning} />
      </SubToolbar>
      <SplitView
        inspectorLabel="World details"
        inspector={
          list.total === 0 ? undefined : selected ? (
            <WorldInspector
              key={selected.id}
              instanceId={id}
              world={selected}
              onPlay={() => play(selected)}
              onExport={() => void doExport(selected)}
              onDuplicate={() => void duplicate(selected)}
              onTrash={() => setPendingTrash([selected.id])}
              onRestored={(worldId) => setSelection(new Set([worldId]))}
            />
          ) : (
            <p className="m-auto px-6 text-center text-body text-label-3">Select a world to see its details and backups</p>
          )
        }
      >
        {list.isPending ? (
          <SkeletonRows rows={6} className="pt-2" />
        ) : list.isError ? (
          <QueryError error={list.error} onRetry={list.refetch} what="worlds" />
        ) : list.total === 0 && !query.trim() ? (
          <EmptyState
            icon={<Globe2 />}
            title="No worlds yet"
            description="Worlds you create in the game appear here. Drop a world folder or .zip here to import it."
            actions={
              <>
                <Button onClick={() => void importZip()}>Import World…</Button>
                <Button variant="primary" onClick={() => navigate({ to: '/discover', search: { type: 'world', target: id } })}>
                  Browse Worlds
                </Button>
              </>
            }
          />
        ) : list.total === 0 ? (
          <EmptyState title={`No worlds match “${query.trim()}”`} actions={<Button onClick={() => setQuery('')}>Clear Search</Button>} />
        ) : (
          <VirtualTable
            aria-label="Worlds"
            rows={rows}
            columns={columns}
            getKey={(w) => w.id}
            rowHeight={44}
            selection={selection}
            onSelectionChange={setSelection}
            onDelete={(keys) => setPendingTrash(realIds(keys))}
            onActivate={(w) => !isPlaceholder(w) && play(w)}
            rowMenu={rowMenu}
            sort={sort}
            onSortChange={setSort}
            className="flex-1"
          />
        )}
      </SplitView>
      <DropOverlay active={drop.active} label="Import World" hint="Drop a world folder or a .zip archive of one." />
      <TrashConfirm
        kind="saves"
        pending={pendingTrash}
        label={pendingTrash?.length === 1 ? byId.get(pendingTrash[0] ?? '')?.name : undefined}
        onCancel={() => setPendingTrash(null)}
        onConfirm={(ids) => {
          const label = ids.length === 1 ? byId.get(ids[0] ?? '')?.name : undefined
          setSelection(new Set())
          setPendingTrash(null)
          void trashResources(id, 'saves', ids, label)
        }}
      />
      <AddFromInstanceSheet open={fromInstance} onOpenChange={setFromInstance} instanceId={id} kind="saves" />
    </div>
  )
}

function WorldInspector({
  instanceId,
  world,
  onPlay,
  onExport,
  onDuplicate,
  onTrash,
  onRestored,
}: {
  instanceId: string
  world: ResourceRow
  onPlay: () => void
  onExport: () => void
  onDuplicate: () => void
  onTrash: () => void
  onRestored: (worldId: string) => void
}) {
  const detail = useResourceDetail(instanceId, 'saves', world.id)
  const backups = useBackups(instanceId, world.id)
  const [busy, setBusy] = useState(false)
  const [replace, setReplace] = useState<BackupRow | null>(null)
  const d = detail.data?.worldDetail
  const w = world.world
  return (
    <>
      <InspectorHeader icon={<ResourceIcon row={world} size={44} />} title={world.name} subtitle={`${modeOf(world)}${world.version ? ` · ${world.version}` : ''}`} />
      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <Button variant="primary" icon={<Play className="fill-current" />} onClick={onPlay}>
          Play
        </Button>
        <Button
          icon={<Archive />}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await createBackup(instanceId, world.id, world.name)
            setBusy(false)
          }}
        >
          {busy ? 'Backing Up…' : 'Back Up'}
        </Button>
        <Button icon={<Download />} onClick={onExport}>
          Export…
        </Button>
      </div>
      <InspectorSection title="Properties">
        <PropertyList
          rows={[
            { label: 'Name', value: w?.levelName ?? world.name },
            { label: 'Folder', value: <span className="selectable font-mono text-small break-all">{world.fileName}</span> },
            { label: 'Game mode', value: modeOf(world) },
            { label: 'Cheats', value: w?.cheats ? 'On' : 'Off' },
            ...(d?.difficulty ? [{ label: 'Difficulty', value: d.difficulty.replace(/^./, (c) => c.toUpperCase()) }] : []),
            ...(d?.seed
              ? [
                  {
                    label: 'Seed',
                    value: (
                      <span className="inline-flex items-center gap-1">
                        <span className="selectable truncate font-mono text-small">{d.seed}</span>
                        <CopyButton text={d.seed} label="Copy seed" />
                      </span>
                    ),
                  },
                ]
              : []),
            { label: 'Version', value: world.version || '—' },
            ...(w?.lastPlayed ? [{ label: 'Last played', value: formatDate(w.lastPlayed) }] : []),
            ...(d?.sizeBytes || world.size ? [{ label: 'Size', value: formatBytes(d?.sizeBytes || world.size) }] : []),
          ]}
        />
        <div className="mt-2 flex gap-1">
          <Button size="sm" variant="borderless" className="-ml-2" icon={<CopyIcon />} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button size="sm" variant="borderless" disabled={!detail.data?.path} onClick={() => revealInFinder(detail.data?.path)}>
            Reveal in Finder
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection title="Backups">
        {backups.isPending ? (
          <Spinner size={14} label="Loading backups" />
        ) : backups.isError ? (
          <p className="text-callout text-red">Couldn’t list the backups.</p>
        ) : !backups.data?.length ? (
          <p className="text-callout text-label-3">No backups yet. “Back Up” saves a zip of this world.</p>
        ) : (
          <ul className="-mx-1 flex flex-col">
            {backups.data.map((b) => (
              <li key={b.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-fill">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-callout">{formatDate(b.createdAt)} · {new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  <p className="truncate text-small text-label-2">
                    {REASON[b.reason]} · {formatBytes(b.size)}
                    {b.automatic && (
                      <Badge className="ml-1" tone="neutral">
                        Auto
                      </Badge>
                    )}
                  </p>
                </div>
                <Menu
                  align="end"
                  items={[
                    {
                      label: 'Restore as a Copy',
                      onSelect: async () => {
                        const restored = await restoreBackup(instanceId, b, 'copy')
                        if (restored) onRestored(restored)
                      },
                    },
                    { label: 'Restore and Replace…', onSelect: () => setReplace(b) },
                    { kind: 'separator' },
                    { label: 'Delete Backup', destructive: true, onSelect: () => void deleteBackup(instanceId, b) },
                  ]}
                  trigger={
                    <Button size="sm" icon={<RotateCcw />} aria-label={`Restore or delete the backup from ${formatDate(b.createdAt)}`}>
                      Restore…
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {backups.data?.some((b) => b.automatic) && (
          <Button size="sm" variant="borderless" className="mt-1 -ml-2" onClick={() => void pruneBackups(instanceId)}>
            Clean Up Old Automatic Backups
          </Button>
        )}
      </InspectorSection>
      <InspectorSection>
        <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
          Move to Trash…
        </Button>
      </InspectorSection>
      <Alert
        open={!!replace}
        onOpenChange={(o) => !o && setReplace(null)}
        title={`Replace “${world.name}” with this backup?`}
        message="The current world is moved to the Trash first, so you can still get it back."
        confirmLabel="Replace"
        destructive
        onConfirm={async () => {
          const b = replace
          setReplace(null)
          if (b) {
            const restored = await restoreBackup(instanceId, b, 'replace')
            if (restored) onRestored(restored)
          }
        }}
      />
    </>
  )
}
