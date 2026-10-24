import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Minus, Plus } from 'lucide-react'
import {
  Button,
  Checkbox,
  Combobox,
  Form,
  FormNote,
  FormRow,
  FormSection,
  IconButton,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  Slider,
  Stepper,
  Switch,
  TextArea,
  TextField,
  cn,
  toast,
} from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable } from '@/app/commands'
import { BlockIcon } from '@/app/visuals'
import { instanceActions, instanceKeys, loaderName, useInstance } from '@/data/instances'
import { useMods } from '@/data/content'
import { useGameVersions, useJavaRuntimes, useLoaderVersions } from '@/data/misc'
import { queryClient } from '@/data/query'
import { useInstanceSettings } from '@/data/instanceSettings'
import type { InstanceDetail, InstanceSummary, JavaRuntime, LoaderKind } from '@/data/types'
import { copyText, useInstanceId } from './parts'

/** TODO(wire): replace with api.system.info() → { totalMemoryMb: number } (main: os.totalmem()). */
const SYSTEM_RAM_MB = 16_384
const RECOMMENDED_MB = 4096

/** Java major version a Minecraft version needs (per Mojang's version JSON `javaVersion`). */
export function requiredJava(mc: string): number {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(mc)
  if (!m) return 8
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 18) return 17
  if (minor === 17) return 16
  return 8
}

/** Instance settings tab: a grouped form; changes apply immediately (B3.4). */
export default function InstanceSettingsTab() {
  const id = useInstanceId()
  const q = useInstance(id)
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} what="settings" />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      {q.data ? (
        <SettingsForm inst={q.data} />
      ) : (
        <Form>
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </Form>
      )}
    </div>
  )
}

/** A text field that commits when it loses focus (or on Return). */
function CommitField({ value, onCommit, multiline, ...rest }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; 'aria-label': string; monospace?: boolean; className?: string; id?: string }) {
  const commit = (v: string) => v !== value && onCommit(v)
  if (multiline)
    return <TextArea key={value} defaultValue={value} onBlur={(e) => commit(e.target.value)} rows={2} {...rest} className={cn('w-full', rest.className)} />
  return (
    <TextField
      key={value}
      defaultValue={value}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      {...rest}
    />
  )
}

function SettingsForm({ inst }: { inst: InstanceDetail }) {
  const s = useInstanceSettings(inst.id)
  const java = useJavaRuntimes()
  const [versionOpen, setVersionOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const runtimes = java.data ?? []
  const need = requiredJava(inst.minecraft)

  const renameInstance = (name: string) => {
    if (!name.trim()) return
    // TODO(wire): api.instances.update(id, { name })
    queryClient.setQueryData<InstanceSummary[]>(instanceKeys.list, (l) => l?.map((i) => (i.id === inst.id ? { ...i, name: name.trim() } : i)))
    queryClient.setQueryData<InstanceDetail | null>(instanceKeys.detail(inst.id), (d) => (d ? { ...d, name: name.trim() } : d))
  }

  const chosen: JavaRuntime | undefined =
    s.settings.javaRuntime === 'auto'
      ? runtimes.find((r) => r.major === need && r.arch === 'arm64') ?? runtimes.find((r) => r.major === need)
      : runtimes.find((r) => r.id === s.settings.javaRuntime)

  const versionSummary = `Minecraft ${inst.minecraft} · ${inst.loader.kind === 'vanilla' ? 'No mod loader' : `${loaderName(inst.loader.kind)} ${inst.loader.version ?? ''}`}`
  const mem = s.effective.memory
  const res = s.effective.resolution

  return (
    <Form>
      <FormSection title="General">
        <FormRow label="Icon" description="Click to change, or drop an image.">
          <button type="button" aria-label="Change icon" onClick={() => notYetAvailable('Change Icon')} className="rounded-lg transition-transform hover:scale-105">
            <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={36} />
          </button>
        </FormRow>
        <FormRow label="Name" htmlFor="inst-name">
          <CommitField id="inst-name" aria-label="Name" value={inst.name} onCommit={renameInstance} className="w-[240px]" />
        </FormRow>
        <FormRow label="Notes" stacked>
          <CommitField multiline aria-label="Notes" placeholder="Anything you want to remember about this instance" value={s.settings.notes} onCommit={(notes) => s.update({ notes })} />
        </FormRow>
      </FormSection>

      <FormSection title="Version">
        <FormRow label={versionSummary} description="Changing the version shows what will change before anything happens.">
          <Button onClick={() => setVersionOpen(true)}>Change Version…</Button>
        </FormRow>
        <FormRow label="Verify Files" description="Re-downloads anything missing or damaged. Progress is shown in Activity.">
          <Button onClick={() => instanceActions.repair(inst)}>Verify Files</Button>
        </FormRow>
      </FormSection>

      <FormSection title="Java">
        <FormRow label="Runtime">
          <Select
            aria-label="Java runtime"
            value={s.settings.javaRuntime}
            onValueChange={(v) => (v === 'add' ? notYetAvailable('Add Java from disk') : s.update({ javaRuntime: v }))}
            className="max-w-[300px]"
            options={[
              { value: 'auto', label: 'Automatic (recommended)' },
              ...runtimes.map((r, i) => ({ value: r.id, label: `Java ${r.version} · ${r.vendor} · ${r.arch}`, separatorBefore: i === 0 })),
              { value: 'add', label: 'Add from Disk…', separatorBefore: true },
            ]}
          />
        </FormRow>
        <JavaStatus need={need} chosen={chosen} loading={java.isPending} />
        <FormRow
          label="Memory"
          description={mem.auto ? 'Amethyst picks an amount based on the mods and your Mac’s memory.' : `${(mem.maxMb / 1024).toFixed(1)} GB of ${SYSTEM_RAM_MB / 1024} GB`}
          inherited={s.isInherited('memory')}
          onReset={() => s.reset('memory')}
        >
          <label className="flex items-center gap-2 text-body">
            Automatic
            <Switch checked={mem.auto} onCheckedChange={(auto) => s.update({ memory: { ...mem, auto } })} aria-label="Automatic memory" />
          </label>
        </FormRow>
        {!mem.auto && (
          <FormRow label="Maximum" stacked>
            <div className="flex w-full flex-col gap-2">
              <Slider
                aria-label="Maximum memory"
                min={512}
                max={SYSTEM_RAM_MB}
                step={256}
                ticks={[RECOMMENDED_MB]}
                value={mem.maxMb}
                valueText={(v) => `${(v / 1024).toFixed(1)} GB`}
                onValueChange={(maxMb) => s.update({ memory: { ...mem, maxMb, minMb: Math.min(mem.minMb, maxMb) } })}
              />
              <div className="flex items-center justify-between text-small text-label-2">
                <span>512 MB</span>
                <span>Recommended: {RECOMMENDED_MB / 1024} GB</span>
                <span>{SYSTEM_RAM_MB / 1024} GB</span>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-body">
                  Min
                  <Stepper aria-label="Minimum memory" unit="MB" min={256} max={mem.maxMb} step={256} value={mem.minMb} onValueChange={(minMb) => s.update({ memory: { ...mem, minMb } })} />
                </label>
                <label className="flex items-center gap-2 text-body">
                  Max
                  <Stepper aria-label="Maximum memory in MB" unit="MB" min={512} max={SYSTEM_RAM_MB} step={256} value={mem.maxMb} onValueChange={(maxMb) => s.update({ memory: { ...mem, maxMb } })} />
                </label>
              </div>
            </div>
          </FormRow>
        )}
      </FormSection>

      <FormSection title="Launch">
        <FormRow label="Resolution" inherited={s.isInherited('resolution')} onReset={() => s.reset('resolution')}>
          <div className="flex items-center gap-2">
            {!res.fullscreen && (
              <>
                <Stepper aria-label="Width" width={56} min={320} max={7680} value={res.width} onValueChange={(width) => s.update({ resolution: { ...res, width } })} />
                <span className="text-label-2">×</span>
                <Stepper aria-label="Height" width={56} min={240} max={4320} value={res.height} onValueChange={(height) => s.update({ resolution: { ...res, height } })} />
              </>
            )}
            <Checkbox checked={res.fullscreen} onCheckedChange={(fullscreen) => s.update({ resolution: { ...res, fullscreen } })} label="Fullscreen" />
          </div>
        </FormRow>
        <FormRow label="Hide launcher while playing" inherited={s.isInherited('hideLauncher')} onReset={() => s.reset('hideLauncher')}>
          <Switch checked={s.effective.hideLauncher} onCheckedChange={(hideLauncher) => s.update({ hideLauncher })} aria-label="Hide launcher while playing" />
        </FormRow>
        <FormRow label="Open log window on launch" inherited={s.isInherited('openLogOnLaunch')} onReset={() => s.reset('openLogOnLaunch')}>
          <Switch checked={s.effective.openLogOnLaunch} onCheckedChange={(openLogOnLaunch) => s.update({ openLogOnLaunch })} aria-label="Open log window on launch" />
        </FormRow>
        <FormRow label="Share options.txt with other instances" description="Keeps key bindings and video settings the same everywhere.">
          <Switch checked={s.settings.shareOptions} onCheckedChange={(shareOptions) => s.update({ shareOptions })} aria-label="Share options.txt" />
        </FormRow>
      </FormSection>

      <FormSection title="Advanced" collapsible footer="Arguments are passed to Java exactly as written. Leave blank to use the defaults from Settings.">
        <FormRow label="JVM arguments" stacked inherited={s.isInherited('jvmArgs')} onReset={() => s.reset('jvmArgs')}>
          <CommitField multiline monospace aria-label="JVM arguments" placeholder="-XX:+UseG1GC" value={s.effective.jvmArgs} onCommit={(jvmArgs) => s.update({ jvmArgs })} />
        </FormRow>
        <FormRow label="Game arguments" stacked inherited={s.isInherited('gameArgs')} onReset={() => s.reset('gameArgs')}>
          <CommitField multiline monospace aria-label="Game arguments" value={s.effective.gameArgs} onCommit={(gameArgs) => s.update({ gameArgs })} />
        </FormRow>
        <FormRow label="Wrapper command" description="Runs before java, e.g. a profiler." inherited={s.isInherited('wrapper')} onReset={() => s.reset('wrapper')}>
          <CommitField monospace aria-label="Wrapper command" value={s.effective.wrapper} onCommit={(wrapper) => s.update({ wrapper })} className="w-[240px]" />
        </FormRow>
        <FormRow label="Pre-launch command" description="Runs to completion before the game starts.">
          <CommitField monospace aria-label="Pre-launch command" value={s.settings.preLaunch ?? ''} onCommit={(preLaunch) => s.update({ preLaunch })} className="w-[240px]" />
        </FormRow>
        <FormRow label="Environment variables" stacked inherited={s.isInherited('env')} onReset={() => s.reset('env')}>
          <EnvTable value={s.effective.env} onChange={(env) => s.update({ env })} />
        </FormRow>
        <FormRow label="Launch command" description="See the exact arguments Amethyst will use.">
          <Button onClick={() => setPreviewOpen(true)}>Preview Launch Command…</Button>
        </FormRow>
      </FormSection>

      <FormSection title="Modpack Info" footer="Used when you export this instance as a modpack.">
        <FormRow label="Version" htmlFor="mp-version">
          <CommitField id="mp-version" aria-label="Modpack version" value={s.settings.modpack.version} onCommit={(version) => s.update({ modpack: { ...s.settings.modpack, version } })} className="w-[160px]" />
        </FormRow>
        <FormRow label="Author" htmlFor="mp-author">
          <CommitField id="mp-author" aria-label="Author" value={s.settings.modpack.author} onCommit={(author) => s.update({ modpack: { ...s.settings.modpack, author } })} className="w-[240px]" />
        </FormRow>
        <FormRow label="Description" stacked>
          <CommitField multiline aria-label="Description" value={s.settings.modpack.description} onCommit={(description) => s.update({ modpack: { ...s.settings.modpack, description } })} />
        </FormRow>
        <FormRow label="URL" htmlFor="mp-url">
          <CommitField id="mp-url" aria-label="URL" placeholder="https://" value={s.settings.modpack.url} onCommit={(url) => s.update({ modpack: { ...s.settings.modpack, url } })} className="w-[240px]" />
        </FormRow>
        {inst.upstream && (
          <FormRow label={inst.upstream.source === 'modrinth' ? 'Modrinth project' : 'CurseForge project'}>
            <span className="selectable font-mono text-callout text-label-2">{inst.upstream.projectId}</span>
          </FormRow>
        )}
      </FormSection>

      {versionOpen && <VersionSheet inst={inst} onClose={() => setVersionOpen(false)} />}
      <LaunchPreviewSheet open={previewOpen} onOpenChange={setPreviewOpen} inst={inst} java={chosen} />
    </Form>
  )
}

function JavaStatus({ need, chosen, loading }: { need: number; chosen?: JavaRuntime; loading: boolean }) {
  if (loading) return <FormNote>Looking for Java…</FormNote>
  if (!chosen || chosen.major !== need)
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-body">
        <AlertTriangle className="size-4 text-orange" />
        <span className="flex-1">Needs Java {need}</span>
        <Button size="md" variant="primary" onClick={() => notYetAvailable(`Downloading Java ${need}`)}>
          Download
        </Button>
      </div>
    )
  if (chosen.arch === 'x86_64')
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-body">
        <AlertTriangle className="size-4 text-orange" />
        <span className="flex-1">x86_64 runtime (runs under Rosetta, slower)</span>
        <Button size="md" onClick={() => notYetAvailable(`Downloading Java ${need}`)}>
          Get arm64 Java {need}
        </Button>
      </div>
    )
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-body">
      <CheckCircle2 className="size-4 text-green" />
      Java {chosen.version} ({chosen.vendor}) will be used
    </div>
  )
}

function EnvTable({ value, onChange }: { value: { key: string; value: string }[]; onChange: (v: { key: string; value: string }[]) => void }) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      {value.length === 0 && <p className="text-small text-label-3">No variables.</p>}
      {value.map((row, i) => (
        // Rows have no stable id until saved; the key is position plus name.
        <div key={`${i}:${row.key}`} className="flex items-center gap-1.5">
          <CommitField monospace aria-label={`Variable ${i + 1} name`} placeholder="NAME" value={row.key} onCommit={(key) => onChange(value.map((r, j) => (j === i ? { ...r, key } : r)))} className="w-[160px]" />
          <span className="text-label-3">=</span>
          <CommitField monospace aria-label={`Variable ${i + 1} value`} placeholder="value" value={row.value} onCommit={(v) => onChange(value.map((r, j) => (j === i ? { ...r, value: v } : r)))} className="flex-1" />
          <IconButton label="Remove variable" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Minus />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="borderless" icon={<Plus />} className="-ml-2 self-start" onClick={() => onChange([...value, { key: '', value: '' }])}>
        Add Variable
      </Button>
    </div>
  )
}

const LOADERS: { value: LoaderKind; label: string }[] = [
  { value: 'vanilla', label: 'None' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
]

/** "Change Version…": the same picker as creation, plus a consequences panel (B4.6). */
function VersionSheet({ inst, onClose }: { inst: InstanceDetail; onClose: () => void }) {
  const versions = useGameVersions()
  const mods = useMods(inst.id)
  const [snapshots, setSnapshots] = useState(false)
  const [mc, setMc] = useState(inst.minecraft)
  const [loader, setLoader] = useState<LoaderKind>(inst.loader.kind)
  const [loaderVersion, setLoaderVersion] = useState<string | undefined>(inst.loader.version)
  const [updateMods, setUpdateMods] = useState(true)
  const lv = useLoaderVersions(loader, mc)
  const loaderVersions = useMemo(() => lv.data ?? [], [lv.data])
  // Never silently clear: if the chosen version is filtered out it stays chosen and listed.
  const options = useMemo(
    () =>
      (versions.data ?? [])
        .filter((v) => v.type === 'release' || snapshots || v.id === mc)
        .map((v) => ({ value: v.id, label: v.id, detail: v.type === 'release' ? undefined : v.type === 'snapshot' ? 'Snapshot' : 'Old' })),
    [versions.data, snapshots, mc],
  )
  const effectiveLoaderVersion =
    loader === 'vanilla' ? undefined : loaderVersions.some((v) => v.version === loaderVersion) ? loaderVersion : (loaderVersions.find((v) => v.recommended) ?? loaderVersions[0])?.version
  const loaderUnavailable = loader !== 'vanilla' && !lv.isPending && loaderVersions.length === 0

  const modList = mods.data ?? []
  const changedMc = mc !== inst.minecraft
  const withUpdates = changedMc ? modList.filter((m) => m.update).length : 0
  const noVersion = changedMc ? Math.max(0, Math.round(modList.length * 0.04)) : 0
  const javaBefore = requiredJava(inst.minecraft)
  const javaAfter = requiredJava(mc)
  const unchanged = !changedMc && loader === inst.loader.kind && effectiveLoaderVersion === inst.loader.version

  const consequences: string[] = []
  if (loader !== inst.loader.kind) {
    if (inst.loader.kind === 'vanilla') consequences.push(`${loaderName(loader)} will be added.`)
    else if (loader === 'vanilla') consequences.push(`${loaderName(inst.loader.kind)} will be removed. Mods stay installed but won’t load.`)
    else consequences.push(`${loaderName(inst.loader.kind)} will be replaced by ${loaderName(loader)}.`)
  } else if (loader !== 'vanilla' && effectiveLoaderVersion !== inst.loader.version) consequences.push(`${loaderName(loader)} ${inst.loader.version} → ${effectiveLoaderVersion}.`)
  if (javaAfter !== javaBefore) consequences.push(`Needs Java ${javaAfter} — it will be downloaded automatically.`)

  const apply = () => {
    // TODO(wire): api.instances.changeVersion(id, { minecraft, loader: { kind, version }, updateMods }) → task id (progress in Activity).
    const patch = { minecraft: mc, loader: { kind: loader, version: effectiveLoaderVersion } }
    queryClient.setQueryData<InstanceSummary[]>(instanceKeys.list, (l) => l?.map((i) => (i.id === inst.id ? { ...i, ...patch } : i)))
    queryClient.setQueryData<InstanceDetail | null>(instanceKeys.detail(inst.id), (d) => (d ? { ...d, ...patch } : d))
    toast({ kind: 'success', title: `Changing “${inst.name}” to ${mc}`, message: 'Progress is shown in Activity.' })
    onClose()
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change Version"
      description={`Currently Minecraft ${inst.minecraft}${inst.loader.kind === 'vanilla' ? '' : ` with ${loaderName(inst.loader.kind)} ${inst.loader.version}`}.`}
      width={540}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={unchanged || loaderUnavailable} onClick={apply}>
            Change Version
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-right text-body">Minecraft</span>
          <div className="flex items-center gap-3">
            <Combobox aria-label="Minecraft version" value={mc} onValueChange={setMc} options={options} className="w-[200px]" emptyText="No matching versions" />
            <Checkbox checked={snapshots} onCheckedChange={setSnapshots} label="Show snapshots" />
          </div>
          <span className="text-right text-body">Mod loader</span>
          <Segmented aria-label="Mod loader" value={loader} onValueChange={setLoader} options={LOADERS} className="justify-self-start" />
          {loader !== 'vanilla' && (
            <>
              <span className="text-right text-body">{loaderName(loader)}</span>
              {loaderUnavailable ? (
                <p className="text-callout text-orange">
                  {loaderName(loader)} isn’t available for {mc}.
                </p>
              ) : (
                <Select
                  aria-label={`${loaderName(loader)} version`}
                  value={effectiveLoaderVersion ?? ''}
                  onValueChange={setLoaderVersion}
                  disabled={lv.isPending}
                  className="w-[200px]"
                  options={loaderVersions.map((v) => ({
                    value: v.version,
                    text: v.version,
                    label: (
                      <span className="flex items-center gap-2">
                        {v.version}
                        {v.recommended && <span className="text-small opacity-70">Recommended</span>}
                        {v.latest && <span className="text-small opacity-70">Latest</span>}
                      </span>
                    ),
                  }))}
                />
              )}
            </>
          )}
        </div>

        <section aria-label="Consequences" className="rounded-lg bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
          <h3 className="mb-1.5 text-body font-semibold">What will change</h3>
          {unchanged ? (
            <p className="text-callout text-label-2">Nothing yet. Pick a different version or loader.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-callout">
              {consequences.map((c) => (
                <li key={c}>• {c}</li>
              ))}
              {changedMc && modList.length > 0 && (
                <>
                  <li>
                    <Checkbox checked={updateMods} onCheckedChange={setUpdateMods} label={`Update ${withUpdates} mods that have a version for ${mc}`} />
                  </li>
                  {noVersion > 0 && (
                    <li className="flex items-start gap-1.5 text-orange">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      {noVersion} mods have no version for {mc}. They stay installed but may not load.
                    </li>
                  )}
                </>
              )}
              {consequences.length === 0 && !(changedMc && modList.length) && <li>• Minecraft {inst.minecraft} → {mc}.</li>}
              <li className="text-label-2">A backup of your worlds is made first.</li>
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  )
}

function LaunchPreviewSheet({ open, onOpenChange, inst, java }: { open: boolean; onOpenChange: (o: boolean) => void; inst: InstanceDetail; java?: JavaRuntime }) {
  const s = useInstanceSettings(inst.id)
  const mem = s.effective.memory
  const res = s.effective.resolution
  // TODO(wire): api.launch.preview(id) → string[] (the real argv, with secrets redacted).
  const args = [
    `${java?.path ?? '<java>'}/bin/java`,
    ...(mem.auto ? ['-Xmx4096M'] : [`-Xms${mem.minMb}M`, `-Xmx${mem.maxMb}M`]),
    ...s.effective.jvmArgs.split(/\s+/).filter(Boolean),
    '-XstartOnFirstThread',
    '-Djava.library.path=<natives>',
    '-cp',
    '<libraries…>:<client.jar>',
    inst.loader.kind === 'fabric' ? 'net.fabricmc.loader.impl.launch.knot.KnotClient' : 'net.minecraft.client.main.Main',
    '--username',
    '<player>',
    '--version',
    inst.minecraft,
    '--gameDir',
    inst.path,
    '--accessToken',
    '<redacted>',
    ...(res.fullscreen ? ['--fullscreen'] : ['--width', String(res.width), '--height', String(res.height)]),
    ...s.effective.gameArgs.split(/\s+/).filter(Boolean),
  ]
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Launch Command"
      description="Tokens are redacted. Paths are shortened."
      width={620}
      footer={
        <>
          <Button onClick={() => copyText(args.join(' '), 'Copied launch command')}>Copy</Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <ol className="selectable flex flex-col rounded-lg bg-surface py-1.5 font-mono text-callout shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        {args.map((a, i) => (
          // The argv is positional; the index is the identity.
          <li key={`${i}-${a}`} className="flex gap-3 px-3 leading-5">
            <span className="w-6 shrink-0 text-right text-label-3 tabular">{i + 1}</span>
            <span className={cn('break-all', a.startsWith('-') ? 'text-accent' : a.startsWith('<') ? 'text-label-3' : 'text-label')}>{a}</span>
          </li>
        ))}
      </ol>
    </Sheet>
  )
}
