import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Compass, FileArchive, FolderOpen, Link2, SlidersHorizontal } from 'lucide-react'
import { Badge, Button, Checkbox, Combobox, Segmented, Select, Sheet, Stepper, Switch, TextField, cn, toast, type ComboboxOption } from '@/ui'
import { useInstances, loaderName } from '@/data/instances'
import { useGameVersions, useJavaRuntimes, useLoaderVersions } from '@/data/misc'
import type { LoaderKind } from '@/data/types'
import { notYetAvailable } from '@/app/commands'
import { router } from '@/app/router'
import { useUi } from '@/app/ui-store'
import { BlockIcon, formatDate } from '@/app/visuals'

type SourceId = 'custom' | 'file' | 'url' | 'folder' | 'browse'

const SOURCES: { id: SourceId; label: string; icon: ReactNode }[] = [
  { id: 'custom', label: 'Custom', icon: <SlidersHorizontal /> },
  { id: 'file', label: 'Modpack File…', icon: <FileArchive /> },
  { id: 'url', label: 'From URL', icon: <Link2 /> },
  { id: 'folder', label: 'Existing Folder…', icon: <FolderOpen /> },
  { id: 'browse', label: 'Browse Modpacks', icon: <Compass /> },
]

const LOADERS: Exclude<LoaderKind, 'vanilla'>[] = ['fabric', 'quilt', 'forge', 'neoforge']

const close = () => useUi.getState().set({ newInstance: false })

/** New Instance sheet (B4.5). Mounted only while `useUi().newInstance` is true. */
export default function NewInstanceSheet() {
  const [source, setSource] = useState<SourceId>('custom')
  // The Custom form's state lives here so the sheet footer can show Create with the right state.
  const custom = useCustomForm()

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && close()}
      title="New Instance"
      width={760}
      bodyClassName="!p-0 flex min-h-[420px]"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          {source === 'custom' && (
            <Button variant="primary" disabled={!custom.valid} onClick={custom.create}>
              Create
            </Button>
          )}
        </>
      }
    >
      <nav aria-label="Source" className="w-[184px] shrink-0 border-r border-separator p-2">
        <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-px">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={source === s.id}
              onClick={() => {
                if (s.id === 'browse') {
                  close()
                  router.navigate({ to: '/discover', search: { type: 'modpack' } })
                } else setSource(s.id)
              }}
              className={cn(
                'flex h-7 items-center gap-2 rounded-md px-2 text-left text-body outline-none [&_svg]:size-4 [&_svg]:text-accent',
                source === s.id ? 'bg-selection font-medium' : 'hover:bg-fill',
                'focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)]',
              )}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </div>
      </nav>
      <div role="tabpanel" className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {source === 'custom' && custom.element}
        {source === 'file' && (
          <PickSource
            title="Import a modpack file"
            description="Choose a Modrinth .mrpack or a CurseForge .zip. You’ll review the version, loader and files before anything is installed."
            button="Choose File…"
            onPick={() => notYetAvailable('Import Modpack')}
          />
        )}
        {source === 'folder' && (
          <PickSource
            title="Add an existing folder"
            description="Import a .minecraft folder, a Prism or MultiMC instance, a Modrinth App profile or a CurseForge instance. Amethyst detects the type and shows what it found. Copy is the default; Link in place keeps the files where they are."
            button="Choose Folder…"
            onPick={() => notYetAvailable('Add Existing Folder')}
          />
        )}
        {source === 'url' && <UrlForm />}
      </div>
    </Sheet>
  )
}

function PickSource({ title, description, button, onPick }: { title: string; description: string; button: string; onPick: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <h3 className="text-title3 font-semibold">{title}</h3>
      <p className="max-w-[400px] text-body text-label-2">{description}</p>
      <Button size="lg" variant="primary" onClick={onPick}>
        {button}
      </Button>
      <p className="text-small text-label-3">You can also drop a file or folder onto the Amethyst window.</p>
    </div>
  )
}

const URL_RE = /^https:\/\/(www\.)?(modrinth\.com\/(modpack|project)\/[\w.-]+|curseforge\.com\/minecraft\/modpacks\/[\w.-]+)/i

function UrlForm() {
  const [url, setUrl] = useState('')
  const error = url && !URL_RE.test(url.trim()) ? 'Paste a Modrinth or CurseForge modpack link, like https://modrinth.com/modpack/fabulously-optimized.' : undefined
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (url && !error) notYetAvailable('Import from URL')
      }}
    >
      <h3 className="text-title3 font-semibold">Import from a link</h3>
      <TextField label="Modpack URL" placeholder="https://modrinth.com/modpack/…" value={url} onChange={(e) => setUrl(e.target.value)} error={error} autoFocus />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!url || !!error}>
          Continue
        </Button>
      </div>
    </form>
  )
}

function useCustomForm(): { valid: boolean; create: () => void; element: ReactNode } {
  const { data: instances = [] } = useInstances()
  const { data: versions = [], isPending: versionsPending } = useGameVersions()
  const { data: javas = [] } = useJavaRuntimes()
  const [name, setName] = useState('')
  const [snapshots, setSnapshots] = useState(false)
  const [chosenMc, setChosenMc] = useState<string>()
  const [loader, setLoader] = useState<LoaderKind>('vanilla')
  const [chosenLoaderVersion, setChosenLoaderVersion] = useState<string>()
  const [advanced, setAdvanced] = useState(false)
  const [javaId, setJavaId] = useState('auto')
  const [memAuto, setMemAuto] = useState(true)
  const [memMax, setMemMax] = useState(4096)

  const generatedName = useMemo(() => {
    const taken = new Set(instances.map((i) => i.name.toLowerCase()))
    if (!taken.has('new instance')) return 'New Instance'
    let n = 2
    while (taken.has(`new instance ${n}`)) n++
    return `New Instance ${n}`
  }, [instances])
  const effectiveName = name.trim() || generatedName
  const nameError = /[/:]/.test(effectiveName)
    ? 'Names can’t contain “/” or “:”.'
    : instances.some((i) => i.name.toLowerCase() === effectiveName.toLowerCase())
      ? 'An instance with this name already exists.'
      : undefined

  const latestRelease = versions.find((v) => v.type === 'release')?.id
  const minecraft = chosenMc ?? latestRelease
  // The chosen version always stays in the list, even when the snapshot filter would hide it.
  const mcOptions: ComboboxOption[] = versions
    .filter((v) => v.type === 'release' || (snapshots && v.type === 'snapshot') || v.id === minecraft)
    .map((v) => ({
      value: v.id,
      label: v.id,
      detail: v.type === 'release' ? formatDate(v.releasedAt) : v.type === 'snapshot' ? 'Snapshot' : 'Old',
    }))

  // One query per loader so unavailable loaders can be disabled with an explanation.
  const fabric = useLoaderVersions('fabric', minecraft)
  const quilt = useLoaderVersions('quilt', minecraft)
  const forge = useLoaderVersions('forge', minecraft)
  const neoforge = useLoaderVersions('neoforge', minecraft)
  const loaderQueries = { fabric, quilt, forge, neoforge }
  const unavailable = LOADERS.filter((l) => loaderQueries[l].isSuccess && loaderQueries[l].data.length === 0)

  const loaderVersions = loader === 'vanilla' ? [] : (loaderQueries[loader].data ?? [])
  const loaderVersion =
    loader === 'vanilla'
      ? undefined
      : (loaderVersions.find((v) => v.version === chosenLoaderVersion) ?? loaderVersions.find((v) => v.recommended) ?? loaderVersions[0])?.version
  const loaderError = loader !== 'vanilla' && unavailable.includes(loader) ? `${loaderName(loader)} isn’t available for Minecraft ${minecraft}.` : undefined

  const valid = !nameError && !!minecraft && !loaderError && (loader === 'vanilla' || !!loaderVersion)
  const create = () => {
    if (!valid) return
    // TODO(wire): api.instances.create({ name, minecraft, loader, loaderVersion, javaId?, memory? }) → InstanceSummary;
    // then select it and open its detail view while installation continues in Activity.
    toast({ kind: 'info', title: `Creating “${effectiveName}”`, message: 'Installation progress is shown in Activity.' })
    close()
  }
  const element = (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        create()
      }}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label="Change icon"
          title="Change Icon…"
          onClick={() => notYetAvailable('Change Icon')}
          className="rounded-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)]"
        >
          <BlockIcon hue={(effectiveName.length * 37) % 360} label={effectiveName} size={48} />
        </button>
        <TextField label="Name" placeholder={generatedName} value={name} onChange={(e) => setName(e.target.value)} error={nameError} className="flex-1" autoFocus />
      </div>

      <section aria-labelledby="ni-version" className="flex flex-col gap-3">
        <h3 id="ni-version" className="text-body font-semibold">
          Version
        </h3>
        <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-right text-body text-label-2">Minecraft</span>
          <div className="flex items-center gap-3">
            <Combobox
              aria-label="Minecraft version"
              value={minecraft}
              onValueChange={setChosenMc}
              options={mcOptions}
              placeholder={versionsPending ? 'Loading versions…' : 'Choose a version'}
              className="w-[220px]"
            />
            <Checkbox checked={snapshots} onCheckedChange={setSnapshots} label="Show snapshots" />
          </div>

          <span className="text-right text-body text-label-2">Mod loader</span>
          <Segmented<LoaderKind>
            aria-label="Mod loader"
            className="justify-self-start"
            value={loader}
            onValueChange={(l) => {
              setLoader(l)
              setChosenLoaderVersion(undefined)
            }}
            options={[
              { value: 'vanilla', label: 'None' },
              ...LOADERS.map((l) => ({ value: l, label: loaderName(l), disabled: unavailable.includes(l) && loader !== l })),
            ]}
          />
          {(unavailable.length > 0 || loaderError) && (
            <>
              <span />
              <p className={cn('-mt-1.5 text-small', loaderError ? 'text-red' : 'text-label-2')}>
                {loaderError ?? `${listNames(unavailable.map(loaderName))} ${unavailable.length === 1 ? 'isn’t' : 'aren’t'} available for ${minecraft}.`}
              </p>
            </>
          )}

          {loader !== 'vanilla' && !loaderError && (
            <>
              <span className="text-right text-body text-label-2">{loaderName(loader)} version</span>
              <Select
                aria-label={`${loaderName(loader)} version`}
                className="w-[220px] justify-self-start"
                value={loaderVersion ?? ''}
                onValueChange={setChosenLoaderVersion}
                options={loaderVersions.map((v) => ({
                  value: v.version,
                  text: v.version,
                  label: (
                    <span className="flex items-center gap-1.5">
                      {v.version}
                      {v.recommended && <Badge tone="success">Recommended</Badge>}
                      {v.latest && <Badge tone="info">Latest</Badge>}
                    </span>
                  ),
                }))}
              />
            </>
          )}
        </div>
      </section>

      <section>
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
          className="-ml-1 flex items-center gap-1 rounded px-1 text-body font-semibold"
        >
          <ChevronRight className={cn('size-3 text-label-2 transition-transform duration-150', advanced && 'rotate-90')} strokeWidth={2.5} />
          Advanced
        </button>
        {advanced && (
          <div className="mt-3 grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-3">
            <span className="text-right text-body text-label-2">Java</span>
            <Select
              aria-label="Java runtime"
              className="w-[280px] justify-self-start"
              value={javaId}
              onValueChange={setJavaId}
              options={[
                { value: 'auto', label: 'Automatic (recommended)' },
                ...javas.map((j, i) => ({ value: j.id, label: `Java ${j.version} · ${j.vendor} · ${j.arch}`, separatorBefore: i === 0 })),
              ]}
            />
            <span className="text-right text-body text-label-2">Memory</span>
            <div className="flex items-center gap-3">
              <Switch checked={memAuto} onCheckedChange={setMemAuto} aria-label="Automatic memory" />
              <span className="text-body">{memAuto ? 'Automatic' : 'Maximum'}</span>
              {!memAuto && <Stepper aria-label="Maximum memory" unit="MB" value={memMax} min={1024} max={65536} step={256} onValueChange={setMemMax} />}
            </div>
          </div>
        )}
      </section>
      <button type="submit" hidden />
    </form>
  )
  return { valid, create, element }
}

function listNames(names: string[]) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
