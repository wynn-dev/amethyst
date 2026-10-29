import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Compass, FileArchive, FolderOpen, Link2, SlidersHorizontal } from 'lucide-react'
import type { ImportCandidate, InstanceOverrides, InstanceRuntime, LoaderKind as RuntimeLoader } from '@shared/services'
import { Banner, Button, Checkbox, Combobox, Segmented, Select, Sheet, Spinner, Stepper, Switch, TextField, cn, indicatorClass, recentTrigger, useSlidingIndicator, type ComboboxOption } from '@/ui'
import { api } from '@/lib/rpc'
import { errorMessage, toastError } from '@/lib/error-messages'
import { createInstance, loaderName, useInstances } from '@/data/instances'
import { useJavaRuntimes } from '@/data/java'
import { useGameVersions, useLoaderVersions } from '@/data/versions'
import { queryClient } from '@/data/query'
import { toast } from '@/ui/toast-store'
import type { LoaderKind } from '@/data/types'
import { openInstance } from '@/app/commands'
import { openModpackImport } from '@/data/modpacks'
import { pickFiles } from '@/lib/files'
import { router } from '@/app/router'
import { useUi } from '@/app/ui-store'
import { BlockIcon, formatDate } from '@/app/visuals'
import { Card, DisclosureCard, InfoRow, Note, Row, VersionLabel } from './parts'

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
      width={680}
      origin={recentTrigger}
      bodyClassName="!p-0 flex min-h-[392px]"
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
      <SourceTabs source={source} onSelect={setSource} />
      <div role="tabpanel" className="min-w-0 flex-1 overflow-y-auto p-4">
        {source === 'custom' && custom.element}
        {source === 'file' && (
          <PickSource
            icon={<FileArchive strokeWidth={1.5} />}
            title="Import a modpack file"
            description="Choose a Modrinth .mrpack or a CurseForge .zip. You’ll review the version, loader and files before anything is installed."
            button="Choose File…"
            onPick={async () => {
              const [path] = await pickFiles('modpack', { title: 'Import Modpack' })
              if (!path) return
              close()
              openModpackImport({ path })
            }}
          />
        )}
        {source === 'folder' && folder.element}
        {source === 'url' && <UrlForm />}
      </div>
    </Sheet>
  )
}

/** The source list, with a selection pill that slides between sources. Mounted inside the sheet's portal, so its refs exist when it lays out. */
function SourceTabs({ source, onSelect }: { source: SourceId; onSelect: (id: SourceId) => void }) {
  const tabs = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(tabs, '[aria-selected="true"]', source)
  return (
    <nav aria-label="Source" className="w-[164px] shrink-0 border-r border-separator p-1.5">
      <div
        ref={tabs}
        role="tablist"
        aria-orientation="vertical"
        className="relative flex flex-col gap-px"
        onKeyDown={(e) => {
          // Roving focus: ↑/↓ move between sources (Browse Modpacks navigates, so it only takes focus).
          const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
          if (!delta) return
          e.preventDefault()
          const buttons = [...(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + delta + buttons.length) % buttons.length]
          next?.focus()
          const id = next?.dataset.source as SourceId | undefined
          if (id && id !== 'browse') onSelect(id)
        }}
      >
        <span ref={indicator} aria-hidden className={indicatorClass} />
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            data-source={s.id}
            aria-selected={source === s.id}
            tabIndex={source === s.id ? 0 : -1}
            onClick={() => {
              if (s.id === 'browse') {
                close()
                void router.navigate({ to: '/discover', search: { type: 'modpack' } })
              } else onSelect(s.id)
            }}
            className={cn(
              'relative flex h-[26px] items-center gap-2 rounded-md px-2 text-left text-compact outline-none transition-colors duration-150 [&_svg]:size-[15px] [&_svg]:shrink-0',
              source === s.id ? 'text-label [&_svg]:text-label' : 'text-label-2 hover:bg-hover hover:text-label [&_svg]:text-label-3',
              'focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]',
            )}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </div>
    </nav>
  )
}

function PickSource({ icon, title, description, button, onPick, busy }: { icon: ReactNode; title: string; description: string; button: string; onPick: () => void; busy?: boolean }) {
  return (
    <div className="flex h-full animate-enter flex-col items-center justify-center gap-2 px-6 pb-4 text-center">
      <span aria-hidden className="mb-1 text-label-3 [&_svg]:size-[22px]">
        {icon}
      </span>
      <h3 className="text-headline font-semibold">{title}</h3>
      <p className="max-w-[360px] text-compact text-label-2">{description}</p>
      <Button variant="primary" className="mt-2" onClick={onPick} disabled={busy}>
        {busy ? 'Reading…' : button}
      </Button>
    </div>
  )
}

const URL_RE = /^https:\/\/(www\.)?(modrinth\.com\/(modpack|project)\/[\w.-]+|curseforge\.com\/minecraft\/modpacks\/[\w.-]+)/i
/** A direct link to a pack file (imported through the preview). */
const FILE_RE = /^https:\/\/\S+\.(mrpack|zip)(\?\S*)?$/i
const MODRINTH_RE = /^https:\/\/(?:www\.)?modrinth\.com\/(?:modpack|project)\/([\w.-]+)/i

function UrlForm() {
  const [url, setUrl] = useState('')
  const value = url.trim()
  const error = !value
    ? undefined
    : !URL_RE.test(value) && !FILE_RE.test(value)
      ? 'Paste a Modrinth modpack link (like https://modrinth.com/modpack/fabulously-optimized) or a link to a .mrpack or .zip file.'
      : /curseforge\.com\/minecraft\/modpacks\//i.test(value)
        ? 'CurseForge project links can’t be opened directly yet. Search for the modpack in Discover, or paste a direct file link.'
        : undefined
  return (
    <form
      className="flex animate-enter flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value || error) return
        close()
        const slug = MODRINTH_RE.exec(value)?.[1]
        // A project page opens in Discover (Install creates the instance); a file link is previewed.
        if (slug && !FILE_RE.test(value)) void router.navigate({ to: '/discover/$projectId', params: { projectId: `modrinth:${slug}` } })
        else openModpackImport({ url: value })
      }}
    >
      <Card title="Import from a link">
        <Row label="Modpack URL" htmlFor="ni-url" hintId="ni-url-msg" hint={error && <span className="text-red">{error}</span>}>
          <TextField
            id="ni-url"
            monospace
            placeholder="https://modrinth.com/modpack/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'ni-url-msg' : undefined}
            className="flex-1"
            autoFocus
          />
        </Row>
      </Card>
      <Note>A Modrinth project opens in Discover, where Install creates the instance. A link to a .mrpack or .zip file is previewed first.</Note>
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
      className="flex animate-enter flex-col gap-3"
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
          className="relative mt-px rounded-[9px] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring)]"
        >
          <BlockIcon hue={(effectiveName.length * 37) % 360} label={effectiveName} size={40} />
          {icon && (
            <span aria-hidden className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-label text-window shadow-[0_0_0_1.5px_var(--color-sheet)]">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
          )}
        </button>
        <TextField label="Name" placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} error={nameError} className="flex-1" autoFocus />
      </div>

      {versions.isError && <Banner tone="error" title="Couldn’t load the version list">{errorMessage(versions.error)}</Banner>}
      <Card title="Version">
        <Row label="Minecraft">
          <Combobox
            aria-label="Minecraft version"
            value={minecraft}
            onValueChange={setChosenMc}
            options={mcOptions}
            placeholder={versions.isPending ? 'Loading versions…' : 'Choose a version'}
            className="w-[180px]"
          />
          <Checkbox checked={snapshots} onCheckedChange={setSnapshots} label="Show snapshots" className="ml-auto !items-center" />
        </Row>
        <Row
          label="Mod loader"
          hint={
            (unavailable.length > 0 || loaderError) && (
              <span className={loaderError ? 'text-red' : undefined}>
                {loaderError ?? `${listNames(unavailable.map(loaderName))} ${unavailable.length === 1 ? 'isn’t' : 'aren’t'} available for ${minecraft}.`}
              </span>
            )
          }
        >
          <Segmented<LoaderKind>
            aria-label="Mod loader"
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
        </Row>
        {loader !== 'vanilla' && !loaderError && (
          <Row label={`${loaderName(loader)} version`}>
            {loaderQueries[loader].isPending ? (
              <span className="flex items-center gap-2 text-meta text-label-2">
                <Spinner size={12} /> Loading versions…
              </span>
            ) : loaderQueries[loader].isError ? (
              <p className="text-meta text-red">{errorMessage(loaderQueries[loader].error)}</p>
            ) : (
              <Select
                aria-label={`${loaderName(loader)} version`}
                className="w-[250px]"
                value={loaderVersion ?? ''}
                onValueChange={setChosenLoaderVersion}
                options={loaderVersions.map((v) => ({
                  value: v.version,
                  text: v.version,
                  label: <VersionLabel version={v.version} recommended={v.recommended} latest={v.latest} />,
                }))}
              />
            )}
          </Row>
        )}
      </Card>

      <DisclosureCard title="Advanced" open={advanced} onOpenChange={setAdvanced}>
        <Row label="Java">
          <Select
            aria-label="Java runtime"
            className="w-[260px]"
            value={javaPath}
            onValueChange={setJavaPath}
            options={[
              { value: 'auto', label: 'Automatic (recommended)' },
              ...javas.filter((j) => j.valid).map((j, i) => ({ value: j.path, label: `Java ${j.version} · ${j.vendor} · ${j.arch}`, separatorBefore: i === 0 })),
            ]}
          />
        </Row>
        <Row label="Memory">
          <Switch checked={memAuto} onCheckedChange={setMemAuto} aria-label="Automatic memory" />
          <span className="text-compact">{memAuto ? 'Automatic' : 'Maximum'}</span>
          {!memAuto && <Stepper aria-label="Maximum memory" unit="MB" value={memMax} min={1024} max={65536} step={256} onValueChange={setMemMax} />}
        </Row>
      </DisclosureCard>
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
  'contains-data-root': 'This folder contains Amethyst’s own data folder. Choose the game folder itself.',
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
      icon={<FolderOpen strokeWidth={1.5} />}
      title="Add an existing folder"
      description="Import a .minecraft folder or another launcher’s instance folder. Amethyst detects the version and shows what it found. Copy is the default; Link in place keeps the files where they are."
      button="Choose Folder…"
      busy={reading}
      onPick={() => void pick()}
    />
  ) : (
    <div className="flex animate-enter flex-col gap-3">
      {candidate.check !== 'ok' && <Banner tone="error" title="This folder can’t be imported">{CHECK_TEXT[candidate.check]}</Banner>}
      {candidate.check === 'ok' && candidate.removedLaunchSettings && candidate.removedLaunchSettings.length > 0 && (
        <Banner tone="warning" title="These launch settings won’t be imported">
          <p>They run programs or load code into the game. Add them again in the instance’s settings if you trust them.</p>
          <ul className="selectable mt-1 list-disc pl-4 font-mono text-small">
            {candidate.removedLaunchSettings.map((r) => (
              <li key={r} className="break-all">
                {r}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      <Card title="Review" action={<Button onClick={() => void pick()}>Choose Another…</Button>}>
        <InfoRow
          label="Folder"
          value={
            <span className="selectable font-mono text-meta" title={candidate.path}>
              {candidate.path}
            </span>
          }
        />
        <InfoRow
          label="Found"
          value={candidate.kind === 'amethyst' ? 'An Amethyst instance' : candidate.kind === 'game-dir' ? 'A Minecraft game folder' : 'Nothing recognisable (an empty instance will be set up)'}
          detail={
            <span className="tabular">
              {candidate.modCount} mods · {candidate.worldCount} worlds
            </span>
          }
        />
      </Card>
      <Card title="Import as">
        <Row label="Name" htmlFor="ni-folder-name" hintId="ni-folder-name-msg" hint={!name.trim() && <span className="text-red">Enter a name.</span>}>
          <TextField
            id="ni-folder-name"
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!name.trim() || undefined}
            aria-describedby={!name.trim() ? 'ni-folder-name-msg' : undefined}
            className="flex-1"
          />
        </Row>
        {needsRuntime && (
          <Row
            label="Minecraft"
            hint={candidate.runtime?.minecraft ? 'Detected from the folder. Check it’s right.' : <span className="text-orange">Couldn’t detect it; choose one.</span>}
          >
            <Combobox aria-label="Minecraft version" value={mc} onValueChange={setMc} options={options} placeholder="Choose a version" className="w-[180px]" />
          </Row>
        )}
        <Row
          label="Files"
          hint={
            mode === 'copy'
              ? 'A clone is made in Amethyst’s instances folder (no extra disk space with APFS). The original stays untouched.'
              : 'Amethyst uses the folder where it is. Moving or unmounting it makes the instance unavailable.'
          }
        >
          <Segmented<'copy' | 'in-place'>
            aria-label="Import mode"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'copy', label: 'Copy into Amethyst' },
              { value: 'in-place', label: 'Link in place' },
            ]}
          />
        </Row>
      </Card>
    </div>
  )
  return { candidate, valid, busy, submit: () => void submit(), element }
}

function listNames(names: string[]) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

