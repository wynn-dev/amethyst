import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowUpCircle, Blocks, Check, ListFilter, Plus, Trash2 } from 'lucide-react'
import {
  Alert,
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Menu,
  Popover,
  RadioList,
  SearchField,
  Segmented,
  Sheet,
  SkeletonRows,
  Switch,
  VirtualTable,
  cn,
  type Column,
  type MenuEntry,
} from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable, openInstance } from '@/app/commands'
import { findTargetRef } from '@/app/ui-store'
import { BlockIcon, formatBytes, formatDate } from '@/app/visuals'
import { useInstances } from '@/data/instances'
import { useMods, useSetModsEnabled, useTrashMods } from '@/data/content'
import type { ModFile, Source } from '@/data/types'
import {
  CopyButton,
  InspectorHeader,
  InspectorSection,
  PropertyList,
  SourceBadge,
  SplitView,
  SubToolbar,
  copyText,
  sideLabel,
  useInstanceId,
  useSelection,
  useSorted,
} from './parts'

type Show = 'all' | 'enabled' | 'disabled'
interface Filters {
  show: Show
  hasUpdate: boolean
  problems: boolean
  sources: Set<Source>
}
const ALL_SOURCES: Source[] = ['modrinth', 'curseforge', 'local']
const SOURCE_LABEL: Record<Source, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local files' }
const PROBLEM_LABEL = { duplicate: 'Duplicate', 'missing-dependency': 'Missing dependency', incompatible: 'Incompatible' } as const

/** Mods tab: one table with native selection and an inspector (B4.1). */
export default function ModsTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  const { data: instances } = useInstances()
  const inst = instances?.find((i) => i.id === id)
  const mods = useMods(id)
  const setEnabled = useSetModsEnabled(id)
  const setModsEnabled = setEnabled.mutate
  const trash = useTrashMods(id)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Filters>({ show: 'all', hasUpdate: false, problems: false, sources: new Set(ALL_SOURCES) })
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(['added']))
  const [pendingTrash, setPendingTrash] = useState<string[] | null>(null)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const { selection, setSelection, only } = useSelection()

  const all = useMemo(() => mods.data ?? [], [mods.data])
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter(
      (m) =>
        (!q || m.name.toLowerCase().includes(q) || m.fileName.toLowerCase().includes(q) || m.author.toLowerCase().includes(q)) &&
        (filters.show === 'all' || (filters.show === 'enabled' ? m.enabled : !m.enabled)) &&
        (!filters.hasUpdate || m.update) &&
        (!filters.problems || m.problem) &&
        filters.sources.has(m.source),
    )
  }, [all, query, filters])

  const toggle = (ids: string[]) => {
    const anyDisabled = ids.some((i) => byId.get(i)?.enabled === false)
    setEnabled.mutate({ ids, enabled: anyDisabled })
  }

  const columns = useMemo<Column<ModFile>[]>(
    () => [
      {
        id: 'enabled',
        title: 'Enabled',
        header: <span className="sr-only">Enabled</span>,
        width: '34px',
        align: 'center',
        sortValue: (m) => (m.enabled ? 0 : 1),
        cell: (m) => <Checkbox checked={m.enabled} aria-label={`Enable ${m.name}`} onCheckedChange={(on) => setModsEnabled({ ids: [m.id], enabled: on })} />,
      },
      {
        id: 'name',
        title: 'Name',
        header: 'Name',
        width: 'minmax(220px,1fr)',
        sortValue: (m) => m.name.toLowerCase(),
        cell: (m) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <BlockIcon hue={m.hue} label={m.name} size={24} />
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 truncate">
                <span className="truncate">{m.name}</span>
                {m.problem && (
                  <span title={PROBLEM_LABEL[m.problem]} className="flex text-orange">
                    <AlertTriangle aria-label={PROBLEM_LABEL[m.problem]} className="size-3" />
                  </span>
                )}
              </span>
              <span className="truncate text-small text-label-2">{m.version}</span>
            </div>
          </div>
        ),
      },
      { id: 'source', title: 'Source', header: 'Source', width: '96px', hideable: true, sortValue: (m) => m.source, cell: (m) => <SourceBadge source={m.source} /> },
      {
        id: 'update',
        title: 'Update',
        header: 'Update',
        width: '92px',
        hideable: true,
        sortValue: (m) => (m.update ? 0 : 1),
        cell: (m) =>
          m.update ? (
            <span className="flex items-center gap-1 text-small text-accent" title={`Update to ${m.update.version}`}>
              <ArrowUpCircle className="size-3.5" /> {m.update.version}
            </span>
          ) : null,
      },
      { id: 'side', title: 'Side', header: 'Side', width: '64px', hideable: true, sortValue: (m) => m.side, cell: (m) => <span className="text-label-2">{sideLabel[m.side]}</span> },
      { id: 'size', title: 'Size', header: 'Size', width: '76px', align: 'end', hideable: true, sortValue: (m) => m.sizeBytes, cell: (m) => <span className="text-label-2">{formatBytes(m.sizeBytes)}</span> },
      { id: 'added', title: 'Date Added', header: 'Date Added', width: '104px', align: 'end', hideable: true, sortValue: (m) => m.addedAt, cell: (m) => <span className="text-label-2">{formatDate(m.addedAt)}</span> },
    ],
    [setModsEnabled],
  )
  const { sorted, sort, setSort } = useSorted(filtered, columns)

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const rows = keys.map((k) => byId.get(k)).filter((m): m is ModFile => !!m)
    const one = rows.length === 1 ? rows[0] : undefined
    const allEnabled = rows.every((m) => m.enabled)
    const updatable = rows.filter((m) => m.update)
    return [
      { label: allEnabled ? (one ? 'Disable' : `Disable ${rows.length} Mods`) : one ? 'Enable' : `Enable ${rows.length} Mods`, onSelect: () => setEnabled.mutate({ ids: keys, enabled: !allEnabled }) },
      { label: updatable.length > 1 ? `Update ${updatable.length} Mods` : 'Update', disabled: !updatable.length, onSelect: () => notYetAvailable('Updating mods') },
      { kind: 'separator' },
      { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
      ...(one && one.source !== 'local'
        ? [{ label: one.source === 'modrinth' ? 'Open on Modrinth' : 'Open on CurseForge', onSelect: () => notYetAvailable('Opening the project page') } as MenuEntry]
        : []),
      { label: one ? 'Copy Name' : 'Copy Names', onSelect: () => copyText(rows.map((m) => m.name).join('\n'), 'Copied') },
      { kind: 'separator' },
      { label: 'Move to Trash…', shortcut: 'mod+backspace', destructive: true, onSelect: () => setPendingTrash(keys) },
    ]
  }

  const problems = useMemo(() => {
    const p = { duplicate: [] as ModFile[], 'missing-dependency': [] as ModFile[], incompatible: [] as ModFile[] }
    for (const m of all) if (m.problem) p[m.problem].push(m)
    return p
  }, [all])
  const problemSummary = [
    problems.duplicate.length && `${problems.duplicate.length} duplicate${problems.duplicate.length > 1 ? 's' : ''}`,
    problems['missing-dependency'].length && `${problems['missing-dependency'].length} missing dependenc${problems['missing-dependency'].length > 1 ? 'ies' : 'y'}`,
    problems.incompatible.length && `${problems.incompatible.length} incompatible`,
  ].filter(Boolean)

  if (inst?.loader.kind === 'vanilla') {
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

  const filterCount = (filters.show !== 'all' ? 1 : 0) + (filters.hasUpdate ? 1 : 0) + (filters.problems ? 1 : 0) + (filters.sources.size < ALL_SOURCES.length ? 1 : 0)
  const selected = only ? byId.get(only) : undefined
  const updateCount = all.filter((m) => m.update).length

  return (
    <>
      <SubToolbar
        trailing={
          <>
            <Button onClick={() => notYetAvailable('Checking for mod updates')}>
              Check for Updates{updateCount ? ` (${updateCount})` : ''}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => navigate({ to: '/discover', search: { type: 'mod', target: id } })}>
              Add Mods
            </Button>
            <Menu
              align="end"
              items={[
                { label: 'Add from Files…', onSelect: () => notYetAvailable('Add from Files') },
                { label: 'Paste URL…', onSelect: () => notYetAvailable('Paste URL') },
                { label: 'Add from Another Instance…', onSelect: () => notYetAvailable('Add from another instance') },
              ]}
              trigger={
                <IconButton label="More ways to add" variant="push" size="sm" className="!size-6">
                  <Plus />
                </IconButton>
              }
            />
          </>
        }
      >
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Search mods" className="w-[220px]" />
        <FilterPopover filters={filters} onChange={setFilters} count={filterCount} />
        {mods.data && (
          <span className="text-small text-label-2 tabular">
            {filtered.length === all.length ? `${all.length} mods` : `${filtered.length} of ${all.length}`}
            {selection.size > 1 && ` · ${selection.size} selected`}
          </span>
        )}
      </SubToolbar>

      {problemSummary.length > 0 && (
        <div className="shrink-0 px-3 pt-2.5">
          <Banner
            tone="warning"
            title={problemSummary.join(' · ')}
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
          selection.size > 1 ? (
            <MultiInspector count={selection.size} onToggle={() => toggle([...selection])} onTrash={() => setPendingTrash([...selection])} />
          ) : selected ? (
            <ModInspector mod={selected} onEnabled={(on) => setEnabled.mutate({ ids: [selected.id], enabled: on })} onTrash={() => setPendingTrash([selected.id])} />
          ) : (
            <p className="m-auto px-6 text-center text-body text-label-3">Select a mod to see its details</p>
          )
        }
      >
        {mods.isPending ? (
          <SkeletonRows rows={12} className="pt-2" />
        ) : mods.isError ? (
          <QueryError error={mods.error} onRetry={() => mods.refetch()} what="mods" />
        ) : all.length === 0 ? (
          <EmptyState
            icon={<Blocks />}
            title="No mods yet"
            description="Browse Modrinth and CurseForge for mods that work with this instance, or drop .jar files here."
            actions={
              <>
                <Button onClick={() => notYetAvailable('Add from Files')}>Add from Files…</Button>
                <Button variant="primary" onClick={() => navigate({ to: '/discover', search: { type: 'mod', target: id } })}>
                  Browse Mods
                </Button>
              </>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={query ? `No mods match “${query}”` : 'No mods match these filters'}
            actions={
              <Button
                onClick={() => {
                  setQuery('')
                  setFilters({ show: 'all', hasUpdate: false, problems: false, sources: new Set(ALL_SOURCES) })
                }}
              >
                Clear Filters
              </Button>
            }
          />
        ) : (
          <VirtualTable
            aria-label="Mods"
            rows={sorted}
            columns={columns}
            getKey={(m) => m.id}
            rowHeight={40}
            selection={selection}
            onSelectionChange={setSelection}
            onToggle={toggle}
            onDelete={setPendingTrash}
            rowMenu={rowMenu}
            sort={sort}
            onSortChange={setSort}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            rowClassName={(m) => (m.enabled ? undefined : 'opacity-55')}
            className="flex-1"
          />
        )}
      </SplitView>

      <Alert
        open={!!pendingTrash}
        onOpenChange={(o) => !o && setPendingTrash(null)}
        icon={<Trash2 className="size-8 text-red" />}
        title={pendingTrash?.length === 1 ? `Move “${byId.get(pendingTrash[0]!)?.name}” to the Trash?` : `Move ${pendingTrash?.length} mods to the Trash?`}
        message="You can undo this, or restore the files from the Trash in Finder."
        confirmLabel="Move to Trash"
        destructive
        onConfirm={() => {
          if (pendingTrash) trash.mutate(pendingTrash)
          setSelection(new Set())
          setPendingTrash(null)
        }}
      />
      <ProblemsSheet
        open={problemsOpen}
        onOpenChange={setProblemsOpen}
        problems={problems}
        onDisable={(ids) => setEnabled.mutate({ ids, enabled: false })}
        onTrash={(ids) => trash.mutate(ids)}
      />
    </>
  )
}

function FilterPopover({ filters, onChange, count }: { filters: Filters; onChange: (f: Filters) => void; count: number }) {
  return (
    <Popover
      label="Filter mods"
      align="start"
      width={260}
      trigger={
        <Button variant={count ? 'push' : 'borderless'} icon={<ListFilter />} className={cn(count > 0 && 'text-accent')} aria-label={count ? `Filters, ${count} active` : 'Filters'}>
          Filter{count ? ` (${count})` : ''}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-semibold text-label-2">Show</span>
          <Segmented
            aria-label="Show"
            value={filters.show}
            onValueChange={(show) => onChange({ ...filters, show })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Checkbox checked={filters.hasUpdate} onCheckedChange={(hasUpdate) => onChange({ ...filters, hasUpdate })} label="Has update" />
          <Checkbox
            checked={filters.problems}
            onCheckedChange={(problems) => onChange({ ...filters, problems })}
            label="Has problems"
            description="Missing dependency, incompatible or duplicate"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-semibold text-label-2">Source</span>
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
          <Button variant="link" className="self-start" onClick={() => onChange({ show: 'all', hasUpdate: false, problems: false, sources: new Set(ALL_SOURCES) })}>
            Reset Filters
          </Button>
        )}
      </div>
    </Popover>
  )
}

function ModInspector({ mod, onEnabled, onTrash }: { mod: ModFile; onEnabled: (on: boolean) => void; onTrash: () => void }) {
  return (
    <>
      <InspectorHeader icon={<BlockIcon hue={mod.hue} label={mod.name} size={44} />} title={mod.name} subtitle={`by ${mod.author}`} />
      <div className="flex items-center justify-between px-4 pb-3">
        <label htmlFor="mod-enabled" className="text-body">
          Enabled
        </label>
        <Switch id="mod-enabled" checked={mod.enabled} onCheckedChange={onEnabled} />
      </div>
      <InspectorSection>
        <p className="text-callout text-label">{mod.description}</p>
        {mod.problem && (
          <p className="mt-2 flex items-center gap-1.5 text-callout text-orange">
            <AlertTriangle className="size-3.5" /> {PROBLEM_LABEL[mod.problem]}
          </p>
        )}
      </InspectorSection>
      <InspectorSection title="Version">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body">{mod.version}</span>
          {mod.update ? (
            <Button size="sm" variant="primary" onClick={() => notYetAvailable('Updating mods')}>
              Update to {mod.update.version}
            </Button>
          ) : (
            <Button size="sm" onClick={() => notYetAvailable('Changing the mod version')} disabled={mod.source === 'local'}>
              Change Version…
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <SourceBadge source={mod.source} />
          <span className="text-small text-label-2">{sideLabel[mod.side]} side</span>
        </div>
      </InspectorSection>
      <InspectorSection title="Dependencies">
        {mod.dependencies.length === 0 ? (
          <p className="text-callout text-label-3">None</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {mod.dependencies.map((d) => (
              <li key={d.id} className="flex h-6 items-center gap-1.5 text-callout">
                {d.satisfied ? <Check className="size-3.5 text-green" aria-label="Installed" /> : <AlertTriangle className="size-3.5 text-orange" aria-label="Missing" />}
                <span className="flex-1 truncate">{d.name}</span>
                {!d.satisfied && (
                  <Button size="sm" onClick={() => notYetAvailable('Installing dependencies')}>
                    Install
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      {mod.dependents.length > 0 && (
        <InspectorSection title="Required by">
          <p className="text-callout">{mod.dependents.join(', ')}</p>
        </InspectorSection>
      )}
      <InspectorSection title="File">
        <PropertyList
          rows={[
            { label: 'Name', value: <span className="selectable font-mono text-small">{mod.fileName}</span> },
            { label: 'Size', value: formatBytes(mod.sizeBytes) },
            { label: 'Added', value: formatDate(mod.addedAt) },
            {
              label: 'SHA-1',
              value: (
                <span className="inline-flex items-center gap-1">
                  <span className="selectable font-mono text-small">{mod.sha1.slice(0, 12)}…</span>
                  <CopyButton text={mod.sha1} label="Copy SHA-1" />
                </span>
              ),
            },
          ]}
        />
        <Button size="sm" variant="borderless" className="mt-2 -ml-2" onClick={() => notYetAvailable('Show in Finder')}>
          Reveal in Finder
        </Button>
      </InspectorSection>
      <InspectorSection>
        <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
          Move to Trash…
        </Button>
      </InspectorSection>
    </>
  )
}

function MultiInspector({ count, onToggle, onTrash }: { count: number; onToggle: () => void; onTrash: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Blocks className="size-10 text-label-3" />
      <p className="text-title3 font-semibold">{count} mods selected</p>
      <div className="flex gap-2">
        <Button onClick={onToggle}>Enable/Disable</Button>
        <Button variant="destructive" onClick={onTrash}>
          Move to Trash…
        </Button>
      </div>
      <p className="text-small text-label-2">Press Space to toggle, ⌘⌫ to move to the Trash.</p>
    </div>
  )
}

/** One sheet for every kind of problem (replaces three separate dialogs, ui.md C12). */
function ProblemsSheet({
  open,
  onOpenChange,
  problems,
  onDisable,
  onTrash,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  problems: Record<'duplicate' | 'missing-dependency' | 'incompatible', ModFile[]>
  onDisable: (ids: string[]) => void
  onTrash: (ids: string[]) => void
}) {
  const [keep, setKeep] = useState<string | undefined>(undefined)
  const dups = problems.duplicate
  const keepId = keep ?? dups[0]?.id
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Problems"
      description="Review each problem. Nothing changes until you choose an action."
      width={560}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {dups.length > 0 && (
          <section aria-label="Duplicates">
            <h3 className="mb-1 text-body font-semibold">Duplicates</h3>
            <p className="mb-2 text-small text-label-2">Choose the file to keep. The others are moved to the Trash.</p>
            <RadioList
              aria-label="File to keep"
              value={keepId ?? ''}
              onValueChange={setKeep}
              options={dups.map((m) => ({ value: m.id, label: m.fileName, description: `${m.version} · ${formatBytes(m.sizeBytes)}` }))}
            />
            <Button className="mt-2.5" onClick={() => onTrash(dups.filter((m) => m.id !== keepId).map((m) => m.id))}>
              Keep Selected, Trash Others
            </Button>
          </section>
        )}
        {problems['missing-dependency'].length > 0 && (
          <section aria-label="Missing dependencies">
            <h3 className="mb-2 text-body font-semibold">Missing dependencies</h3>
            <ul className="flex flex-col gap-1.5">
              {problems['missing-dependency'].map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-body">
                  <span className="flex-1">
                    {m.name} needs <strong className="font-semibold">{m.dependencies.filter((d) => !d.satisfied).map((d) => d.name).join(', ')}</strong>
                  </span>
                  <Button size="md" variant="primary" onClick={() => notYetAvailable('Installing dependencies')}>
                    Install
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {problems.incompatible.length > 0 && (
          <section aria-label="Incompatible">
            <h3 className="mb-2 text-body font-semibold">Incompatible</h3>
            <ul className="flex flex-col gap-1.5">
              {problems.incompatible.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-body">
                  <span className="flex-1">
                    {m.name} <Badge tone="warning">Not for this version</Badge>
                  </span>
                  <Button size="md" onClick={() => onDisable([m.id])}>
                    Disable
                  </Button>
                  <Button size="md" onClick={() => onTrash([m.id])}>
                    Move to Trash
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!dups.length && !problems['missing-dependency'].length && !problems.incompatible.length && <p className="text-body text-label-2">No problems found.</p>}
      </div>
    </Sheet>
  )
}
