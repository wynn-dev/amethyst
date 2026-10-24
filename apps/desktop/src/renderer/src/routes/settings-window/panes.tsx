import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { Alert, Button, EmptyState, Form, FormSection, Segmented, Select, Spinner, Stepper, Switch, TextField, toast } from '@/ui'
import { notYetAvailable } from '@/app/commands'
import { SETTINGS_PANES, type SettingsPaneId } from '@/app/settings-index'
import { useAppInfo } from '@/data/misc'
import { useSettings, useSettingsStore, useUpdateSettings, type Settings } from '@/data/settings'
import { CRASH_COPY, USAGE_COPY } from '@/data/privacy'
import { SettingRow } from './context'
import { ModePicker, AccentPicker } from './appearance-pickers'
import { PrivacyDetailsSheet } from './PrivacyDetails'
import { AmethystMark } from './AmethystMark'
import { AccountsPane } from './accounts'
import { AppearancePane } from './appearance'
import { GamePane, JavaPane } from './java-game'

const PANES: Record<SettingsPaneId, () => ReactNode> = {
  general: GeneralPane,
  accounts: AccountsPane,
  appearance: AppearancePane,
  java: JavaPane,
  game: GamePane,
  network: NetworkPane,
  privacy: PrivacyPane,
  updates: UpdatesPane,
  advanced: AdvancedPane,
  about: AboutPane,
}

/** Renders the pane for `/settings/$pane`, and scrolls to / highlights a deep-linked `?row=`. */
export function SettingsPane() {
  const { pane } = useParams({ from: '/settings/$pane' })
  const { row } = useSearch({ from: '/settings/$pane' })
  const navigate = useNavigate({ from: '/settings/$pane' })

  useEffect(() => {
    if (!row) return
    const el = document.getElementById(`row-${row}`)
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    // The highlight is derived from `?row=`; dropping the param fades it out.
    const t = setTimeout(() => navigate({ search: {}, replace: true }), 1800)
    return () => clearTimeout(t)
  }, [row, navigate])

  const Pane = PANES[pane as SettingsPaneId]
  if (!Pane) {
    return (
      <EmptyState
        icon={<Compass />}
        title="This settings pane doesn’t exist"
        description={`There is no “${pane}” pane. Choose one from the sidebar.`}
        actions={
          <Button variant="primary" onClick={() => navigate({ to: '/settings/$pane', params: { pane: SETTINGS_PANES[0].id } })}>
            Go to General
          </Button>
        }
      />
    )
  }
  return <Pane />
}

/* ------------------------------------------------------------------------------------------ */

function GeneralPane() {
  const s = useSettings()
  const update = useUpdateSettings()
  return (
    <Form>
      <FormSection>
        <SettingRow row="appearance" label="Appearance" stacked>
          <ModePicker value={s.appearance} onValueChange={(appearance) => update({ appearance })} />
        </SettingRow>
        <SettingRow row="accent" label="Accent colour">
          <AccentPicker value={s.accent} onValueChange={(accent) => update({ accent })} />
        </SettingRow>
      </FormSection>

      <FormSection title="Launching">
        <SettingRow row="on-launch" label="When the game launches">
          <Select<Settings['onLaunch']>
            aria-label="When the game launches"
            value={s.onLaunch}
            onValueChange={(onLaunch) => update({ onLaunch })}
            options={[
              { value: 'keep', label: 'Keep launcher open' },
              { value: 'hide', label: 'Hide launcher' },
              { value: 'quit', label: 'Quit launcher' },
            ]}
          />
        </SettingRow>
        <SettingRow row="open-log" label="Open log window on launch" htmlFor="set-open-log">
          <Switch id="set-open-log" checked={s.openLogOnLaunch} onCheckedChange={(openLogOnLaunch) => update({ openLogOnLaunch })} />
        </SettingRow>
        <SettingRow
          row="check-problems"
          label="Check for problems before launch"
          description="Verifies Java and game files first. Turning it off launches faster."
          htmlFor="set-check"
        >
          <Switch id="set-check" checked={s.checkBeforeLaunch} onCheckedChange={(checkBeforeLaunch) => update({ checkBeforeLaunch })} />
        </SettingRow>
      </FormSection>

      <FormSection title="Data" footer="Changing the location moves your instances, worlds and downloads. Progress is shown in Activity.">
        <SettingRow row="data-location" label="Data location" description={<span className="selectable font-mono text-small">{s.dataPath}</span>}>
          <Button onClick={() => notYetAvailable('Show in Finder')}>Show in Finder</Button>
          <Button onClick={() => notYetAvailable('Changing the data location')}>Change…</Button>
        </SettingRow>
      </FormSection>

      <FormSection>
        <SettingRow row="streamer" label="Streamer mode" description="Hides usernames and email addresses everywhere in Amethyst." htmlFor="set-streamer">
          <Switch id="set-streamer" checked={s.streamerMode} onCheckedChange={(streamerMode) => update({ streamerMode })} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

function NetworkPane() {
  const s = useSettings()
  const update = useUpdateSettings()
  const proxy = s.proxy
  const hostError = proxy.mode === 'manual' && !proxy.host.trim() ? 'Enter a proxy host.' : undefined
  return (
    <Form>
      <FormSection title="Proxy" footer="System uses the proxy configured in macOS Network settings.">
        <SettingRow row="proxy" label="Proxy">
          <Segmented<Settings['proxy']['mode']>
            aria-label="Proxy"
            value={proxy.mode}
            onValueChange={(mode) => update({ proxy: { ...proxy, mode } })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'none', label: 'None' },
              { value: 'manual', label: 'Manual' },
            ]}
          />
        </SettingRow>
        {proxy.mode === 'manual' && (
          <SettingRow row="proxy-host" label="Server" stacked>
            <div className="flex w-full items-start gap-2">
              <TextField
                aria-label="Proxy host"
                placeholder="proxy.example.com"
                value={proxy.host}
                error={hostError}
                onChange={(e) => update({ proxy: { ...proxy, host: e.target.value } })}
                className="flex-1"
              />
              <Stepper aria-label="Proxy port" value={proxy.port} min={1} max={65535} onValueChange={(port) => update({ proxy: { ...proxy, port } })} />
            </div>
          </SettingRow>
        )}
      </FormSection>
      <FormSection title="Downloads">
        <SettingRow row="downloads" label="Maximum concurrent downloads" description="Lower this on slow or metered connections.">
          <Stepper aria-label="Maximum concurrent downloads" value={s.maxDownloads} min={1} max={64} onValueChange={(maxDownloads) => update({ maxDownloads })} width={52} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

export function PrivacyToggles() {
  const s = useSettings()
  const update = useUpdateSettings()
  return (
    <>
      <SettingRow row="usage" label="Share usage data" description={USAGE_COPY} htmlFor="set-usage">
        <Switch id="set-usage" checked={s.telemetry.usage} onCheckedChange={(usage) => update({ telemetry: { ...s.telemetry, usage } })} />
      </SettingRow>
      <SettingRow row="crashes" label="Send crash reports" description={`${CRASH_COPY} Covers launcher crashes only.`} htmlFor="set-crashes">
        <Switch id="set-crashes" checked={s.telemetry.crashes} onCheckedChange={(crashes) => update({ telemetry: { ...s.telemetry, crashes } })} />
      </SettingRow>
    </>
  )
}

function PrivacyPane() {
  const [details, setDetails] = useState(false)
  return (
    <Form>
      <FormSection
        title="Help improve Amethyst"
        footer={
          <span>
            Both are off unless you turn them on, and changes take effect immediately.{' '}
            <Button variant="link" onClick={() => setDetails(true)} className="text-small">
              Learn more…
            </Button>
          </span>
        }
      >
        <PrivacyToggles />
      </FormSection>
      <PrivacyDetailsSheet open={details} onOpenChange={setDetails} />
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

function UpdatesPane() {
  const s = useSettings()
  const update = useUpdateSettings()
  const { data: info } = useAppInfo()
  const [checking, setChecking] = useState(false)
  const version = info?.version ?? '0.0.0'
  // TODO(wire): api.updater.state() → { status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?; progress?; error? }
  // plus subscribe('updater:state'), api.updater.check(), api.updater.restart().
  return (
    <Form>
      <FormSection>
        <SettingRow
          row="version"
          label={`Amethyst ${version}`}
          description={
            <span className="flex items-center gap-1.5">
              {checking ? (
                <>
                  <Spinner size={11} /> Checking for updates…
                </>
              ) : (
                'Amethyst is up to date'
              )}
            </span>
          }
        >
          <Button onClick={() => notYetAvailable('Release notes')}>Release Notes…</Button>
          <Button
            disabled={checking}
            onClick={() => {
              setChecking(true)
              setTimeout(() => setChecking(false), 1200)
            }}
          >
            Check Now
          </Button>
        </SettingRow>
      </FormSection>
      <FormSection footer="Updates download in the background. You choose when to restart.">
        <SettingRow row="auto-update" label="Automatically download updates" htmlFor="set-auto-update">
          <Switch id="set-auto-update" checked={s.updates.auto} onCheckedChange={(auto) => update({ updates: { ...s.updates, auto } })} />
        </SettingRow>
        <SettingRow row="channel" label="Channel" description={s.updates.channel === 'beta' ? 'Beta builds come from every change to main and may be unstable.' : undefined}>
          <Segmented<Settings['updates']['channel']>
            aria-label="Update channel"
            value={s.updates.channel}
            onValueChange={(channel) => update({ updates: { ...s.updates, channel } })}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
          />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

function AdvancedPane() {
  const s = useSettings()
  const update = useUpdateSettings()
  const { data: info } = useAppInfo()
  const [confirmReset, setConfirmReset] = useState(false)

  const copyDiagnostics = () => {
    const diag = {
      app: info?.version ?? 'unknown',
      electron: info?.electron,
      chrome: info?.chrome,
      node: info?.node,
      platform: navigator.platform,
      arch: 'arm64',
      userAgent: navigator.userAgent,
    }
    navigator.clipboard?.writeText(JSON.stringify(diag, null, 2))
    toast({ kind: 'success', title: 'Copied diagnostic info', message: 'Paste it into your issue report.' })
  }

  return (
    <Form>
      <FormSection>
        <SettingRow row="developer" label="Developer mode" description="Turns on verbose logs and a debug info panel." htmlFor="set-dev">
          <Switch id="set-dev" checked={s.developerMode} onCheckedChange={(developerMode) => update({ developerMode })} />
        </SettingRow>
        <SettingRow row="logs" label="Launcher logs">
          <Button onClick={() => notYetAvailable('Open Launcher Logs')}>Open Logs Folder</Button>
        </SettingRow>
        <SettingRow row="diagnostics" label="Diagnostic info" description="Versions, macOS and architecture, copied as JSON.">
          <Button onClick={copyDiagnostics}>Copy</Button>
        </SettingRow>
      </FormSection>
      <FormSection title="Settings">
        <SettingRow row="export" label="Export or import settings" description="Includes appearance, game defaults and network settings, never accounts.">
          <Button onClick={() => notYetAvailable('Import Settings')}>Import…</Button>
          <Button onClick={() => notYetAvailable('Export Settings')}>Export…</Button>
        </SettingRow>
        <SettingRow row="reset" label="Reset all settings" description="Instances, accounts and worlds are not affected.">
          <Button variant="push" className="text-red" onClick={() => setConfirmReset(true)}>
            Reset…
          </Button>
        </SettingRow>
      </FormSection>
      <Alert
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset all settings?"
        message="Every setting returns to its default. Your instances, accounts and worlds are kept."
        confirmLabel="Reset"
        destructive
        onConfirm={() => {
          useSettingsStore.getState().reset()
          toast({ kind: 'success', title: 'Settings were reset' })
        }}
      />
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

const ACKNOWLEDGEMENTS = ['Electron', 'React', 'Radix UI', 'TanStack Router, Query and Virtual', 'Tailwind CSS', 'Lucide', 'Zustand']

function AboutPane() {
  const { data: info } = useAppInfo()
  return (
    <Form>
      <div id="row-version" className="flex flex-col items-center pt-4 text-center">
        <AmethystMark size={96} />
        <h2 className="mt-3 text-title1 font-semibold">Amethyst</h2>
        <p className="selectable mt-0.5 text-body text-label-2">Version {info?.version ?? '—'}</p>
        <p className="mt-3 max-w-[380px] text-small text-label-2">
          Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
        </p>
      </div>
      <FormSection title="Licence">
        <SettingRow row="licence" label="GNU General Public License v3.0" description="Amethyst is free software. You can redistribute and modify it under the terms of the GPL-3.0.">
          <Button onClick={() => window.open('https://www.gnu.org/licenses/gpl-3.0.html')}>View</Button>
        </SettingRow>
      </FormSection>
      <FormSection title="Acknowledgements" footer="Thanks to the authors of these open-source projects.">
        {ACKNOWLEDGEMENTS.map((a) => (
          <SettingRow key={a} row={`ack-${a}`} label={a} />
        ))}
      </FormSection>
    </Form>
  )
}
