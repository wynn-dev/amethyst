import { AlertTriangle, ChevronDown, Ellipsis, Plus, RefreshCw, X } from 'lucide-react'
import { Badge, Button, Checkbox, Form, FormSection, IconButton, Menu, SkeletonRows, Stepper, Switch, TextField, cn, toast } from '@/ui'
import { useJavaRuntimes } from '@/data/misc'
import { useSettings, useUpdateSettings } from '@/data/settings'
import type { JavaRuntime } from '@/data/types'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable } from '@/app/commands'
import { SettingRow, useRowHighlight } from './context'

function download(major: number) {
  // TODO(wire): api.java.download(major) — Mojang runtime where available, else Azul Zulu (java.md).
  toast({ kind: 'info', title: `Downloading Java ${major}`, message: 'Progress is shown in Activity.' })
}

const SOURCE_LABEL: Record<JavaRuntime['source'], string> = { managed: 'Managed', system: 'System', added: 'Added' }

/** Settings → Java (B7.4). */
export function JavaPane() {
  const { data: runtimes, isPending, isError, error, refetch } = useJavaRuntimes()
  const s = useSettings()
  const update = useUpdateSettings()
  const highlighted = useRowHighlight('runtimes')

  return (
    <Form className="max-w-[720px]">
      <FormSection
        title="Installed Runtimes"
        action={
          <div className="flex items-center gap-1">
            <IconButton
              label="Refresh"
              size="sm"
              onClick={() => {
                // TODO(wire): api.java.refresh() — re-scans the system.
                refetch()
              }}
            >
              <RefreshCw />
            </IconButton>
            <Menu
              align="end"
              trigger={
                <Button size="sm">
                  Download Java… <ChevronDown className="!size-3" />
                </Button>
              }
              items={[8, 17, 21, 25].map((major) => ({ label: `Java ${major}`, onSelect: () => download(major) }))}
            />
          </div>
        }
        footer="Managed runtimes were downloaded by Amethyst and can be removed. Others can be forgotten; their files stay where they are."
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
                  <th className="w-[84px] px-2 py-1.5 font-medium">Arch</th>
                  <th className="px-2 py-1.5 font-medium">Path</th>
                  <th className="w-[76px] px-2 py-1.5 font-medium">Source</th>
                  <th className="w-[36px] px-1 py-1.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runtimes.map((r, i) => (
                  <tr key={r.id} className={cn('h-8', i % 2 === 1 && 'bg-row-alt')}>
                    <td className="px-2.5 tabular">{r.version}</td>
                    <td className="truncate px-2 text-label-2">{r.vendor}</td>
                    <td className="px-2">
                      {r.arch === 'x86_64' ? (
                        <Badge tone="warning" title="Runs under Rosetta">
                          <AlertTriangle /> x86_64
                        </Badge>
                      ) : (
                        <span className="text-label-2">arm64</span>
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
                          { label: 'Show in Finder', onSelect: () => notYetAvailable('Show in Finder') },
                          { kind: 'separator' },
                          r.source === 'managed'
                            ? { label: 'Move to Trash…', destructive: true, onSelect: () => notYetAvailable('Removing runtimes') }
                            : { label: 'Forget', onSelect: () => notYetAvailable('Forgetting runtimes') },
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

      <FormSection>
        <SettingRow row="auto-java" label="Automatically download required Java" description="Each Minecraft version gets the Java it needs, natively on Apple silicon." htmlFor="set-auto-java">
          <Switch id="set-auto-java" checked={s.autoJava} onCheckedChange={(autoJava) => update({ autoJava })} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/** Settings → Game Defaults (B7.5): what every instance inherits. */
export function GamePane() {
  const s = useSettings()
  const update = useUpdateSettings()
  const { memory, resolution } = s
  const memError = !memory.auto && memory.minMb > memory.maxMb ? 'Minimum memory can’t be more than maximum.' : undefined

  return (
    <Form>
      <FormSection title="Memory" footer={memError ? <span className="text-red">{memError}</span> : 'Automatic picks a size based on the instance and this Mac’s memory.'}>
        <SettingRow row="memory" label="Automatic" htmlFor="set-mem-auto">
          <Switch id="set-mem-auto" checked={memory.auto} onCheckedChange={(auto) => update({ memory: { ...memory, auto } })} />
        </SettingRow>
        {!memory.auto && (
          <>
            <SettingRow row="memory-min" label="Minimum">
              <Stepper aria-label="Minimum memory" unit="MB" value={memory.minMb} min={512} max={65536} step={256} onValueChange={(minMb) => update({ memory: { ...memory, minMb } })} />
            </SettingRow>
            <SettingRow row="memory-max" label="Maximum">
              <Stepper aria-label="Maximum memory" unit="MB" value={memory.maxMb} min={512} max={65536} step={256} onValueChange={(maxMb) => update({ memory: { ...memory, maxMb } })} />
            </SettingRow>
          </>
        )}
      </FormSection>

      <FormSection title="Window">
        <SettingRow row="resolution" label="Resolution">
          <div className="flex items-center gap-1.5">
            <Stepper
              aria-label="Width"
              value={resolution.width}
              min={320}
              max={7680}
              step={2}
              disabled={resolution.fullscreen}
              onValueChange={(width) => update({ resolution: { ...resolution, width } })}
              width={60}
            />
            <span className="text-label-2">×</span>
            <Stepper
              aria-label="Height"
              value={resolution.height}
              min={240}
              max={4320}
              step={2}
              disabled={resolution.fullscreen}
              onValueChange={(height) => update({ resolution: { ...resolution, height } })}
              width={60}
            />
          </div>
        </SettingRow>
        <SettingRow row="fullscreen" label="Fullscreen">
          <Checkbox aria-label="Fullscreen" checked={resolution.fullscreen} onCheckedChange={(fullscreen) => update({ resolution: { ...resolution, fullscreen } })} />
        </SettingRow>
      </FormSection>

      <FormSection title="Arguments" footer="Instances inherit these unless they override them in their own Settings tab.">
        <SettingRow row="jvm-args" label="JVM arguments" stacked>
          <TextField aria-label="JVM arguments" monospace placeholder="-XX:+UseG1GC" value={s.jvmArgs} onChange={(e) => update({ jvmArgs: e.target.value })} />
        </SettingRow>
        <SettingRow row="game-args" label="Game arguments" stacked>
          <TextField aria-label="Game arguments" monospace placeholder="--quickPlaySingleplayer World" value={s.gameArgs} onChange={(e) => update({ gameArgs: e.target.value })} />
        </SettingRow>
        <SettingRow row="wrapper" label="Wrapper command" description="Runs before Java, e.g. a profiler." stacked>
          <TextField aria-label="Wrapper command" monospace placeholder="/usr/bin/time" value={s.wrapper} onChange={(e) => update({ wrapper: e.target.value })} />
        </SettingRow>
      </FormSection>

      <FormSection
        title="Environment Variables"
        action={
          <Button size="sm" icon={<Plus />} onClick={() => update({ env: [...s.env, { key: '', value: '' }] })}>
            Add
          </Button>
        }
      >
        <div id="row-env">
          {s.env.length === 0 ? (
            <p className="px-2.5 py-3 text-small text-label-2">No variables. Instances inherit the launcher’s environment.</p>
          ) : (
            s.env.map((v, i) => (
              // Rows have no identity beyond their position; keys are stable while editing.
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="flex items-center gap-2 border-b border-separator px-2.5 py-1.5 last:border-0">
                <TextField
                  aria-label={`Variable ${i + 1} name`}
                  monospace
                  placeholder="NAME"
                  value={v.key}
                  onChange={(e) => update({ env: s.env.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                  className="w-[180px]"
                />
                <span className="text-label-3">=</span>
                <TextField
                  aria-label={`Variable ${i + 1} value`}
                  monospace
                  placeholder="value"
                  value={v.value}
                  onChange={(e) => update({ env: s.env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  className="flex-1"
                />
                <IconButton label={`Remove ${v.key || 'variable'}`} size="sm" onClick={() => update({ env: s.env.filter((_, j) => j !== i) })}>
                  <X />
                </IconButton>
              </div>
            ))
          )}
        </div>
      </FormSection>
    </Form>
  )
}
