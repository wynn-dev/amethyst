import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Compass, FileArchive, FolderOpen, Link2, SlidersHorizontal } from 'lucide-react'
import type { ImportCandidate, InstanceOverrides, InstanceRuntime, LoaderKind as RuntimeLoader } from '@shared/services'
import { Badge, Banner, Button, Checkbox, Combobox, Segmented, Select, Sheet, Spinner, Stepper, Switch, TextField, cn, type ComboboxOption } from '@/ui'
import { api } from '@/lib/rpc'
import { errorText, toastError } from '@/lib/error-messages'
import { createInstance, loaderName, useInstances } from '@/data/instances'
import { useJavaRuntimes } from '@/data/java'
import { useGameVersions, useLoaderVersions } from '@/data/versions'
import { queryClient } from '@/data/query'
import { toast } from '@/ui/toast-store'
import type { LoaderKind } from '@/data/types'
import { notYetAvailable, openInstance } from '@/app/commands'
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

const close = () => useUi.getState().set({ newInstance: false, newInstanceSource: 'custom' })

/** New Instance sheet (B4.5). Mounted only while `useUi().newInstance` is true. */
export default function NewInstanceSheet() {
  const [source, setSource] = useState<SourceId>(() => useUi.getState().newInstanceSource)
  // The Custom form's state lives here so the sheet footer can show Create with the right state.
  const custom = useCustomForm()
  const folder = useFolderImport()

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
            <Button variant="primary" disabled={!custom.valid || custom.busy} onClick={custom.create} data-testid="create-instance">
              {custom.busy ? 'Creating…' : 'Create'}
            </Button>
          )}
          {source === 'folder' && folder.candidate && (
            <Button variant="primary" disabled={!folder.valid || folder.busy} onClick={folder.submit}>
              {folder.busy ? 'Importing…' : 'Import'}
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
                  void router.navigate({ to: '/discover', search: { type: 'modpack' } })
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
            // TODO(wire): modpack import belongs to the modpack area.
            onPick={() => notYetAvailable('Import Modpack')}
          />
        )}
        {source === 'folder' && folder.element}
        {source === 'url' && <UrlForm />}
      </div>
    </Sheet>
  )
}

function PickSource({ title, description, button, onPick, busy }: { title: string; description: string; button: string; onPick: () => void; busy?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <h3 className="text-title3 font-semibold">{title}</h3>
      <p className="max-w-[400px] text-body text-label-2">{description}</p>
      <Button size="lg" variant="primary" onClick={onPick} disabled={busy}>
        {busy ? 'Reading…' : button}
      </Button>
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
        // TODO(wire): modpack import from a URL belongs to the modpack area.
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

/** The instance name the runtime generates when the field is left empty (`1.21.1-fabric0.16.5`), made unique. */
function generatedName(mc: string | undefined, loader: LoaderKind, version: string | undefined, taken: Set<string>): string {
  const base = !mc ? 'New Instance' : loader === 'vanilla' || !version ? mc : `${mc}-${loader}${version}`
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`
  return name
}

function useCustomForm(): { valid: boolean; busy: boolean; create: () => void; element: ReactNode } {
  const { data: instances = [] } = useInstances()
  const [snapshots, setSnapshots] = useState(false)
  const versions = useGameVersions(snapshots)
  const { data: javas = [] } = useJavaRuntimes()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string>()
  const [chosenMc, setChosenMc] = useState<string>()
  const [loader, setLoader] = useState<LoaderKind>('vanilla')
  const [chosenLoaderVersion, setChosenLoaderVersion] = useState<string>()
  const [advanced, setAdvanced] = useState(false)
  const [javaPath, setJavaPath] = useState('auto')
  const [memAuto, setMemAuto] = useState(true)
  const [memMax, setMemMax] = useState(4096)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => versions.data ?? [], [versions.data])
  const latestRelease = list.find((v) => v.type === 'release')?.id
  const minecraft = chosenMc ?? latestRelease
  // The chosen version always stays in the list, even when the snapshot filter would hide it.
  const mcOptions: ComboboxOption[] = useMemo(() => {
    const opts = list.map((v) => ({
      value: v.id,
      label: v.id,
      detail: v.type === 'release' ? (v.installed ? 'Installed' : formatDate(v.releasedAt)) : v.type === 'snapshot' ? 'Snapshot' : 'Old',
    }))
    return minecraft && !opts.some((o) => o.value === minecraft) ? [{ value: minecraft, label: minecraft, detail: '' }, ...opts] : opts
  }, [list, minecraft])

  // One query per loader so unavailable loaders can be disabled with an explanation.
  const fabric = useLoaderVersions('fabric', minecraft)
  const quilt = useLoaderVersions('quilt', minecraft)
  const forge = useLoaderVersions('forge', minecraft)
  const neoforge = useLoaderVersions('neoforge', minecraft)
  const loaderQueries = { fabric, quilt, forge, neoforge }
  const unavailable = LOADERS.filter((l) => loaderQueries[l].isSuccess && loaderQueries[l].data.length === 0)

  const loaderVersions = loader === 'vanilla' ? [] : (loaderQueries[loader].data ?? [])
  const loaderVersion =
    loader === 'vanilla' ? undefined : (loaderVersions.find((v) => v.version === chosenLoaderVersion) ?? loaderVersions.find((v) => v.recommended) ?? loaderVersions[0])?.version
  const loaderError = loader !== 'vanilla' && unavailable.includes(loader) ? `${loaderName(loader)} isn’t available for Minecraft ${minecraft}.` : undefined

  const taken = useMemo(() => new Set(instances.map((i) => i.name.toLowerCase())), [instances])
  const placeholder = generatedName(minecraft, loader, loaderVersion, taken)
  const effectiveName = name.trim() || placeholder
  const nameError = /[/:]/.test(effectiveName)
    ? 'Names can’t contain “/” or “:”.'
    : name.trim() && taken.has(name.trim().toLowerCase())
      ? 'An instance with this name already exists.'
      : name.trim().length > 64
        ? 'Use at most 64 characters.'
        : undefined

  const valid = !nameError && !!minecraft && !loaderError && (loader === 'vanilla' || !!loaderVersion)
  const create = async () => {
    if (!valid || !minecraft || busy) return
    const runtime: Partial<InstanceRuntime> & { minecraft: string } = { minecraft }
    if (loader !== 'vanilla' && loaderVersion) runtime[loader as RuntimeLoader] = loaderVersion
    const overrides: InstanceOverrides = {}
    if (javaPath !== 'auto') overrides.javaPath = javaPath
    if (!memAuto) overrides.memory = { mode: 'manual', minMB: 0, maxMB: memMax }
    setBusy(true)
    const created = await createInstance({
      runtime,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(icon ? { icon: { path: icon } } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
    })
    setBusy(false)
    if (!created) return
    // The sheet closes, the instance opens and installs while Activity shows the progress.
    close()
    openInstance(created.id, 'overview')
  }

  const pickIcon = async () => {
    const [p] = await api.dialog.open({ title: 'Choose an icon', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] }).catch((e: unknown) => {
      toastError(e, 'Couldn’t open the file picker')
      return []
    })
    if (p) setIcon(p)
  }

  const element = (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label="Change icon"
          title={icon ? icon : 'Choose an Icon…'}
          onClick={() => void pickIcon()}
          className="relative rounded-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)]"
        >
          <BlockIcon hue={(effectiveName.length * 37) % 360} label={effectiveName} size={48} />
          {icon && <span className="absolute -right-1 -bottom-1 rounded-full bg-accent px-1 text-caption font-semibold text-on-accent">✓</span>}
        </button>
        <TextField label="Name" placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} error={nameError} className="flex-1" autoFocus />
      </div>

      <section aria-labelledby="ni-version" className="flex flex-col gap-3">
        <h3 id="ni-version" className="text-body font-semibold">
          Version
        </h3>
        {versions.isError && <Banner tone="error" title="Couldn’t load the version list">{errorText(versions.error)}</Banner>}
        <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-right text-body text-label-2">Minecraft</span>
          <div className="flex items-center gap-3">
            <Combobox
              aria-label="Minecraft version"
              value={minecraft}
              onValueChange={setChosenMc}
              options={mcOptions}
              placeholder={versions.isPending ? 'Loading versions…' : 'Choose a version'}
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
              {loaderQueries[loader].isPending ? (
                <span className="flex items-center gap-2 text-small text-label-2">
                  <Spinner size={12} /> Loading versions…
                </span>
              ) : loaderQueries[loader].isError ? (
                <p className="text-small text-red">{errorText(loaderQueries[loader].error)}</p>
              ) : (
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
              )}
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
              value={javaPath}
              onValueChange={setJavaPath}
              options={[
                { value: 'auto', label: 'Automatic (recommended)' },
                ...javas.filter((j) => j.valid).map((j, i) => ({ value: j.path, label: `Java ${j.version} · ${j.vendor} · ${j.arch}`, separatorBefore: i === 0 })),
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
  return { valid, busy, create: () => void create(), element }
}

const CHECK_TEXT: Record<Exclude<ImportCandidate['check'], 'ok'>, string> = {
  missing: 'The folder no longer exists.',
  'not-a-directory': 'That isn’t a folder.',
  'no-permission': 'macOS doesn’t let Amethyst read this folder. Allow access in System Settings → Privacy & Security → Files and Folders, or move it.',
  'already-registered': 'This folder is already an instance in Amethyst.',
  'inside-managed-root': 'This folder is inside Amethyst’s own data folder.',
  'is-volume-root': 'Choose the game folder itself, not a whole disk or your home folder.',
  'inside-app-bundle': 'Folders inside an app can’t be imported.',
  bad: 'Its Amethyst settings file is damaged.',
}

/** "Existing Folder…": inspect, review and import a game folder (copy by default, or in place). */
function useFolderImport(): { candidate: ImportCandidate | undefined; valid: boolean; busy: boolean; submit: () => void; element: ReactNode } {
  const [candidate, setCandidate] = useState<ImportCandidate>()
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'copy' | 'in-place'>('copy')
  const [name, setName] = useState('')
  const [mc, setMc] = useState<string>()
  const versions = useGameVersions(true)

  const pick = async () => {
    const [path] = await api.dialog.open({ title: 'Choose a game folder to import', directory: true })
    if (!path) return
    setReading(true)
    try {
      const c = await api.instances.inspectFolder(path)
      setCandidate(c)
      setName(c.name)
      setMc(c.runtime?.minecraft)
    } catch (e) {
      toastError(e, 'Couldn’t read that folder')
    } finally {
      setReading(false)
    }
  }

  const needsRuntime = candidate?.kind !== 'amethyst'
  const valid = !!candidate && candidate.check === 'ok' && !!name.trim() && (!needsRuntime || !!mc)
  const submit = async () => {
    if (!candidate || !valid) return
    setBusy(true)
    try {
      const runtime = needsRuntime && mc ? { ...candidate.runtime, minecraft: mc } : undefined
      const d = await api.instances.import({ path: candidate.path, mode, name: name.trim(), ...(runtime ? { runtime } : {}) })
      void queryClient.invalidateQueries({ queryKey: ['instances'], exact: true })
      toast({ kind: 'success', title: `Imported “${d.name}”` })
      close()
      openInstance(d.id, 'overview')
    } catch (e) {
      toastError(e, 'Couldn’t import the folder')
    } finally {
      setBusy(false)
    }
  }

  const options = (versions.data ?? []).map((v) => ({ value: v.id, label: v.id, detail: v.type === 'release' ? undefined : v.type }))
  const element = !candidate ? (
    <PickSource
      title="Add an existing folder"
      description="Import a .minecraft folder or another launcher’s instance folder. Amethyst detects the version and shows what it found. Copy is the default; Link in place keeps the files where they are."
      button="Choose Folder…"
      busy={reading}
      onPick={() => void pick()}
    />
  ) : (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-title3 font-semibold">Review</h3>
          <p className="selectable truncate font-mono text-small text-label-2" title={candidate.path}>
            {candidate.path}
          </p>
        </div>
        <Button onClick={() => void pick()}>Choose Another…</Button>
      </div>
      {candidate.check !== 'ok' && <Banner tone="error" title="This folder can’t be imported">{CHECK_TEXT[candidate.check]}</Banner>}
      <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-3">
        <span className="text-right text-body text-label-2">Found</span>
        <span className="text-body">
          {candidate.kind === 'amethyst' ? 'An Amethyst instance' : candidate.kind === 'game-dir' ? 'A Minecraft game folder' : 'Nothing recognisable (an empty instance will be set up)'} · {candidate.modCount} mods ·{' '}
          {candidate.worldCount} worlds
        </span>
        <span className="text-right text-body text-label-2">Name</span>
        <TextField aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} error={!name.trim() ? 'Enter a name.' : undefined} />
        {needsRuntime && (
          <>
            <span className="text-right text-body text-label-2">Minecraft</span>
            <div className="flex items-center gap-2">
              <Combobox aria-label="Minecraft version" value={mc} onValueChange={setMc} options={options} placeholder="Choose a version" className="w-[200px]" />
              {candidate.runtime?.minecraft ? <span className="text-small text-label-2">Detected from the folder. Check it’s right.</span> : <span className="text-small text-orange">Couldn’t detect it; choose one.</span>}
            </div>
          </>
        )}
        <span className="text-right text-body text-label-2">Files</span>
        <Segmented<'copy' | 'in-place'>
          aria-label="Import mode"
          className="justify-self-start"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'copy', label: 'Copy into Amethyst' },
            { value: 'in-place', label: 'Link in place' },
          ]}
        />
        <span />
        <p className="-mt-1.5 text-small text-label-2">
          {mode === 'copy' ? 'A clone is made in Amethyst’s instances folder (no extra disk space with APFS). The original stays untouched.' : 'Amethyst uses the folder where it is. Moving or unmounting it makes the instance unavailable.'}
        </p>
      </div>
    </div>
  )
  return { candidate, valid, busy, submit: () => void submit(), element }
}

function listNames(names: string[]) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
