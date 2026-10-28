import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Blocks, Check, ChevronDown, ExternalLink, ListFilter, Plus, Trash2 } from 'lucide-react'
import type { MarketPlatform, ModAnalysis, ResourceRow, UpdateCandidate } from '@shared/services'
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Menu,
  Popover,
  RadioList,
  SearchField,
  Sheet,
  SkeletonRows,
  Spinner,
  Switch,
  TextField,
  VirtualTable,
  cn,
  type Column,
  type MenuEntry,
  type SortState,
} from '@/ui'
import { ChipGroup, chipButtonClass } from '@/ui/Chips'
import { QueryError } from '@/app/RouteStates'
import { openInstance } from '@/app/commands'
import { findTargetRef } from '@/app/ui-store'
import { formatBytes } from '@/app/visuals'
import { addResourceFiles, setResourcesEnabled, trashResources, useModAnalysis, usePagedResources, useResourceDetail, useWatchInstance, type ListQuery } from '@/data/content'
import { useInstanceInfo } from '@/data/instance-info'
import { applyUpdates, projectKey, useUpdateCandidates } from '@/data/market'
import { openModpackImport } from '@/data/modpacks'
import { isModpackPath, isZipPath, openExternal, pickFiles } from '@/lib/files'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { revealInFinder } from '@/lib/files'
import {
  AddFromInstanceSheet,
  ContentBar,
  CountLabel,
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
  shortDate,
  useFileDrop,
  useResourceCount,
  useTableRows,
  type ContentRow,
} from './content-parts'
import { InspectorHeader, InspectorSection, SplitView, copyText, sideLabel, useInstanceId, useSelection } from './parts'
import { UpdatesSheet } from './updates-sheet'

type Show = 'all' | 'enabled' | 'disabled'
/** The filter chips: the three "show" states, plus "has an update". */
type Chip = Show | 'updates'
type SourceFilter = MarketPlatform | 'local'
interface Filters {
  show: Show
  hasUpdate: boolean
  problems: boolean
  sources: Set<SourceFilter>
}
const ALL_SOURCES: SourceFilter[] = ['modrinth', 'curseforge', 'local']
const SOURCE_LABEL: Record<SourceFilter, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local files' }
const DEFAULT_FILTERS: Filters = { show: 'all', hasUpdate: false, problems: false, sources: new Set(ALL_SOURCES) }
/** Columns hidden until the user shows them from the header's context menu. */
const DEFAULT_HIDDEN = ['side', 'size']
/** Columns the runtime can sort by. */
const SORTS: Record<string, ListQuery['sort']> = { name: 'name', size: 'size', modified: 'modified' }

type ProblemKind = 'duplicate' | 'missing-dependency' | 'incompatible' | 'broken'
const PROBLEM_LABEL: Record<ProblemKind, string> = { duplicate: 'Duplicate', 'missing-dependency': 'Missing dependency', incompatible: 'Incompatible', broken: 'Damaged file' }

/** Row id → its problems, from the runtime's analysis. */
function problemIndex(a: ModAnalysis | undefined): Map<string, ProblemKind[]> {
  const out = new Map<string, ProblemKind[]>()
  const add = (id: string, p: ProblemKind) => out.set(id, [...new Set([...(out.get(id) ?? []), p])])
  for (const d of a?.duplicates ?? []) for (const id of d.ids) add(id, 'duplicate')
  for (const m of a?.missing ?? []) add(m.id, 'missing-dependency')
  for (const i of a?.incompatible ?? []) add(i.id, 'incompatible')
  for (const b of a?.broken ?? []) add(b.id, 'broken')
  return out
}

/** Mods tab: one paged, virtualised table with native selection and an inspector (B4.1). */
export default function ModsTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  useWatchInstance(id)
  const info = useInstanceInfo(id)
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query.trim())
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<SortState>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(DEFAULT_HIDDEN))
  const [pendingTrash, setPendingTrash] = useState<string[] | null>(null)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [checked, setChecked] = useState(false)
  const [fromInstance, setFromInstance] = useState(false)
  const [pasteUrl, setPasteUrl] = useState(false)
  const { selection, setSelection, only } = useSelection()

  const vanilla = info.data ? info.data.loader === null : false
  const analysis = useModAnalysis(id, !vanilla)
  const problems = useMemo(() => problemIndex(analysis.data), [analysis.data])
  const updates = useUpdateCandidates(id, 'mods', checked)
  const updateById = useMemo(() => new Map((updates.data ?? []).map((u) => [u.resourceId, u])), [updates.data])

  const listQuery = useMemo<ListQuery>(() => {
    let ids: string[] | undefined
    if (filters.hasUpdate) ids = [...updateById.keys()]
    if (filters.problems) ids = (ids ?? [...problems.keys()]).filter((x) => problems.has(x))
    return {
      ...(search ? { search } : {}),
      ...(sort && SORTS[sort.column] ? { sort: SORTS[sort.column], direction: sort.direction } : {}),
      ...(filters.show !== 'all' ? { enabled: filters.show === 'enabled' } : {}),
      ...(ids ? { ids } : {}),
      ...(filters.sources.size < ALL_SOURCES.length ? { sources: [...filters.sources] } : {}),
    }
  }, [search, sort, filters, updateById, problems])
  const list = usePagedResources(id, 'mods', listQuery)
  const unfiltered = usePagedResources(id, 'mods', {})
  const disabledCount = useResourceCount(id, 'mods', { enabled: false }, !vanilla)
  const rows = useTableRows(list)
  const byId = useMemo(() => new Map(list.rows.flatMap((r) => (r ? [[r.id, r] as const] : []))), [list.rows])
  const { request } = list

  const toggle = useCallback(
    (ids: string[]) => {
      const real = realIds(ids)
      const anyDisabled = real.some((i) => byId.get(i)?.enabled === false)
      void setResourcesEnabled(id, 'mods', real, anyDisabled)
    },
    [byId, id],
  )

  const drop = useFileDrop((paths) => {
    const packs = paths.filter((p) => isModpackPath(p) || isZipPath(p))
    const jars = paths.filter((p) => !packs.includes(p))
    if (packs[0]) openModpackImport({ path: packs[0] })
    if (jars.length) void addResourceFiles(id, 'mods', jars)
  })
  const addFiles = async () => {
    const paths = await pickFiles('mods', { title: 'Add Mods' })
    if (paths.length) await addResourceFiles(id, 'mods', paths)
  }

  // Disabled rows dim their name and version (cells marked `data-dim`), not the switch.
  const columns = useMemo<Column<ContentRow>[]>(
    () => [
      {
        id: 'enabled',
        title: 'Enabled',
        header: <span className="sr-only">Enabled</span>,
        width: '42px',
        align: 'center',
        cell: (m) => (isPlaceholder(m) ? null : <Switch size="sm" checked={m.enabled} aria-label={`Enable ${m.name}`} onCheckedChange={(on) => void setResourcesEnabled(id, 'mods', [m.id], on)} />),
      },
      {
        id: 'name',
        title: 'Name',
        header: 'Name',
        width: 'minmax(220px,1fr)',
        sortValue: () => 0,
        cell: (m) => {
          if (isPlaceholder(m)) return <PlaceholderCell index={m.index} request={request} />
          const issues = problems.get(m.id) ?? (m.problem ? (['broken'] as ProblemKind[]) : undefined)
          const label = issues?.map((p) => PROBLEM_LABEL[p]).join(', ')
          return (
            <div className="flex min-w-0 items-center gap-[9px]">
              <span data-dim className="flex shrink-0">
                <ResourceIcon row={m} />
              </span>
              <span data-dim className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">{m.name}</span>
                {m.authors.length > 0 && <span className="truncate text-meta text-label-3">{m.authors.join(', ')}</span>}
              </span>
              {label && (
                <span title={label} className="flex shrink-0 text-orange">
                  <AlertTriangle aria-label={label} className="size-3" />
                </span>
              )}
            </div>
          )
        },
      },
      {
        id: 'version',
        title: 'Version',
        header: 'Version',
        width: '160px',
        hideable: true,
        cell: (m) => {
          if (isPlaceholder(m)) return null
          const u = updateById.get(m.id)
          const current = m.pending ? 'Reading…' : m.version || '—'
          return (
            <span data-dim className="flex min-w-0 items-baseline gap-[5px] mono text-label-2" title={u ? `Update available: ${u.latest.versionNumber}` : m.version || m.fileName}>
              <span className="truncate">{current}</span>
              {u && (
                <>
                  <span aria-hidden className="shrink-0 text-accent">
                    →
                  </span>
                  <span className="sr-only">updates to</span>
                  <span className="truncate text-label">{u.latest.versionNumber}</span>
                </>
              )}
            </span>
          )
        },
      },
      { id: 'source', title: 'Source', header: 'Source', width: '92px', hideable: true, cell: (m) => (isPlaceholder(m) ? null : <RowSource row={m} />) },
      { id: 'side', title: 'Side', header: 'Side', width: '64px', hideable: true, cell: (m) => (isPlaceholder(m) || !m.side ? null : <span className="text-meta text-label-2">{sideLabel[m.side]}</span>) },
      { id: 'size', title: 'Size', header: 'Size', width: '76px', align: 'end', hideable: true, sortValue: () => 0, cell: (m) => (isPlaceholder(m) ? null : <span className="mono text-label-2">{formatBytes(m.size)}</span>) },
      {
        id: 'modified',
        title: 'Date Added',
        header: 'Added',
        width: '84px',
        hideable: true,
        sortValue: () => 0,
        cell: (m) => (isPlaceholder(m) || !m.mtimeMs ? null : <span className="pr-1 mono text-label-2">{shortDate(m.mtimeMs)}</span>),
      },
    ],
    [id, request, problems, updateById],
  )

  const openProject = (row: ResourceRow) => row.source && navigate({ to: '/discover/$projectId', params: { projectId: projectKey(row.source.platform, row.source.projectId) }, search: { target: id } })

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const sel = realIds(keys)
      .map((k) => byId.get(k))
      .filter((m): m is ResourceRow => !!m)
    const one = sel.length === 1 ? sel[0] : undefined
    const allEnabled = sel.every((m) => m.enabled)
    const updatable = sel.flatMap((m) => (updateById.get(m.id) ? [updateById.get(m.id) as UpdateCandidate] : []))
    return [
      { label: allEnabled ? (one ? 'Disable' : `Disable ${sel.length} Mods`) : one ? 'Enable' : `Enable ${sel.length} Mods`, onSelect: () => void setResourcesEnabled(id, 'mods', sel.map((m) => m.id), !allEnabled) },
      {
        label: updatable.length > 1 ? `Update ${updatable.length} Mods` : 'Update',
        disabled: !updatable.length,
        onSelect: () => void applyUpdates(id, 'mods', updatable, Object.fromEntries(sel.map((m) => [m.id, m.name]))),
      },
      { kind: 'separator' },
      { label: 'Show in Finder', disabled: !one, onSelect: () => one && void api.resources.get(id, 'mods', one.id).then((d) => revealInFinder(d.path), (e: unknown) => toastError(e, 'Couldn’t show the file')) },
      ...(one?.source ? [{ label: one.source.platform === 'modrinth' ? 'Open on Modrinth' : 'Open on CurseForge', onSelect: () => openProject(one) } as MenuEntry] : []),
      { label: one ? 'Copy Name' : 'Copy Names', onSelect: () => copyText(sel.map((m) => m.name).join('\n'), 'Copied') },
      { kind: 'separator' },
      { label: 'Move to Trash…', shortcut: 'mod+backspace', destructive: true, onSelect: () => setPendingTrash(sel.map((m) => m.id)) },
    ]
  }

  if (vanilla) {
    return (
      <EmptyState
        icon={<Blocks />}
        title="Add a mod loader"
        description="Mods need Fabric, Quilt, Forge or NeoForge. Adding a loader changes this instance’s version, and you’ll see what changes before anything happens."
        actions={
          <Button variant="primary" onClick={() => openInstance(id, 'settings')}>
            Change Version…
          </Button>
        }
      />
    )
  }

  // The chips show "show" and "has update"; the Filter popover counts what it holds.
  const filterCount = (filters.problems ? 1 : 0) + (filters.sources.size < ALL_SOURCES.length ? 1 : 0)
  const selected = only ? byId.get(only) : undefined
  const a = analysis.data
  const summary = [
    a?.duplicates.length && `${a.duplicates.length} duplicate${a.duplicates.length > 1 ? 's' : ''}`,
    a?.missing.length && `${a.missing.length} missing dependenc${a.missing.length > 1 ? 'ies' : 'y'}`,
    a?.incompatible.length && `${a.incompatible.length} incompatible`,
    a?.broken.length && `${a.broken.length} damaged file${a.broken.length > 1 ? 's' : ''}`,
  ].filter(Boolean)
  const total = unfiltered.total
  const names = Object.fromEntries([...byId.values()].map((r) => [r.id, { name: r.name, version: r.version }]))
  const browse = () => navigate({ to: '/discover', search: { type: 'mod', target: id } })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.props}>
      <ContentBar
        trailing={
          <>
            <Button
              onClick={() => {
                setChecked(true)
                setUpdatesOpen(true)
              }}
            >
              {updateById.size ? 'Update All…' : 'Check for Updates'}
            </Button>
            <div className="flex">
              <Button variant="primary" icon={<Plus />} onClick={browse} className="!rounded-r-none">
                Add Mods
              </Button>
              <Menu
                align="end"
                items={[
                  { label: 'Add from Files…', onSelect: () => void addFiles() },
                  { label: 'Paste URL…', onSelect: () => setPasteUrl(true) },
                  { label: 'Add from Another Instance…', onSelect: () => setFromInstance(true) },
                ]}
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
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Filter mods" label="Search mods" className="mr-1 w-[190px]" />
        <ChipGroup<Chip>
          aria-label="Show"
          value={filters.hasUpdate ? 'updates' : filters.show}
          onValueChange={(v) => {
            if (v === 'updates') setChecked(true)
            setFilters({ ...filters, show: v === 'updates' ? 'all' : v, hasUpdate: v === 'updates' })
          }}
          options={[
            { value: 'all', label: 'All', count: total },
            { value: 'enabled', label: 'Enabled', count: disabledCount === undefined ? undefined : total - disabledCount },
            { value: 'disabled', label: 'Disabled', count: disabledCount },
            { value: 'updates', label: 'Updates', count: updates.data ? updateById.size : undefined },
          ]}
        />
        <FilterPopover filters={filters} onChange={setFilters} count={filterCount} />
        {!list.isPending && (list.total !== total || selection.size > 1) && <CountLabel kind="mods" total={list.total} all={total} selected={selection.size} />}
        {checked && updates.isFetching && (
          <span className="flex items-center gap-1.5 pl-1 text-meta text-label-2" role="status">
            <Spinner size={11} /> Checking for updates…
          </span>
        )}
        <ScanningNote scanning={list.scanning} />
      </ContentBar>

      {summary.length > 0 && (
        <div className="shrink-0 px-4 pb-2.5">
          <Banner
            tone="warning"
            title={summary.join(' · ')}
            actions={
              <Button size="md" onClick={() => setProblemsOpen(true)}>
                Review
              </Button>
            }
          />
        </div>
      )}

      <SplitView
        inspectorLabel="Mod details"
        inspector={
          total === 0 ? undefined : selection.size > 1 ? (
            <MultiInspector count={realIds(selection).length} onToggle={() => toggle([...selection])} onTrash={() => setPendingTrash(realIds(selection))} />
          ) : selected ? (
            <ModInspector
              key={selected.id}
              instanceId={id}
              mod={selected}
              analysis={a}
              update={updateById.get(selected.id)}
              onTrash={() => setPendingTrash([selected.id])}
              onOpenProject={() => openProject(selected)}
              names={names}
            />
          ) : undefined
        }
      >
        {list.isPending ? (
          <SkeletonRows rows={12} />
        ) : list.isError ? (
          <QueryError error={list.error} onRetry={list.refetch} what="mods" />
        ) : total === 0 ? (
          <EmptyState
            icon={<Blocks />}
            title="No mods yet"
            description="Browse Modrinth and CurseForge for mods that work with this instance, or drop .jar files here."
            actions={
              <>
                <Button onClick={() => void addFiles()}>Add from Files…</Button>
                <Button variant="primary" onClick={browse}>
                  Browse Mods
                </Button>
              </>
            }
          />
        ) : list.total === 0 ? (
          <EmptyState
            title={search ? `No mods match “${search}”` : 'No mods match these filters'}
            actions={
              <Button
                onClick={() => {
                  setQuery('')
                  setFilters(DEFAULT_FILTERS)
                }}
              >
                Clear Filters
              </Button>
            }
          />
        ) : (
          <VirtualTable
            aria-label="Mods"
            rows={rows}
            columns={columns}
            getKey={(m) => m.id}
            rowHeight={32}
            selection={selection}
            onSelectionChange={setSelection}
            onToggle={toggle}
            onDelete={(keys) => setPendingTrash(realIds(keys))}
            rowMenu={rowMenu}
            sort={sort}
            onSortChange={setSort}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            rowClassName={(m) => (!isPlaceholder(m) && !m.enabled ? '[&_[data-dim]]:opacity-45' : undefined)}
            className="flex-1"
          />
        )}
      </SplitView>

      <DropOverlay active={drop.active} label="Add to Mods" hint="Drop .jar files. A modpack (.mrpack or .zip) opens the import review." />
      <TrashConfirm
        kind="mods"
        pending={pendingTrash}
        label={pendingTrash?.length === 1 ? byId.get(pendingTrash[0] ?? '')?.name : undefined}
        onCancel={() => setPendingTrash(null)}
        onConfirm={(ids) => {
          const label = ids.length === 1 ? byId.get(ids[0] ?? '')?.name : undefined
          setSelection(new Set())
          setPendingTrash(null)
          void trashResources(id, 'mods', ids, label)
        }}
      />
      <ProblemsSheet open={problemsOpen} onOpenChange={setProblemsOpen} instanceId={id} analysis={a} names={names} onOpenDiscover={(q) => navigate({ to: '/discover', search: { type: 'mod', q, target: id } })} />
      <UpdatesSheet open={updatesOpen} onOpenChange={setUpdatesOpen} instanceId={id} kind="mods" names={names} />
      <AddFromInstanceSheet open={fromInstance} onOpenChange={setFromInstance} instanceId={id} kind="mods" />
      <PasteUrlSheet open={pasteUrl} onOpenChange={setPasteUrl} onProject={(key) => navigate({ to: '/discover/$projectId', params: { projectId: key }, search: { target: id } })} />
    </div>
  )
}

function FilterPopover({ filters, onChange, count }: { filters: Filters; onChange: (f: Filters) => void; count: number }) {
  return (
    <Popover
      label="Filter mods"
      align="start"
      width={248}
      trigger={
        <button type="button" className={cn(chipButtonClass, 'ml-1', count > 0 && 'text-label')} aria-label={count ? `Filters, ${count} active` : 'Filters'}>
          <ListFilter />
          Filter
          {count > 0 && <span className="font-mono text-[10.5px] text-label-3 tabular">{count}</span>}
        </button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-meta font-semibold text-label-2">Problems</span>
          <Checkbox
            checked={filters.problems}
            onCheckedChange={(problems) => onChange({ ...filters, problems })}
            label="Has problems"
            description="Missing dependency, incompatible, duplicate or damaged"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta font-semibold text-label-2">Source</span>
          {ALL_SOURCES.map((s) => (
            <Checkbox
              key={s}
              checked={filters.sources.has(s)}
              label={SOURCE_LABEL[s]}
              onCheckedChange={(on) => {
                const next = new Set(filters.sources)
                if (on) next.add(s)
                else next.delete(s)
                onChange({ ...filters, sources: next })
              }}
            />
          ))}
        </div>
        {count > 0 && (
          <Button variant="link" className="self-start" onClick={() => onChange({ ...filters, problems: false, sources: new Set(ALL_SOURCES) })}>
            Reset Filters
          </Button>
        )}
      </div>
    </Popover>
  )
}

function ModInspector({
  instanceId,
  mod,
  analysis,
  update,
  onTrash,
  onOpenProject,
  names,
}: {
  instanceId: string
  mod: ResourceRow
  analysis: ModAnalysis | undefined
  update: UpdateCandidate | undefined
  onTrash: () => void
  onOpenProject: () => void
  names: Record<string, { name: string }>
}) {
  const detail = useResourceDetail(instanceId, 'mods', mod.id)
  const d = detail.data
  const missing = new Set((analysis?.missing ?? []).filter((m) => m.id === mod.id).map((m) => m.modId.toLowerCase()))
  const dependents = analysis?.dependents[mod.id] ?? []
  const problems = [
    ...(analysis?.duplicates.some((x) => x.ids.includes(mod.id)) ? ['Another file provides the same mod'] : []),
    ...(analysis?.incompatible.filter((i) => i.id === mod.id).map((i) => i.message) ?? []),
  ]
  const deps = (d?.dependencies ?? []).filter((x) => x.kind === 'depends' && x.required && !['minecraft', 'java', 'fabricloader', 'forge', 'neoforge', 'quilt_loader'].includes(x.modId))
  const links = d ? (Object.entries(d.links).filter(([, url]) => url && /^https:\/\//i.test(url)) as [string, string][]) : []
  return (
    <>
      <InspectorHeader icon={<ResourceIcon row={mod} size={40} />} title={mod.name} subtitle={mod.authors.length ? `by ${mod.authors.join(', ')}` : mod.fileName} />
      <div className="flex items-center justify-between px-4 pb-3">
        <label htmlFor="mod-enabled" className="text-compact">
          Enabled
        </label>
        <Switch id="mod-enabled" checked={mod.enabled} onCheckedChange={(on) => void setResourcesEnabled(instanceId, 'mods', [mod.id], on)} />
      </div>
      <InspectorSection>
        <p className="text-compact whitespace-pre-line text-label-2">{d?.description || mod.summary || (mod.pending ? 'Reading the file…' : 'No description.')}</p>
        <ProblemNote row={mod} />
        {problems.map((p) => (
          <p key={p} className="mt-2 flex items-center gap-1.5 text-compact text-orange">
            <AlertTriangle className="size-3.5 shrink-0" /> {p}
          </p>
        ))}
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {links.map(([label, url]) => (
              <button key={label} type="button" className="flex items-center gap-1 text-meta text-label hover:underline" onClick={() => openExternal(url)}>
                {label === 'homepage' ? 'Website' : label === 'issues' ? 'Issues' : 'Source'} <ExternalLink className="size-3 text-label-3" />
              </button>
            ))}
          </div>
        )}
      </InspectorSection>
      <InspectorSection title="Version">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate mono">{mod.version || '—'}</span>
          {update ? (
            <Button size="sm" variant="primary" onClick={() => void applyUpdates(instanceId, 'mods', [update], { [mod.id]: mod.name })}>
              Update to {update.latest.versionNumber}
            </Button>
          ) : (
            <Button size="sm" onClick={onOpenProject} disabled={!mod.source}>
              Change Version…
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <RowSource row={mod} />
          {mod.side && <span className="text-meta text-label-2">· {sideLabel[mod.side]} side</span>}
          {d?.license && <span className="truncate text-meta text-label-2">· {d.license}</span>}
        </div>
      </InspectorSection>
      <InspectorSection title="Dependencies">
        {deps.length === 0 ? (
          <p className="text-compact text-label-3">None</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {deps.map((dep) => {
              const ok = !missing.has(dep.modId.toLowerCase())
              return (
                <li key={dep.modId} className="flex h-6 items-center gap-1.5">
                  {ok ? <Check className="size-3.5 text-label-3" aria-label="Installed" /> : <AlertTriangle className="size-3.5 text-orange" aria-label="Missing" />}
                  <span className="flex-1 truncate mono">{dep.modId}</span>
                  {!ok && <InstallDependencyButton instanceId={instanceId} modId={dep.modId} />}
                </li>
              )
            })}
          </ul>
        )}
      </InspectorSection>
      {dependents.length > 0 && (
        <InspectorSection title="Required by">
          <p className="text-compact">{dependents.map((x) => names[x]?.name ?? x).join(', ')}</p>
        </InspectorSection>
      )}
      <FileSection row={mod} detail={d} />
      <InspectorSection>
        <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
          Move to Trash…
        </Button>
      </InspectorSection>
    </>
  )
}

/** Missing dependencies are looked up by their mod id in Discover (scoped to this instance). */
function InstallDependencyButton({ instanceId, modId }: { instanceId: string; modId: string }) {
  const navigate = useNavigate()
  return (
    <Button size="sm" onClick={() => navigate({ to: '/discover', search: { type: 'mod', q: modId, target: instanceId } })}>
      Find
    </Button>
  )
}

function MultiInspector({ count, onToggle, onTrash }: { count: number; onToggle: () => void; onTrash: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Blocks className="size-7 text-label-3" strokeWidth={1.5} />
      <p className="text-headline font-semibold">
        <span className="tabular">{count}</span> mods selected
      </p>
      <div className="flex gap-2">
        <Button onClick={onToggle}>Enable/Disable</Button>
        <Button variant="destructive" onClick={onTrash}>
          Move to Trash…
        </Button>
      </div>
      <p className="text-meta text-label-2">Press Space to toggle, ⌘⌫ to move to the Trash.</p>
    </div>
  )
}

/** One sheet for every kind of problem (replaces three separate dialogs, ui.md C12). */
function ProblemsSheet({
  open,
  onOpenChange,
  instanceId,
  analysis,
  names,
  onOpenDiscover,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  instanceId: string
  analysis: ModAnalysis | undefined
  names: Record<string, { name: string; version: string }>
  onOpenDiscover: (query: string) => void
}) {
  const [keep, setKeep] = useState<Record<string, string>>({})
  const name = (id: string) => names[id]?.name ?? id
  const a = analysis ?? { duplicates: [], missing: [], incompatible: [], dependents: {}, broken: [] }
  const none = !a.duplicates.length && !a.missing.length && !a.incompatible.length && !a.broken.length
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Problems"
      description="Review each problem. Nothing changes until you choose an action."
      width={580}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {a.duplicates.map((dup) => {
          const keepId = keep[dup.modId] ?? dup.ids[0] ?? ''
          return (
            <section key={dup.modId} aria-label={`Duplicates of ${dup.modId}`}>
              <h3 className="mb-1 text-body font-semibold">Duplicates: {dup.modId}</h3>
              <p className="mb-2 text-small text-label-2">Choose the file to keep. The others are moved to the Trash.</p>
              <RadioList
                aria-label="File to keep"
                value={keepId}
                onValueChange={(v) => setKeep({ ...keep, [dup.modId]: v })}
                options={dup.ids.map((id) => ({ value: id, label: id, description: names[id]?.version }))}
              />
              <Button className="mt-2.5" onClick={() => void trashResources(instanceId, 'mods', dup.ids.filter((x) => x !== keepId))}>
                Keep Selected, Trash Others
              </Button>
            </section>
          )
        })}
        {a.missing.length > 0 && (
          <section aria-label="Missing dependencies">
            <h3 className="mb-2 text-body font-semibold">Missing dependencies</h3>
            <ul className="flex flex-col gap-1.5">
              {a.missing.map((m) => (
                <li key={`${m.id}:${m.modId}`} className="flex items-center gap-2 text-body">
                  <span className="min-w-0 flex-1">
                    {name(m.id)} needs <strong className="font-mono text-callout font-semibold">{m.modId}</strong>
                    {m.range && m.range !== '*' && <span className="text-small text-label-2"> ({m.range})</span>}
                  </span>
                  <Button
                    size="md"
                    variant="primary"
                    onClick={() => {
                      onOpenChange(false)
                      onOpenDiscover(m.modId)
                    }}
                  >
                    Find & Install
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {a.incompatible.length > 0 && (
          <section aria-label="Incompatible">
            <h3 className="mb-2 text-body font-semibold">Incompatible</h3>
            <ul className="flex flex-col gap-1.5">
              {a.incompatible.map((m) => (
                <li key={`${m.id}:${m.with ?? ''}`} className="flex items-center gap-2 text-body">
                  <span className="min-w-0 flex-1">
                    {name(m.id)} <span className="text-meta text-orange">{m.reason === 'loader' ? m.message : `Conflicts with ${name(m.with ?? '')}`}</span>
                  </span>
                  <Button size="md" onClick={() => void setResourcesEnabled(instanceId, 'mods', [m.id], false)}>
                    Disable
                  </Button>
                  <Button size="md" onClick={() => void trashResources(instanceId, 'mods', [m.id], name(m.id))}>
                    Move to Trash
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {a.broken.length > 0 && (
          <section aria-label="Damaged files">
            <h3 className="mb-2 text-body font-semibold">Damaged or unreadable files</h3>
            <ul className="flex flex-col gap-1.5">
              {a.broken.map((b) => (
                <li key={b.id} className="flex items-center gap-2 text-body">
                  <span className="min-w-0 flex-1 truncate" title={b.message}>
                    {name(b.id)} <span className="text-small text-label-2">{b.message}</span>
                  </span>
                  <Button size="md" onClick={() => void trashResources(instanceId, 'mods', [b.id], name(b.id))}>
                    Move to Trash
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {none && <p className="text-body text-label-2">No problems found.</p>}
      </div>
    </Sheet>
  )
}

/** "Paste URL…": open a Modrinth project page from its link. */
function PasteUrlSheet({ open, onOpenChange, onProject }: { open: boolean; onOpenChange: (o: boolean) => void; onProject: (key: string) => void }) {
  const [url, setUrl] = useState('')
  const m = /^https:\/\/(?:www\.)?modrinth\.com\/(?:mod|plugin|datapack|resourcepack|shader|modpack)\/([\w.-]+)/i.exec(url.trim())
  const cf = /^https:\/\/(?:www\.)?curseforge\.com\//i.test(url.trim())
  const error = !url.trim() ? undefined : m ? undefined : cf ? 'CurseForge links can’t be opened directly yet. Search for the project by name in Discover.' : 'Paste a Modrinth project link, e.g. https://modrinth.com/mod/sodium'
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Open a Project Link" width={460}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!m?.[1]) return
          onOpenChange(false)
          setUrl('')
          onProject(`modrinth:${m[1]}`)
        }}
      >
        <TextField label="Link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://modrinth.com/mod/…" error={error} autoFocus />
        <div className="-mx-5 -mb-4 mt-2 flex justify-end gap-2 border-t border-separator px-5 py-3">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!m}>
            Open
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
