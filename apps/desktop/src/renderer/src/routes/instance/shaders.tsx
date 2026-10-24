import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Plus, Sun } from 'lucide-react'
import { Button, EmptyState, Sheet, SkeletonRows, VirtualTable, cn, type Column, type MenuEntry } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable, openInstance } from '@/app/commands'
import { BlockIcon, formatBytes } from '@/app/visuals'
import { useInstances, loaderName } from '@/data/instances'
import { useMods, useSetActiveShader, useShaders } from '@/data/content'
import type { LoaderKind, ShaderPack } from '@/data/types'
import { SourceBadge, SubToolbar, copyText, useInstanceId, useSelection } from './parts'

const NONE = '__none__'
type Row = ShaderPack | { id: typeof NONE }
const isNone = (r: Row): r is { id: typeof NONE } => r.id === NONE

/** Shader loaders by mod loader (OptiFine is not supported: DECISIONS.md). */
const SHADER_LOADERS: { name: string; loaders: LoaderKind[]; match: RegExp }[] = [
  { name: 'Iris', loaders: ['fabric', 'quilt', 'neoforge'], match: /^iris/i },
  { name: 'Oculus', loaders: ['forge', 'neoforge'], match: /^oculus/i },
]

/** Shaders tab: at most one active pack; "None" first (B4.3). */
export default function ShadersTab() {
  const id = useInstanceId()
  const navigate = useNavigate()
  const { data: instances } = useInstances()
  const inst = instances?.find((i) => i.id === id)
  const shaders = useShaders(id)
  const mods = useMods(id)
  const setActive = useSetActiveShader(id)
  const [gate, setGate] = useState<ShaderPack | null>(null)
  const { selection, setSelection } = useSelection()

  const loader = inst?.loader.kind ?? 'vanilla'
  const compatible = useMemo(() => SHADER_LOADERS.filter((s) => s.loaders.includes(loader)), [loader])
  const hasShaderMod = useMemo(
    () => (mods.data ?? []).some((m) => m.enabled && compatible.some((s) => s.match.test(m.name))),
    [mods.data, compatible],
  )

  const all = useMemo(() => shaders.data ?? [], [shaders.data])
  const rows = useMemo<Row[]>(() => [{ id: NONE }, ...all], [all])
  const activeId = all.find((s) => s.active)?.id ?? NONE

  const activate = (r: Row) => {
    if (isNone(r)) return setActive.mutate(null)
    if (!hasShaderMod) return setGate(r)
    setActive.mutate(r.id)
  }

  const columns: Column<Row>[] = [
    {
      id: 'active',
      title: 'Active',
      header: 'Active',
      width: '56px',
      align: 'center',
      cell: (r) => {
        const on = r.id === activeId
        const name = isNone(r) ? 'None' : r.name
        return (
          <button
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Use ${name}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => activate(r)}
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
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <BlockIcon hue={r.hue} label={r.name} size={24} />
            <span className="truncate">{r.name}</span>
          </div>
        ),
    },
    { id: 'source', title: 'Source', header: 'Source', width: '96px', cell: (r) => (isNone(r) ? null : <SourceBadge source={r.source} />) },
    { id: 'size', title: 'Size', header: 'Size', width: '80px', align: 'end', cell: (r) => (isNone(r) ? null : <span className="text-label-2">{formatBytes(r.sizeBytes)}</span>) },
  ]

  const rowMenu = (keys: string[]): MenuEntry[] => {
    const r = rows.find((x) => x.id === keys[0])
    if (!r || isNone(r)) return [{ label: 'Turn Off Shaders', disabled: activeId === NONE, onSelect: () => setActive.mutate(null) }]
    return [
      { label: r.id === activeId ? 'Turn Off' : 'Activate', onSelect: () => (r.id === activeId ? setActive.mutate(null) : activate(r)) },
      { kind: 'separator' },
      { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
      { label: 'Copy Name', onSelect: () => copyText(r.name) },
      { kind: 'separator' },
      { label: 'Move to Trash…', destructive: true, onSelect: () => notYetAvailable('Moving shader packs to the Trash') },
    ]
  }

  const addButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => navigate({ to: '/discover', search: { type: 'shader', target: id } })}>
      Add Shaders
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
        <span className="text-small text-label-2">
          {hasShaderMod ? `Shaders load through ${compatible.find((s) => (mods.data ?? []).some((m) => s.match.test(m.name)))?.name}.` : 'No shader loader installed.'}
        </span>
      </SubToolbar>
      {shaders.isPending ? (
        <SkeletonRows rows={5} className="pt-2" />
      ) : shaders.isError ? (
        <QueryError error={shaders.error} onRetry={() => shaders.refetch()} what="shader packs" />
      ) : all.length === 0 ? (
        <EmptyState icon={<Sun />} title="No shader packs yet" description="Shader packs add lighting, shadows and reflections. They need Iris or Oculus." actions={addButton} />
      ) : (
        <VirtualTable
          aria-label="Shader packs"
          rows={rows}
          columns={columns}
          getKey={(r) => r.id}
          rowHeight={36}
          selection={selection}
          onSelectionChange={(s) => setSelection(new Set([...s].slice(-1)))}
          onActivate={activate}
          onToggle={(keys) => {
            const r = rows.find((x) => x.id === keys[0])
            if (r) activate(r)
          }}
          rowMenu={rowMenu}
          className="flex-1"
        />
      )}

      <Sheet
        open={!!gate}
        onOpenChange={(o) => !o && setGate(null)}
        title="Shaders need a shader loader"
        description={
          compatible.length
            ? `“${gate?.name}” needs Iris (Fabric, Quilt, NeoForge) or Oculus (Forge, NeoForge). These work with ${loaderName(loader)}:`
            : 'Shader loaders need Fabric, Quilt, Forge or NeoForge. Add a mod loader to this instance first.'
        }
        width={460}
        footer={
          <>
            <Button onClick={() => setGate(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (gate) setActive.mutate(gate.id)
                setGate(null)
              }}
            >
              Activate Anyway
            </Button>
          </>
        }
      >
        {compatible.length ? (
          <ul className="flex flex-col divide-y divide-separator rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
            {compatible.map((s) => (
              <li key={s.name} className="flex items-center gap-3 px-3 py-2.5">
                <BlockIcon hue={s.name === 'Iris' ? 270 : 190} label={s.name} size={28} />
                <div className="flex-1">
                  <p className="text-body font-medium">{s.name}</p>
                  <p className="text-small text-label-2">For {s.loaders.map(loaderName).join(', ')}</p>
                </div>
                <Button variant="primary" onClick={() => notYetAvailable(`Installing ${s.name}`)}>
                  Install
                </Button>
              </li>
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
    </>
  )
}
