import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { InstanceOverrides, Patch } from '@shared/services'
import { Button, Checkbox, Form, FormNote, FormRow, FormSection, Select, Skeleton, Slider, Stepper, Switch } from '@/ui'
import { formatArgs, parseArgs } from '@/lib/args'
import { QueryError } from '@/app/RouteStates'
import { useUi } from '@/app/ui-store'
import { BlockIcon } from '@/app/visuals'
import { chooseInstanceIcon, instanceActions, loaderName, renameInstance, updateInstance, useInstance } from '@/data/instances'
import { javaActions, useJavaRecommendation, useJavaRuntimes } from '@/data/java'
import { useAppSettings, useSystemInfo } from '@/data/settings'
import type { InstanceDetail } from '@/data/types'
import { useInstanceId } from './parts'
import { CommitField, EnvTable } from '@/routes/settings-fields'

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

const RECOMMENDED_MB = 4096

function SettingsForm({ inst }: { inst: InstanceDetail }) {
  const global = useAppSettings().game
  const java = useJavaRuntimes()
  const rec = useJavaRecommendation(inst.id)
  const system = useSystemInfo()
  const setUi = useUi((s) => s.set)
  const o = inst.overrides
  const ramMB = system.data?.totalMemoryMB ?? 16_384
  const [dragMax, setDragMax] = useState<number>()
  const runtimes = (java.data ?? []).filter((r) => r.valid)

  const patch = (p: Patch<InstanceOverrides>, what = 'the setting') => void updateInstance(inst.id, { overrides: p }, what)

  const versionSummary = `Minecraft ${inst.minecraft || '?'} · ${inst.loader.kind === 'vanilla' ? 'No mod loader' : `${loaderName(inst.loader.kind)} ${inst.loader.version ?? ''}`}`

  // Effective values (instance override, else the global default).
  const globalMem = global.memory.mode === 'manual' ? { mode: 'manual' as const, minMB: global.memory.minMB, maxMB: global.memory.maxMB } : { mode: 'auto' as const, minMB: 0, maxMB: 0 }
  const mem = o.memory ?? globalMem
  const maxMB = mem.maxMB || RECOMMENDED_MB
  const res = {
    width: o.window?.width ?? global.resolution.width,
    height: o.window?.height ?? global.resolution.height,
    fullscreen: o.window?.fullscreen ?? global.resolution.fullscreen,
  }
  const hide = o.hideLauncherOnLaunch ?? global.hideLauncherWhileRunning
  const showLog = o.showLogWindow ?? global.openLogOnStart
  const skipVerify = o.skipAssetVerification ?? global.skipVerification
  const jvmArgs = o.jvmArgs ?? global.jvmArgs
  const gameArgs = o.gameArgs ?? global.gameArgs
  const wrapper = o.wrapperCommand ?? global.wrapperCommand
  const preLaunch = o.preLaunchCommand ?? global.preLaunchCommand
  const env = o.env ?? global.env
  const server = o.autoJoinServer ? `${o.autoJoinServer.host}${o.autoJoinServer.port ? `:${o.autoJoinServer.port}` : ''}` : ''

  const javaValue = o.javaPath ?? 'auto'
  const pinnedListed = !o.javaPath || runtimes.some((r) => r.path === o.javaPath)

  return (
    <Form>
      <FormSection title="General">
        <FormRow label="Icon" description="Click to choose an image.">
          <button type="button" aria-label="Change icon" onClick={() => void chooseInstanceIcon(inst)} className="rounded-lg transition-transform hover:scale-105">
            <BlockIcon hue={inst.iconHue} label={inst.name} src={inst.iconUrl} size={36} />
          </button>
        </FormRow>
        <FormRow label="Name" htmlFor="inst-name">
          <CommitField id="inst-name" aria-label="Name" value={inst.name} onCommit={(name) => void renameInstance(inst, name)} className="w-[240px]" />
        </FormRow>
        <FormRow label="Notes" stacked>
          <CommitField
            multiline
            aria-label="Notes"
            placeholder="Anything you want to remember about this instance"
            value={inst.notes}
            onCommit={(description) => void updateInstance(inst.id, { description }, 'the notes')}
          />
        </FormRow>
      </FormSection>

      <FormSection title="Version">
        <FormRow label={versionSummary} description={inst.versionId ? `Installed as ${inst.versionId}.` : 'Installs when you first play.'}>
          <Button onClick={() => setUi({ changeVersion: { id: inst.id, name: inst.name } })}>Change Version…</Button>
        </FormRow>
        <FormRow label="Verify Files" description="Checks every game file and re-downloads anything missing or damaged. Progress is shown in Activity.">
          <Button disabled={inst.state.kind !== 'idle'} onClick={() => void instanceActions.repair(inst)}>
            Verify Files
          </Button>
        </FormRow>
      </FormSection>

      <FormSection title="Java">
        <FormRow label="Runtime" inherited={!o.javaPath} onReset={() => patch({ javaPath: null }, 'the Java choice')}>
          <Select
            aria-label="Java runtime"
            value={javaValue}
            onValueChange={async (v) => {
              if (v === 'add') {
                const path = await javaActions.addFromDisk()
                if (path) patch({ javaPath: path }, 'the Java choice')
              } else patch({ javaPath: v === 'auto' ? null : v }, 'the Java choice')
            }}
            className="max-w-[300px]"
            options={[
              { value: 'auto', label: 'Automatic (recommended)' },
              ...runtimes.map((r, i) => ({ value: r.path, label: `Java ${r.version} · ${r.vendor} · ${r.arch}`, separatorBefore: i === 0 })),
              ...(!pinnedListed && o.javaPath ? [{ value: o.javaPath, label: `Missing: ${o.javaPath}` }] : []),
              { value: 'add', label: 'Add from Disk…', separatorBefore: true },
            ]}
          />
        </FormRow>
        <JavaStatus rec={rec.data} loading={rec.isPending} />
        <FormRow
          label="Memory"
          description={mem.mode === 'auto' ? 'Amethyst picks an amount based on the mods and your Mac’s memory.' : `${(maxMB / 1024).toFixed(1)} GB of ${Math.round(ramMB / 1024)} GB`}
          inherited={!o.memory}
          onReset={() => patch({ memory: null }, 'the memory setting')}
        >
          <label className="flex items-center gap-2 text-body">
            Automatic
            <Switch
              checked={mem.mode === 'auto'}
              onCheckedChange={(auto) => patch({ memory: auto ? { mode: 'auto', minMB: 0, maxMB: 0 } : { mode: 'manual', minMB: 0, maxMB: RECOMMENDED_MB } }, 'the memory setting')}
              aria-label="Automatic memory"
            />
          </label>
        </FormRow>
        {mem.mode === 'manual' && (
          <FormRow label="Maximum" stacked>
            <div className="flex w-full flex-col gap-2">
              <Slider
                aria-label="Maximum memory"
                min={512}
                max={ramMB}
                step={256}
                ticks={[RECOMMENDED_MB]}
                value={dragMax ?? maxMB}
                valueText={(v) => `${(v / 1024).toFixed(1)} GB`}
                onValueChange={setDragMax}
                onValueCommit={(v) => {
                  setDragMax(undefined)
                  patch({ memory: { mode: 'manual', maxMB: v, minMB: Math.min(mem.minMB, v) } }, 'the memory setting')
                }}
              />
              <div className="flex items-center justify-between text-small text-label-2">
                <span>512 MB</span>
                <span>Recommended: {RECOMMENDED_MB / 1024} GB</span>
                <span>{Math.round(ramMB / 1024)} GB</span>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-body">
                  Min
                  <Stepper aria-label="Minimum memory" unit="MB" min={0} max={maxMB} step={256} value={mem.minMB} onValueChange={(minMB) => patch({ memory: { mode: 'manual', minMB, maxMB } })} />
                </label>
                <label className="flex items-center gap-2 text-body">
                  Max
                  <Stepper aria-label="Maximum memory in MB" unit="MB" min={512} max={ramMB} step={256} value={maxMB} onValueChange={(v) => patch({ memory: { mode: 'manual', minMB: Math.min(mem.minMB, v), maxMB: v } })} />
                </label>
              </div>
            </div>
          </FormRow>
        )}
      </FormSection>

      <FormSection title="Launch">
        <FormRow label="Resolution" description={!res.fullscreen && !res.width ? 'Game default' : undefined} inherited={!o.window} onReset={() => patch({ window: null }, 'the resolution')}>
          <div className="flex items-center gap-2">
            {!res.fullscreen && (
              <>
                <Stepper aria-label="Width" width={56} min={320} max={7680} value={res.width || 854} onValueChange={(width) => patch({ window: { ...o.window, width, height: res.height || 480 } }, 'the resolution')} />
                <span className="text-label-2">×</span>
                <Stepper aria-label="Height" width={56} min={240} max={4320} value={res.height || 480} onValueChange={(height) => patch({ window: { ...o.window, width: res.width || 854, height } }, 'the resolution')} />
              </>
            )}
            <Checkbox checked={res.fullscreen} onCheckedChange={(fullscreen) => patch({ window: { ...o.window, fullscreen } }, 'the resolution')} label="Fullscreen" />
          </div>
        </FormRow>
        <FormRow label="Hide launcher while playing" inherited={o.hideLauncherOnLaunch === undefined} onReset={() => patch({ hideLauncherOnLaunch: null })}>
          <Switch checked={hide} onCheckedChange={(v) => patch({ hideLauncherOnLaunch: v })} aria-label="Hide launcher while playing" />
        </FormRow>
        <FormRow label="Open the log when the game starts" inherited={o.showLogWindow === undefined} onReset={() => patch({ showLogWindow: null })}>
          <Switch checked={showLog} onCheckedChange={(v) => patch({ showLogWindow: v })} aria-label="Open the log when the game starts" />
        </FormRow>
        <FormRow label="Check files before launch" description="Turning it off launches faster but skips the integrity check." inherited={o.skipAssetVerification === undefined} onReset={() => patch({ skipAssetVerification: null })}>
          <Switch checked={!skipVerify} onCheckedChange={(v) => patch({ skipAssetVerification: !v })} aria-label="Check files before launch" />
        </FormRow>
        <FormRow label="Join a server on start" description="Host and optional port, e.g. play.example.net:25565." inherited={!o.autoJoinServer} onReset={() => patch({ autoJoinServer: null }, 'the server')}>
          <CommitField
            aria-label="Server to join"
            placeholder="None"
            value={server}
            onCommit={(v) => {
              const m = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(v)
              if (!v.trim()) patch({ autoJoinServer: null }, 'the server')
              else if (m) patch({ autoJoinServer: { host: m[1]!, ...(m[2] ? { port: Number(m[2]) } : {}) } }, 'the server')
            }}
            className="w-[220px]"
          />
        </FormRow>
      </FormSection>

      <FormSection title="Advanced" collapsible footer="Arguments are passed exactly as written; quote values that contain spaces. Reset a row to use the defaults from Settings.">
        <FormRow label="JVM arguments" stacked inherited={!o.jvmArgs} onReset={() => patch({ jvmArgs: null })}>
          <CommitField multiline monospace aria-label="JVM arguments" placeholder="-XX:+UseG1GC" value={formatArgs(jvmArgs)} onCommit={(v) => patch({ jvmArgs: parseArgs(v) }, 'the JVM arguments')} />
        </FormRow>
        <FormRow label="Game arguments" stacked inherited={!o.gameArgs} onReset={() => patch({ gameArgs: null })}>
          <CommitField multiline monospace aria-label="Game arguments" value={formatArgs(gameArgs)} onCommit={(v) => patch({ gameArgs: parseArgs(v) }, 'the game arguments')} />
        </FormRow>
        <FormRow label="Wrapper command" description="Runs before java, e.g. a profiler." inherited={o.wrapperCommand === undefined} onReset={() => patch({ wrapperCommand: null })}>
          <CommitField monospace aria-label="Wrapper command" value={wrapper} onCommit={(v) => patch({ wrapperCommand: v }, 'the wrapper command')} className="w-[240px]" />
        </FormRow>
        <FormRow label="Pre-launch command" description="Runs in the instance folder and must finish before the game starts." inherited={o.preLaunchCommand === undefined} onReset={() => patch({ preLaunchCommand: null })}>
          <CommitField monospace aria-label="Pre-launch command" value={preLaunch} onCommit={(v) => patch({ preLaunchCommand: v }, 'the pre-launch command')} className="w-[240px]" />
        </FormRow>
        <FormRow label="Environment variables" stacked inherited={!o.env} onReset={() => patch({ env: null })}>
          <EnvTable value={env} onChange={(next) => patch({ env: next }, 'the environment variables')} />
        </FormRow>
      </FormSection>

      <FormSection title="Modpack Info" footer="Used when you export this instance as a modpack.">
        <FormRow label="Author" htmlFor="mp-author">
          <CommitField id="mp-author" aria-label="Author" value={inst.author} onCommit={(author) => void updateInstance(inst.id, { author }, 'the author')} className="w-[240px]" />
        </FormRow>
        <FormRow label="URL" htmlFor="mp-url">
          <CommitField id="mp-url" aria-label="URL" placeholder="https://" value={inst.homepageUrl} onCommit={(homepageUrl) => void updateInstance(inst.id, { homepageUrl }, 'the URL')} className="w-[240px]" />
        </FormRow>
        {inst.upstream && (
          <FormRow label={inst.upstream.source === 'modrinth' ? 'Modrinth project' : 'CurseForge project'}>
            <span className="selectable font-mono text-callout text-label-2">{inst.upstream.projectId}</span>
          </FormRow>
        )}
      </FormSection>
    </Form>
  )
}

function JavaStatus({ rec, loading }: { rec: ReturnType<typeof useJavaRecommendation>['data']; loading: boolean }) {
  if (loading) return <FormNote>Looking for Java…</FormNote>
  if (!rec) return <FormNote>Java is chosen when the game version is known.</FormNote>
  if (!rec.java)
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-body">
        <AlertTriangle className="size-4 text-orange" />
        <span className="flex-1">{rec.willInstall ? `Needs Java ${rec.major}. It downloads automatically when you play.` : `Needs Java ${rec.major}`}</span>
        <Button size="md" variant={rec.willInstall ? 'push' : 'primary'} onClick={() => void javaActions.install(rec.major)}>
          Download Now
        </Button>
      </div>
    )
  if (rec.rosetta)
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-body">
        <AlertTriangle className="size-4 text-orange" />
        <span className="flex-1">x86_64 runtime (runs under Rosetta, slower)</span>
        <Button size="md" onClick={() => void javaActions.install(rec.major)}>
          Get arm64 Java {rec.major}
        </Button>
      </div>
    )
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-body">
      <CheckCircle2 className="size-4 text-green" />
      <span>
        Java {rec.java.version} ({rec.java.vendor ?? 'unknown vendor'}) will be used
        {rec.pinnedUnavailable && <span className="text-orange"> — the chosen runtime is missing</span>}
      </span>
    </div>
  )
}
