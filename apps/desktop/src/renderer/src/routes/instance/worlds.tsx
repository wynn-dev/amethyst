import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Archive, Copy, Globe2, Play, Plus, Trash2, Upload } from 'lucide-react'
import { Alert, Button, EmptyState, Select, SkeletonRows, Switch, TextField, VirtualTable, toast, type Column, type MenuEntry } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable } from '@/app/commands'
import { BlockIcon, formatBytes, formatDate, formatRelative } from '@/app/visuals'
import { instanceActions, useInstances } from '@/data/instances'
import { contentKeys, useWorlds } from '@/data/content'
import { queryClient } from '@/data/query'
import type { InstanceSummary, World } from '@/data/types'
import { CopyButton, InspectorHeader, InspectorSection, PropertyList, SplitView, SubToolbar, copyText, useInstanceId, useSelection, useSorted } from './parts'

const MODES: Record<World['gameMode'], string> = { survival: 'Survival', creative: 'Creative', adventure: 'Adventure', spectator: 'Spectator', hardcore: 'Hardcore' }
const DIFFICULTY: Record<World['difficulty'], string> = { peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard' }

function patchWorld(instanceId: string, worldId: string, patch: Partial<World>) {
  // TODO(wire): api.saves.update(instanceId, worldId, patch: Partial<Pick<World, 'name' | 'difficulty' | 'cheats' | 'gameMode'>>)
  queryClient.setQueryData<World[]>(contentKeys.worlds(instanceId), (l) => l?.map((w) => (w.id === worldId ? { ...w, ...patch } : w)))
}

function backUp(w: World) {
  // TODO(wire): api.saves.backup(instanceId, worldId) → { path }
  toast({ kind: 'success', title: `Backed up “${w.name}”`, message: 'Saved to the backups folder.', actions: [{ label: 'Show in Finder', onClick: () => notYetAvailable('Show in Finder') }] })
}

/** Worlds tab: saves table with properties, datapacks, backup and export in the inspector (B4.4). */
export default function WorldsTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  const { data: instances } = useInstances()
  const inst = instances?.find((i) => i.id === id)
  const worlds = useWorlds(id)
  const [pendingTrash, setPendingTrash] = useState<World | null>(null)
  const { selection, setSelection, only } = useSelection()
  const all = useMemo(() => worlds.data ?? [], [worlds.data])

  const columns = useMemo<Column<World>[]>(
    () => [
      {
        id: 'name',
        title: 'Name',
        header: 'Name',
        width: 'minmax(200px,1fr)',
        sortValue: (w) => w.name.toLowerCase(),
        cell: (w) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <BlockIcon hue={w.hue} label={w.name} size={24} />
            <span className="truncate">{w.name}</span>
          </div>
        ),
      },
      { id: 'mode', title: 'Game Mode', header: 'Game Mode', width: '104px', sortValue: (w) => w.gameMode, cell: (w) => <span className="text-label-2">{MODES[w.gameMode]}</span> },
      { id: 'played', title: 'Last Played', header: 'Last Played', width: '120px', sortValue: (w) => w.lastPlayedAt, cell: (w) => <span className="text-label-2">{formatRelative(w.lastPlayedAt)}</span> },
      { id: 'version', title: 'Version', header: 'Version', width: '80px', sortValue: (w) => w.version, cell: (w) => <span className="text-label-2">{w.version}</span> },
      { id: 'size', title: 'Size', header: 'Size', width: '80px', align: 'end', sortValue: (w) => w.sizeBytes, cell: (w) => <span className="text-label-2">{formatBytes(w.sizeBytes)}</span> },
    ],
    [],
  )
  const { sorted, sort, setSort } = useSorted(all, columns, { column: 'played', direction: 'desc' })
  const selected = only ? all.find((w) => w.id === only) : undefined

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const w = all.find((x) => x.id === keys[0])
    if (!w) return []
    return [
      { label: 'Play this World', disabled: inst?.state.kind !== 'idle', onSelect: () => inst && instanceActions.launch(inst) },
      { kind: 'separator' },
      { label: 'Back Up', onSelect: () => backUp(w) },
      { label: 'Export…', onSelect: () => notYetAvailable('Export world') },
      { label: 'Duplicate…', onSelect: () => notYetAvailable('Duplicate world') },
      { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
      { label: 'Copy Seed', onSelect: () => copyText(w.seed, 'Copied seed') },
      { kind: 'separator' },
      { label: 'Move to Trash…', destructive: true, onSelect: () => setPendingTrash(w) },
    ]
  }

  return (
    <>
      <SubToolbar
        trailing={
          <>
            <Button onClick={() => notYetAvailable('Import world')}>Import World…</Button>
            <Button variant="primary" icon={<Plus />} onClick={() => navigate({ to: '/discover', search: { type: 'datapack', target: id } })}>
              Add Data Packs
            </Button>
          </>
        }
      >
        {worlds.data && <span className="text-small text-label-2 tabular">{all.length === 1 ? '1 world' : `${all.length} worlds`}</span>}
      </SubToolbar>
      <SplitView
        inspectorLabel="World details"
        inspector={
          selected && inst ? (
            <WorldInspector key={selected.id} world={selected} inst={inst} onBackUp={() => backUp(selected)} onTrash={() => setPendingTrash(selected)} />
          ) : (
            <p className="m-auto px-6 text-center text-body text-label-3">Select a world to see its details</p>
          )
        }
      >
        {worlds.isPending ? (
          <SkeletonRows rows={6} className="pt-2" />
        ) : worlds.isError ? (
          <QueryError error={worlds.error} onRetry={() => worlds.refetch()} what="worlds" />
        ) : all.length === 0 ? (
          <EmptyState
            icon={<Globe2 />}
            title="No worlds yet"
            description="Worlds you create in game appear here. You can also drop a world folder or .zip onto this tab."
            actions={<Button onClick={() => notYetAvailable('Import world')}>Import World…</Button>}
          />
        ) : (
          <VirtualTable
            aria-label="Worlds"
            rows={sorted}
            columns={columns}
            getKey={(w) => w.id}
            rowHeight={36}
            selection={selection}
            onSelectionChange={setSelection}
            onDelete={(keys) => setPendingTrash(all.find((w) => w.id === keys[0]) ?? null)}
            rowMenu={rowMenu}
            sort={sort}
            onSortChange={setSort}
            className="flex-1"
          />
        )}
      </SplitView>
      <Alert
        open={!!pendingTrash}
        onOpenChange={(o) => !o && setPendingTrash(null)}
        icon={<Trash2 className="size-8 text-red" />}
        title={`Move “${pendingTrash?.name}” to the Trash?`}
        message="You can restore the world from the Trash in Finder. Consider backing it up first."
        confirmLabel="Move to Trash"
        destructive
        onConfirm={() => {
          // TODO(wire): api.saves.trash(instanceId, worldId)
          const w = pendingTrash
          if (w) {
            const before = queryClient.getQueryData<World[]>(contentKeys.worlds(id))
            queryClient.setQueryData<World[]>(contentKeys.worlds(id), (l) => l?.filter((x) => x.id !== w.id))
            toast({ kind: 'success', title: `Moved “${w.name}” to the Trash`, actions: [{ label: 'Undo', onClick: () => queryClient.setQueryData(contentKeys.worlds(id), before) }] })
          }
          setSelection(new Set())
          setPendingTrash(null)
        }}
      />
    </>
  )
}

function WorldInspector({ world, inst, onBackUp, onTrash }: { world: World; inst: InstanceSummary; onBackUp: () => void; onTrash: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(world)
  const running = inst.state.kind === 'running' || inst.state.kind === 'launching'

  return (
    <>
      <InspectorHeader icon={<BlockIcon hue={world.hue} label={world.name} size={44} />} title={world.name} subtitle={`${MODES[world.gameMode]} · ${world.version}`} />
      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <Button variant="primary" icon={<Play className="fill-current" />} disabled={inst.state.kind !== 'idle'} onClick={() => instanceActions.launch(inst)}>
          Play this World
        </Button>
        <Button icon={<Archive />} onClick={onBackUp}>
          Back Up
        </Button>
      </div>
      <InspectorSection title="Properties">
        {editing ? (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              patchWorld(inst.id, world.id, { name: draft.name.trim() || world.name, difficulty: draft.difficulty, cheats: draft.cheats, gameMode: draft.gameMode })
              setEditing(false)
            }}
          >
            <TextField label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
            <div className="flex items-center justify-between">
              <span className="text-body">Game mode</span>
              <Select
                aria-label="Game mode"
                value={draft.gameMode}
                onValueChange={(gameMode) => setDraft({ ...draft, gameMode })}
                options={(Object.keys(MODES) as World['gameMode'][]).map((m) => ({ value: m, label: MODES[m] }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-body">Difficulty</span>
              <Select
                aria-label="Difficulty"
                value={draft.difficulty}
                onValueChange={(difficulty) => setDraft({ ...draft, difficulty })}
                options={(Object.keys(DIFFICULTY) as World['difficulty'][]).map((d) => ({ value: d, label: DIFFICULTY[d] }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <label htmlFor="world-cheats" className="text-body">
                Allow cheats
              </label>
              <Switch id="world-cheats" checked={draft.cheats} onCheckedChange={(cheats) => setDraft({ ...draft, cheats })} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={() => {
                  setDraft(world)
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        ) : (
          <>
            <PropertyList
              rows={[
                { label: 'Name', value: world.name },
                {
                  label: 'Seed',
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <span className="selectable font-mono text-small">{world.seed}</span>
                      <CopyButton text={world.seed} label="Copy seed" />
                    </span>
                  ),
                },
                { label: 'Game mode', value: MODES[world.gameMode] },
                { label: 'Difficulty', value: DIFFICULTY[world.difficulty] },
                { label: 'Cheats', value: world.cheats ? 'On' : 'Off' },
                { label: 'Last played', value: formatDate(world.lastPlayedAt) },
                { label: 'Size', value: formatBytes(world.sizeBytes) },
              ]}
            />
            <Button
              size="sm"
              className="mt-2.5"
              disabled={running}
              onClick={() => {
                setDraft(world)
                setEditing(true)
              }}
            >
              Edit…
            </Button>
            {running && <p className="mt-1.5 text-small text-label-2">Quit the game to edit world properties.</p>}
          </>
        )}
      </InspectorSection>
      <InspectorSection title="Data Packs">
        {world.datapacks.length === 0 ? (
          <p className="text-callout text-label-3">No data packs. Drop a data pack onto this world to add it.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {world.datapacks.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-callout">
                <span className="flex-1 truncate">{d.name}</span>
                <Switch
                  size="sm"
                  checked={d.enabled}
                  aria-label={`Enable ${d.name}`}
                  onCheckedChange={(on) => patchWorld(inst.id, world.id, { datapacks: world.datapacks.map((x) => (x.id === d.id ? { ...x, enabled: on } : x)) })}
                />
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="borderless" className="mt-1.5 -ml-2" icon={<Plus />} onClick={() => notYetAvailable('Add data pack')}>
          Add Data Pack…
        </Button>
      </InspectorSection>
      <InspectorSection>
        <div className="flex flex-col items-start">
          <Button variant="borderless" className="-ml-2" icon={<Upload />} onClick={() => notYetAvailable('Export world')}>
            Export…
          </Button>
          <Button variant="borderless" className="-ml-2" icon={<Copy />} onClick={() => notYetAvailable('Duplicate world')}>
            Duplicate…
          </Button>
          <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
            Move to Trash…
          </Button>
        </div>
      </InspectorSection>
    </>
  )
}
