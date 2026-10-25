import { AlertTriangle, ChevronDown, Ellipsis, RefreshCw } from 'lucide-react'
import type { GameSettings } from '@shared/services'
import { Badge, Button, Checkbox, Form, FormSection, IconButton, Menu, Select, SkeletonRows, Spinner, Stepper, Switch, cn } from '@/ui'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { formatArgs, parseArgs } from '@/lib/args'
import { javaActions, useJavaRuntimes, useJavaScanning } from '@/data/java'
import { patchSettings, useAppSettings, useSystemInfo } from '@/data/settings'
import type { JavaRuntime } from '@/data/types'
import { QueryError } from '@/app/RouteStates'
import { CommitField, EnvTable } from '@/routes/settings-fields'
import { SettingRow, useRowHighlight } from './context'

const SOURCE_LABEL: Record<JavaRuntime['source'], string> = { managed: 'Managed', system: 'System', added: 'Added' }

const INVALID: Record<string, string> = {
  missing: 'Missing',
  'not-executable': 'Not executable',
  'bad-cpu-type': 'Wrong processor',
  timeout: 'Didn’t respond',
  unparseable: 'Unknown version',
  'spawn-failed': 'Can’t run',
}

/** Settings → Java (B7.4). */
export function JavaPane() {
  const { data: runtimes, isPending, isError, error, refetch } = useJavaRuntimes()
  const scanning = useJavaScanning()
  const s = useAppSettings()
  const highlighted = useRowHighlight('runtimes')
  const policy = s.game.java.policy

  return (
    <Form className="max-w-[720px]">
      <FormSection
        title="Installed Runtimes"
        action={
          <div className="flex items-center gap-1">
            {scanning && <Spinner size={12} label="Scanning" />}
            <IconButton label="Scan Again" size="sm" disabled={scanning} onClick={() => void javaActions.rescan()}>
              <RefreshCw />
            </IconButton>
            <Button size="sm" onClick={() => void javaActions.addFromDisk()}>
              Add…
            </Button>
            <Menu
              align="end"
              trigger={
                <Button size="sm">
                  Download Java… <ChevronDown className="!size-3" />
                </Button>
              }
              items={[8, 17, 21, 25].map((major) => ({ label: `Java ${major}`, onSelect: () => void javaActions.install(major) }))}
            />
          </div>
        }
        footer="Managed runtimes were downloaded by Amethyst (Mojang’s builds, or Azul Zulu where Mojang has none). Forgetting a runtime hides it from Amethyst; its files stay where they are."
      >
        <div id="row-runtimes" className={cn('transition-colors duration-500', highlighted && 'bg-accent-soft')}>
          {isError ? (
            <QueryError error={error} onRetry={() => refetch()} what="Java runtimes" />
          ) : isPending ? (
            <SkeletonRows rows={3} />
          ) : runtimes.length === 0 ? (
            <p className="px-3 py-6 text-center text-body text-label-2">No Java runtimes found. Amethyst downloads the right one when you play.</p>
          ) : (
            <table className="w-full table-fixed text-left text-body">
              <thead>
                <tr className="border-b border-separator text-small text-label-2">
                  <th className="w-[96px] px-2.5 py-1.5 font-medium">Version</th>
                  <th className="w-[140px] px-2 py-1.5 font-medium">Vendor</th>
                  <th className="w-[96px] px-2 py-1.5 font-medium">Arch</th>
                  <th className="px-2 py-1.5 font-medium">Path</th>
                  <th className="w-[76px] px-2 py-1.5 font-medium">Source</th>
                  <th className="w-[36px] px-1 py-1.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runtimes.map((r, i) => (
                  <tr key={r.id} className={cn('h-8', i % 2 === 1 && 'bg-row-alt', !r.valid && 'text-label-3')}>
                    <td className="px-2.5 tabular">{r.version}</td>
                    <td className="truncate px-2 text-label-2">{r.vendor}</td>
                    <td className="px-2">
                      {!r.valid ? (
                        <Badge tone="error" title={r.invalidReason}>
                          {INVALID[r.invalidReason ?? ''] ?? 'Unusable'}
                        </Badge>
                      ) : r.arch === 'x86_64' ? (
                        <Badge tone="warning" title="Runs under Rosetta">
                          <AlertTriangle /> x86_64
                        </Badge>
                      ) : (
                        <span className="text-label-2">{r.arch}</span>
                      )}
                    </td>
                    <td className="selectable truncate px-2 font-mono text-small text-label-2" title={r.path}>
                      {r.path}
                    </td>
                    <td className="px-2 text-label-2">{SOURCE_LABEL[r.source]}</td>
                    <td className="px-1">
                      <Menu
                        align="end"
                        trigger={
                          <IconButton label={`Actions for Java ${r.version}`} size="sm" tooltip={false}>
                            <Ellipsis />
                          </IconButton>
                        }
                        items={[
                          { label: 'Show in Finder', onSelect: () => void api.shell.showItemInFolder(r.home || r.path).catch((e: unknown) => toastError(e, 'Couldn’t show it in Finder')) },
                          { label: 'Use for Every Instance', disabled: !r.valid, onSelect: () => void patchSettings({ game: { java: { policy: 'custom', path: r.path } } }) },
                          { kind: 'separator' },
                          { label: r.source === 'added' ? 'Remove' : 'Forget', onSelect: () => void javaActions.remove(r) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </FormSection>

      <FormSection footer="Instances can still choose their own runtime in their Settings tab.">
        <SettingRow row="java-policy" label="Java selection" description={POLICY_TEXT[policy]}>
          <Select<GameSettings['java']['policy']>
            aria-label="Java selection"
            value={policy}
            onValueChange={(p) => void patchSettings({ game: { java: { policy: p } } })}
            options={[
              { value: 'auto', label: 'Automatic (recommended)' },
              { value: 'prefer-installed', label: 'Prefer installed Java' },
              { value: 'custom', label: 'Always use one runtime' },
            ]}
          />
        </SettingRow>
        {policy === 'custom' && (
          <SettingRow row="java-path" label="Runtime" stacked>
            <Select
              aria-label="Runtime for every instance"
              value={s.game.java.path || ''}
              onValueChange={(path) => void patchSettings({ game: { java: { path } } })}
              className="w-full"
              options={(runtimes ?? []).filter((r) => r.valid).map((r) => ({ value: r.path, label: `Java ${r.version} · ${r.vendor} · ${r.arch}` }))}
            />
          </SettingRow>
        )}
      </FormSection>
    </Form>
  )
}

const POLICY_TEXT: Record<GameSettings['java']['policy'], string> = {
  auto: 'Each Minecraft version gets the Java it needs, downloaded natively for Apple silicon when missing.',
  'prefer-installed': 'Uses a compatible arm64 JDK already on this Mac first, otherwise downloads one.',
  custom: 'Uses the runtime below when it’s compatible, otherwise picks automatically.',
}

/** Settings → Game Defaults (B7.5): what every instance inherits. */
export function GamePane() {
  const g = useAppSettings().game
  const system = useSystemInfo()
  const ram = system.data?.totalMemoryMB ?? 65536
  const set = (patch: Parameters<typeof patchSettings>[0]['game']) => void patchSettings({ game: patch })
  const memError = g.memory.mode === 'manual' && g.memory.minMB > 0 && g.memory.maxMB > 0 && g.memory.minMB > g.memory.maxMB ? 'Minimum memory can’t be more than maximum.' : undefined

  return (
    <Form>
      <FormSection title="Memory" footer={memError ? <span className="text-red">{memError}</span> : 'Automatic picks a size from the number of mods and this Mac’s memory.'}>
        <SettingRow row="memory" label="Mode">
          <Select<GameSettings['memory']['mode']>
            aria-label="Memory mode"
            value={g.memory.mode}
            onValueChange={(mode) => set({ memory: mode === 'manual' ? { mode, minMB: g.memory.minMB, maxMB: g.memory.maxMB || 4096 } : { mode } })}
            options={[
              { value: 'unassigned', label: 'Let Java decide' },
              { value: 'auto', label: 'Automatic' },
              { value: 'manual', label: 'Manual' },
            ]}
          />
        </SettingRow>
        {g.memory.mode === 'manual' && (
          <>
            <SettingRow row="memory-min" label="Minimum" description="0 leaves it to Java.">
              <Stepper aria-label="Minimum memory" unit="MB" value={g.memory.minMB} min={0} max={ram} step={256} onValueChange={(minMB) => set({ memory: { minMB } })} />
            </SettingRow>
            <SettingRow row="memory-max" label="Maximum" description={`This Mac has ${Math.round(ram / 1024)} GB.`}>
              <Stepper aria-label="Maximum memory" unit="MB" value={g.memory.maxMB} min={512} max={ram} step={256} onValueChange={(maxMB) => set({ memory: { maxMB } })} />
            </SettingRow>
          </>
        )}
      </FormSection>

      <FormSection title="Window" footer="0 × 0 uses the game’s default size.">
        <SettingRow row="resolution" label="Resolution">
          <div className="flex items-center gap-1.5">
            <Stepper aria-label="Width" value={g.resolution.width} min={0} max={7680} step={2} disabled={g.resolution.fullscreen} onValueChange={(width) => set({ resolution: { width } })} width={60} />
            <span className="text-label-2">×</span>
            <Stepper aria-label="Height" value={g.resolution.height} min={0} max={4320} step={2} disabled={g.resolution.fullscreen} onValueChange={(height) => set({ resolution: { height } })} width={60} />
          </div>
        </SettingRow>
        <SettingRow row="fullscreen" label="Fullscreen">
          <Checkbox aria-label="Fullscreen" checked={g.resolution.fullscreen} onCheckedChange={(fullscreen) => set({ resolution: { fullscreen } })} />
        </SettingRow>
      </FormSection>

      <FormSection title="Arguments" footer="Passed exactly as written; quote values that contain spaces. Instances inherit these unless they override them.">
        <SettingRow row="jvm-args" label="JVM arguments" stacked>
          <CommitField aria-label="JVM arguments" monospace placeholder="-XX:+UseG1GC" value={formatArgs(g.jvmArgs)} onCommit={(v) => set({ jvmArgs: parseArgs(v) })} className="w-full" />
        </SettingRow>
        <SettingRow row="game-args" label="Game arguments" stacked>
          <CommitField aria-label="Game arguments" monospace value={formatArgs(g.gameArgs)} onCommit={(v) => set({ gameArgs: parseArgs(v) })} className="w-full" />
        </SettingRow>
        <SettingRow row="wrapper" label="Wrapper command" description="Runs before Java, e.g. /usr/bin/caffeinate -i." stacked>
          <CommitField aria-label="Wrapper command" monospace placeholder="/usr/bin/caffeinate -i" value={g.wrapperCommand} onCommit={(wrapperCommand) => set({ wrapperCommand })} className="w-full" />
        </SettingRow>
        <SettingRow row="prelaunch" label="Pre-launch command" description="Runs in the instance folder and must finish before the game starts." stacked>
          <CommitField aria-label="Pre-launch command" monospace value={g.preLaunchCommand} onCommit={(preLaunchCommand) => set({ preLaunchCommand })} className="w-full" />
        </SettingRow>
      </FormSection>

      <FormSection title="Environment Variables">
        <div id="row-env" className="px-2.5 py-2">
          <EnvTable value={g.env} onChange={(env) => set({ env })} />
        </div>
      </FormSection>

      <FormSection title="Apple Silicon" footer="Amethyst never needs Rosetta: old versions get native arm64 libraries built from public source.">
        <SettingRow row="natives" label="Replace native libraries with arm64 builds">
          <Select<GameSettings['replaceArm64Natives']>
            aria-label="Replace native libraries"
            value={g.replaceArm64Natives}
            onValueChange={(replaceArm64Natives) => set({ replaceArm64Natives })}
            options={[
              { value: 'legacy-only', label: 'Older versions only (recommended)' },
              { value: 'all', label: 'All versions' },
              { value: 'off', label: 'Off (needs an x86_64 Java)' },
            ]}
          />
        </SettingRow>
        <SettingRow row="hide-launcher-game" label="Hide launcher while playing" htmlFor="set-hide-game">
          <Switch id="set-hide-game" checked={g.hideLauncherWhileRunning} onCheckedChange={(hideLauncherWhileRunning) => set({ hideLauncherWhileRunning })} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}
