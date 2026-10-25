import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Plus, Sun, Trash2 } from 'lucide-react'
import type { LoaderKind, ResourceRow } from '@shared/services'
import { Button, EmptyState, IconButton, Menu, SearchField, Sheet, SkeletonRows, VirtualTable, cn, type Column, type MenuEntry } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { openInstance } from '@/app/commands'
import { findTargetRef } from '@/app/ui-store'
import { BlockIcon, formatBytes } from '@/app/visuals'
import { addResourceFiles, setResourcesEnabled, trashResources, usePagedResources, useResourceAll, useResourceDetail, useWatchInstance } from '@/data/content'
import { loaderLabel, useInstanceInfo } from '@/data/instance-info'
import { installProject, useInstallState } from '@/data/market'
import { openModpackImport } from '@/data/modpacks'
import { isModpackPath, pickFiles, revealInFinder } from '@/lib/files'
import { api } from '@/lib/rpc'
import { asError, reportError } from '@/lib/error-text'
import {
  AddFromInstanceSheet,
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
import { InspectorHeader, InspectorSection, SplitView, SubToolbar, copyText, useInstanceId, useSelection } from './parts'

const NONE = '__none__'
type Row = ContentRow | { id: typeof NONE }
const isNone = (r: Row): r is { id: typeof NONE } => r.id === NONE

/** Shader mods by loader (OptiFine is not supported: DECISIONS.md), as Modrinth projects. */
const SHADER_LOADERS: { name: string; slug: string; loaders: LoaderKind[]; match: RegExp; hue: number }[] = [
  { name: 'Iris', slug: 'iris', loaders: ['fabric', 'quilt', 'neoforge'], match: /^iris/i, hue: 270 },
  { name: 'Oculus', slug: 'oculus', loaders: ['forge', 'neoforge'], match: /^oculus/i, hue: 190 },
]

/** Shaders tab: at most one active pack; "None" first (B4.3). */
export default function ShadersTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  useWatchInstance(id)
  const info = useInstanceInfo(id)
  const inst = info.data ?? undefined
  const loader = inst?.loader?.kind ?? null
  const [query, setQuery] = useState('')
  const list = usePagedResources(id, 'shaderpacks', query.trim() ? { search: query.trim() } : {})
  const active = useResourceAll(id, 'shaderpacks', { enabled: true })
  const mods = useResourceAll(id, 'mods', { enabled: true }, loader !== null)
  const [gate, setGate] = useState<ResourceRow | null>(null)
  const [pendingTrash, setPendingTrash] = useState<string[] | null>(null)
  const [fromInstance, setFromInstance] = useState(false)
  const { selection, setSelection, only } = useSelection()
  const { request } = list

  const compatible = useMemo(() => SHADER_LOADERS.filter((s) => loader && s.loaders.includes(loader)), [loader])
  const shaderMod = useMemo(() => SHADER_LOADERS.find((s) => (mods.data ?? []).some((m) => s.match.test(m.name) || s.match.test(m.fileName))), [mods.data])
  const rows = useMemo<Row[]>(() => [{ id: NONE }, ...list.rows.map((r, index): ContentRow => r ?? { placeholder: true, id: `\u0000p${index}`, index })], [list.rows])
  const byId = useMemo(() => new Map(list.rows.flatMap((r) => (r ? [[r.id, r] as const] : []))), [list.rows])
  const activeRow = active.data?.[0]
  const activeId = activeRow?.id ?? NONE

  const activate = async (r: Row) => {
    if (isPlaceholder(r as ContentRow)) return
    try {
      if (isNone(r)) {
        if (activeRow) await setResourcesEnabled(id, 'shaderpacks', [activeRow.id], false)
        return
      }
      await setResourcesEnabled(id, 'shaderpacks', [r.id], true)
    } catch (e) {
      if (asError(e).code === 'ENO_SHADER_LOADER') setGate(r as ResourceRow)
      else reportError('Couldn’t change the shader pack', e)
    }
  }

  const drop = useFileDrop((paths) => {
    const packs = paths.filter(isModpackPath)
    if (packs[0]) openModpackImport({ path: packs[0] })
    const rest = paths.filter((p) => !isModpackPath(p))
    if (rest.length) void addResourceFiles(id, 'shaderpacks', rest)
  })
  const addFiles = async () => {
    const paths = await pickFiles('shaderpacks', { title: 'Add Shader Packs' })
    if (paths.length) await addResourceFiles(id, 'shaderpacks', paths)
  }

  const columns: Column<Row>[] = [
    {
      id: 'active',
      title: 'Active',
      header: 'Active',
      width: '56px',
      align: 'center',
      cell: (r) => {
        if (!isNone(r) && isPlaceholder(r)) return null
        const on = r.id === activeId
        const name = isNone(r) ? 'None' : r.name
        return (
          <button
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Use ${name}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void activate(r)}
            className={cn('flex size-[14px] items-center justify-center rounded-full shadow-control', on ? 'bg-accent shadow-none' : 'bg-field')}
          >
            {on && <span className="size-[5px] rounded-full bg-white" />}
          </button>
        )
      },
    },
    {
      id: 'name',
      title: 'Name',
      header: 'Name',
      width: 'minmax(220px,1fr)',
      cell: (r) =>
        isNone(r) ? (
          <span className="pl-[34px] text-label-2">None (vanilla graphics)</span>
        ) : isPlaceholder(r) ? (
          <PlaceholderCell index={r.index} request={request} />
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <ResourceIcon row={r} />
            <span className="truncate">{r.name}</span>
          </div>
        ),
    },
    { id: 'source', title: 'Source', header: 'Source', width: '96px', cell: (r) => (isNone(r) || isPlaceholder(r) ? null : <RowSource row={r} />) },
    { id: 'size', title: 'Size', header: 'Size', width: '80px', align: 'end', cell: (r) => (isNone(r) || isPlaceholder(r) ? null : <span className="text-label-2">{r.isDirectory ? 'Folder' : formatBytes(r.size)}</span>) },
  ]

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const r = byId.get(keys[0] ?? '')
    if (!r) return [{ label: 'Turn Off Shaders', disabled: activeId === NONE, onSelect: () => void activate({ id: NONE }) }]
    return [
      { label: r.id === activeId ? 'Turn Off' : 'Activate', onSelect: () => void activate(r.id === activeId ? { id: NONE } : r) },
      { kind: 'separator' },
      { label: 'Show in Finder', onSelect: () => void api.resources.get(id, 'shaderpacks', r.id).then((d) => revealInFinder(d.path), (e: unknown) => reportError('Couldn’t show the file', e)) },
      { label: 'Copy Name', onSelect: () => copyText(r.name) },
      { kind: 'separator' },
      { label: 'Move to Trash…', destructive: true, onSelect: () => setPendingTrash(realIds(keys)) },
    ]
  }

  const browse = () => navigate({ to: '/discover', search: { type: 'shader', target: id } })
  const addButton = (
    <Button variant="primary" icon={<Plus />} onClick={browse}>
      Add Shaders
    </Button>
  )
  const selected = only ? byId.get(only) : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.props}>
      <SubToolbar
        trailing={
          <>
            {addButton}
            <Menu
              align="end"
              items={[
                { label: 'Add from Files…', onSelect: () => void addFiles() },
                { label: 'Add from Another Instance…', onSelect: () => setFromInstance(true) },
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
        <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder="Search shader packs" className="w-[200px]" />
        <span className="text-small text-label-2">
          {loader === null ? 'Shaders need a mod loader and Iris or Oculus.' : shaderMod ? `Shaders load through ${shaderMod.name}.` : 'No shader loader installed.'}
        </span>
        <ScanningNote scanning={list.scanning} />
      </SubToolbar>
      <SplitView
        inspectorLabel="Shader pack details"
        inspector={
          selected ? (
            <ShaderInspector key={selected.id} instanceId={id} pack={selected} active={selected.id === activeId} onActivate={() => void activate(selected.id === activeId ? { id: NONE } : selected)} onTrash={() => setPendingTrash([selected.id])} />
          ) : (
            <p className="m-auto px-6 text-center text-body text-label-3">Select a shader pack to see its details</p>
          )
        }
      >
        {list.isPending ? (
          <SkeletonRows rows={5} className="pt-2" />
        ) : list.isError ? (
          <QueryError error={list.error} onRetry={list.refetch} what="shader packs" />
        ) : list.total === 0 && !query.trim() ? (
          <EmptyState
            icon={<Sun />}
            title="No shader packs yet"
            description="Shader packs add lighting, shadows and reflections. They need Iris or Oculus. Drop .zip files here or browse for packs."
            actions={
              <>
                <Button onClick={() => void addFiles()}>Add from Files…</Button>
                {addButton}
              </>
            }
          />
        ) : (
          <VirtualTable
            aria-label="Shader packs"
            rows={rows}
            columns={columns}
            getKey={(r) => r.id}
            rowHeight={36}
            selection={selection}
            onSelectionChange={(s) => setSelection(new Set([...s].slice(-1)))}
            onActivate={(r) => void activate(r)}
            onToggle={(keys) => {
              const r = rows.find((x) => x.id === keys[0])
              if (r) void activate(r)
            }}
            onDelete={(keys) => setPendingTrash(realIds(keys).filter((k) => k !== NONE))}
            rowMenu={rowMenu}
            className="flex-1"
          />
        )}
      </SplitView>
      <DropOverlay active={drop.active} label="Add to Shader Packs" hint="Drop .zip files or shader folders." />
      <TrashConfirm
        kind="shaderpacks"
        pending={pendingTrash}
        label={pendingTrash?.length === 1 ? byId.get(pendingTrash[0] ?? '')?.name : undefined}
        onCancel={() => setPendingTrash(null)}
        onConfirm={(ids) => {
          const label = ids.length === 1 ? byId.get(ids[0] ?? '')?.name : undefined
          setSelection(new Set())
          setPendingTrash(null)
          void trashResources(id, 'shaderpacks', ids, label)
        }}
      />
      <AddFromInstanceSheet open={fromInstance} onOpenChange={setFromInstance} instanceId={id} kind="shaderpacks" />
      <Sheet
        open={!!gate}
        onOpenChange={(o) => !o && setGate(null)}
        title="Shaders need a shader loader"
        description={
          compatible.length
            ? `“${gate?.name}” needs Iris (Fabric, Quilt, NeoForge) or Oculus (Forge, NeoForge). These work with ${loaderLabel(loader)}:`
            : 'Shader loaders need Fabric, Quilt, Forge or NeoForge. Add a mod loader to this instance first.'
        }
        width={460}
        footer={<Button onClick={() => setGate(null)}>Cancel</Button>}
      >
        {compatible.length && inst ? (
          <ul className="flex flex-col divide-y divide-separator rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
            {compatible.map((s) => (
              <ShaderLoaderRow
                key={s.name}
                loader={s}
                target={{ id, name: inst.name, minecraft: inst.minecraft, loader: inst.loader }}
                onInstalled={async () => {
                  const pack = gate
                  setGate(null)
                  if (pack) await activate(pack)
                }}
              />
            ))}
          </ul>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              setGate(null)
              openInstance(id, 'settings')
            }}
          >
            Change Version…
          </Button>
        )}
      </Sheet>
    </div>
  )
}

function ShaderLoaderRow({ loader, target, onInstalled }: { loader: (typeof SHADER_LOADERS)[number]; target: Parameters<typeof installProject>[1]; onInstalled: () => void }) {
  const state = useInstallState(target.id, `modrinth:${loader.slug}`)
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <BlockIcon hue={loader.hue} label={loader.name} size={28} />
      <div className="flex-1">
        <p className="text-body font-medium">{loader.name}</p>
        <p className="text-small text-label-2">From Modrinth · for {loader.loaders.map(loaderLabel).join(', ')}</p>
      </div>
      <Button
        variant="primary"
        disabled={state?.state === 'installing'}
        onClick={async () => {
          if (await installProject({ platform: 'modrinth', id: loader.slug, title: loader.name, projectType: 'mod' }, target)) onInstalled()
        }}
      >
        {state?.state === 'installing' ? 'Installing…' : 'Install'}
      </Button>
    </li>
  )
}

function ShaderInspector({ instanceId, pack, active, onActivate, onTrash }: { instanceId: string; pack: ResourceRow; active: boolean; onActivate: () => void; onTrash: () => void }) {
  const detail = useResourceDetail(instanceId, 'shaderpacks', pack.id)
  return (
    <>
      <InspectorHeader icon={<ResourceIcon row={pack} size={44} />} title={pack.name} subtitle={active ? 'Active' : 'Not active'} />
      <div className="px-4 pb-3">
        <Button variant={active ? 'push' : 'primary'} onClick={onActivate}>
          {active ? 'Turn Off' : 'Activate'}
        </Button>
      </div>
      {(detail.data?.warnings.length || pack.problem) && (
        <InspectorSection>
          <ProblemNote row={pack} />
          {detail.data?.warnings.map((w) => (
            <p key={w} className="text-callout text-orange">
              {w}
            </p>
          ))}
        </InspectorSection>
      )}
      <FileSection row={pack} detail={detail.data} />
      <InspectorSection>
        <Button variant="borderless" className="-ml-2 text-red" icon={<Trash2 />} onClick={onTrash}>
          Move to Trash…
        </Button>
      </InspectorSection>
    </>
  )
}
