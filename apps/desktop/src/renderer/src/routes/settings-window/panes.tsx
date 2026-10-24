import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, EmptyState, Form, FormSection, Spinner, Stepper, Switch, TextField, toast } from '@/ui'
import { api } from '@/lib/rpc'
import { errorDetails, errorText, toastError } from '@/lib/error-messages'
import { openDataFolder, openExternal } from '@/app/commands'
import { copyToClipboard } from '@/app/clipboard'
import { SETTINGS_PANES, type SettingsPaneId } from '@/app/settings-index'
import { patchSettings, useAppSettings, useDataPaths, useResetSettings, useSettings, useUpdateSettings } from '@/data/settings'
import { updaterActions, useAppInfo, useUpdaterState } from '@/data/updater'
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
  const view = useSettings()
  const updateView = useUpdateSettings()
  const s = useAppSettings()
  const paths = useDataPaths()
  return (
    <Form>
      <FormSection>
        <SettingRow row="appearance" label="Appearance" stacked>
          <ModePicker value={view.appearance} onValueChange={(appearance) => updateView({ appearance })} />
        </SettingRow>
        <SettingRow row="accent" label="Accent colour">
          <AccentPicker value={view.accent} onValueChange={(accent) => updateView({ accent })} />
        </SettingRow>
      </FormSection>

      <FormSection title="Launching">
        <SettingRow row="hide-launcher" label="Hide launcher while playing" description="Amethyst comes back when the game quits. Click the Dock icon to show it sooner." htmlFor="set-hide">
          <Switch id="set-hide" checked={s.game.hideLauncherWhileRunning} onCheckedChange={(v) => void patchSettings({ game: { hideLauncherWhileRunning: v } })} />
        </SettingRow>
        <SettingRow row="open-log" label="Open the log when the game starts" htmlFor="set-open-log">
          <Switch id="set-open-log" checked={s.game.openLogOnStart} onCheckedChange={(v) => void patchSettings({ game: { openLogOnStart: v } })} />
        </SettingRow>
        <SettingRow row="check-problems" label="Check files before launch" description="Verifies game files first. Turning it off launches faster." htmlFor="set-check">
          <Switch id="set-check" checked={!s.game.skipVerification} onCheckedChange={(v) => void patchSettings({ game: { skipVerification: !v } })} />
        </SettingRow>
      </FormSection>

      <FormSection title="World Backups" footer="Backups are zips in the backups folder. Manual backups are never removed.">
        <SettingRow row="backups" label="Back up worlds before version and modpack changes" htmlFor="set-backups">
          <Switch id="set-backups" checked={s.backups.automatic} onCheckedChange={(v) => void patchSettings({ backups: { automatic: v } })} />
        </SettingRow>
        <SettingRow row="backups-keep" label="Automatic backups to keep per world">
          <Stepper aria-label="Automatic backups to keep" value={s.backups.keep} min={1} max={100} onValueChange={(keep) => void patchSettings({ backups: { keep } })} width={52} />
        </SettingRow>
      </FormSection>

      <FormSection title="Data">
        <SettingRow
          row="data-location"
          label="Data location"
          description={<span className="selectable font-mono text-small">{paths.data?.dataRoot ?? (paths.isError ? errorText(paths.error) : '…')}</span>}
        >
          <Button disabled={!paths.data} onClick={() => void openDataFolder('dataRoot')}>
            Show in Finder
          </Button>
        </SettingRow>
      </FormSection>

      <FormSection>
        <SettingRow row="streamer" label="Streamer mode" description="Hides usernames and email addresses everywhere in Amethyst." htmlFor="set-streamer">
          <Switch id="set-streamer" checked={s.general.streamerMode} onCheckedChange={(v) => void patchSettings({ general: { streamerMode: v } })} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

function NetworkPane() {
  const s = useAppSettings()
  const [proxyError, setProxyError] = useState<string>()
  const saveProxy = async (url: string) => {
    const next = await patchSettingsQuiet({ network: { proxyUrl: url.trim() } })
    setProxyError(next)
  }
  return (
    <Form>
      <FormSection title="Proxy" footer="Used for downloads and the Modrinth, CurseForge and Mojang APIs. The game itself connects directly.">
        <SettingRow row="proxy" label="Use a proxy" htmlFor="set-proxy">
          <Switch id="set-proxy" checked={s.network.proxyEnabled} onCheckedChange={(v) => void patchSettings({ network: { proxyEnabled: v } })} />
        </SettingRow>
        {s.network.proxyEnabled && (
          <SettingRow row="proxy-url" label="Proxy server" stacked>
            <TextField
              key={s.network.proxyUrl}
              aria-label="Proxy server"
              monospace
              placeholder="http://proxy.example.com:8080"
              defaultValue={s.network.proxyUrl}
              error={proxyError ?? (!s.network.proxyUrl ? 'Enter a proxy address, or turn the proxy off.' : undefined)}
              onBlur={(e) => e.target.value.trim() !== s.network.proxyUrl && void saveProxy(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full"
            />
          </SettingRow>
        )}
      </FormSection>
      <FormSection title="Downloads">
        <SettingRow row="downloads" label="Maximum concurrent downloads" description="Per server. Lower this on slow or metered connections.">
          <Stepper aria-label="Maximum concurrent downloads" value={s.network.maxConnectionsPerHost} min={1} max={64} onValueChange={(v) => void patchSettings({ network: { maxConnectionsPerHost: v } })} width={52} />
        </SettingRow>
        <SettingRow row="api-connections" label="Maximum concurrent API requests" description="Modrinth, CurseForge and Mojang.">
          <Stepper aria-label="Maximum concurrent API requests" value={s.network.maxApiConnections} min={1} max={32} onValueChange={(v) => void patchSettings({ network: { maxApiConnections: v } })} width={52} />
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/** Patch and return an inline error (for fields) instead of a toast. */
async function patchSettingsQuiet(patch: Parameters<typeof patchSettings>[0]): Promise<string | undefined> {
  try {
    await api.settings.patch(patch)
    return undefined
  } catch (e) {
    const keys = errorDetails(e).keys
    return Array.isArray(keys) && keys.length ? 'That address isn’t valid. Use scheme://host:port.' : errorText(e)
  }
}

/* ------------------------------------------------------------------------------------------ */

export function PrivacyToggles() {
  const s = useAppSettings()
  const consent = { usage: s.privacy.usageData, crashes: s.privacy.crashReports }
  const set = (next: typeof consent) =>
    api.telemetry.setConsent(next).then(
      () => toast({ kind: 'success', title: next.usage || next.crashes ? 'Thanks for helping improve Amethyst' : 'Nothing will be sent', duration: 3000 }),
      (e: unknown) => toastError(e, 'Couldn’t change the privacy setting'),
    )
  return (
    <>
      <SettingRow row="usage" label="Share usage data" description={USAGE_COPY} htmlFor="set-usage">
        <Switch id="set-usage" checked={consent.usage} onCheckedChange={(usage) => void set({ ...consent, usage })} />
      </SettingRow>
      <SettingRow row="crashes" label="Send crash reports" description={`${CRASH_COPY} Covers launcher crashes only.`} htmlFor="set-crashes">
        <Switch id="set-crashes" checked={consent.crashes} onCheckedChange={(crashes) => void set({ ...consent, crashes })} />
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

const RELEASES_URL = 'https://github.com/wynn-dev/amethyst/releases/tag/nightly'

function UpdatesPane() {
  const { data: info } = useAppInfo()
  const state = useUpdaterState()
  const version = info?.version ?? '—'
  const dev = version.startsWith('0.0.0')
  const line =
    state.status === 'checking' ? (
      <span className="flex items-center gap-1.5">
        <Spinner size={11} /> Checking for updates…
      </span>
    ) : state.status === 'downloading' ? (
      `Downloading ${state.version ?? 'the update'}… ${state.percent}%`
    ) : state.status === 'ready' ? (
      `${state.version} is ready. Restart to update.`
    ) : state.status === 'error' ? (
      <span className="text-red">Couldn’t check or download the update: {state.message}</span>
    ) : dev ? (
      'Updates are off in development builds.'
    ) : (
      'Amethyst is up to date.'
    )
  return (
    <Form>
      <FormSection footer="Updates come from the nightly release. They download in the background and install when you restart or quit.">
        <SettingRow row="update-status" label={`Amethyst ${version}`} description={<span data-updater-status={state.status}>{line}</span>}>
          <Button onClick={() => openExternal(RELEASES_URL)}>Release Notes…</Button>
          {state.status === 'ready' ? (
            <Button variant="primary" onClick={() => void updaterActions.restart()}>
              Restart to Update
            </Button>
          ) : (
            <Button disabled={state.status === 'checking' || state.status === 'downloading'} onClick={() => void updaterActions.check()}>
              {state.status === 'error' ? 'Retry' : 'Check Now'}
            </Button>
          )}
        </SettingRow>
      </FormSection>
    </Form>
  )
}

/* ------------------------------------------------------------------------------------------ */

function AdvancedPane() {
  const s = useAppSettings()
  const { data: info } = useAppInfo()
  const reset = useResetSettings()
  const [confirmReset, setConfirmReset] = useState(false)
  const ping = useQuery({ queryKey: ['runtime', 'ping'], queryFn: () => api.runtime.ping(), staleTime: 0 })

  const copyDiagnostics = () => {
    const diag = {
      app: info?.version ?? 'unknown',
      electron: info?.electron,
      chrome: info?.chrome,
      node: info?.node,
      arch: 'arm64',
      os: navigator.userAgent.match(/Mac OS X [\d_]+/)?.[0]?.replace(/_/g, '.') ?? 'macOS',
      runtime: ping.data ? { bootMs: ping.data.bootMs, uptimeMs: ping.data.uptimeMs, rssMB: Math.round(ping.data.memoryRss / 1048576), index: ping.data.index } : 'unavailable',
      developerMode: s.general.developerMode,
    }
    copyToClipboard(JSON.stringify(diag, null, 2), 'Copied diagnostic info')
  }

  return (
    <Form>
      <FormSection>
        <SettingRow row="developer" label="Developer mode" description="Shows raw error details and allows offline accounts without a Microsoft account." htmlFor="set-dev">
          <Switch id="set-dev" checked={s.general.developerMode} onCheckedChange={(v) => void patchSettings({ general: { developerMode: v } })} />
        </SettingRow>
        <SettingRow row="logs" label="Launcher logs">
          <Button onClick={() => void openDataFolder('logs')}>Open Logs Folder</Button>
        </SettingRow>
        <SettingRow row="diagnostics" label="Diagnostic info" description="Versions, macOS, architecture and background service health, copied as JSON.">
          <Button onClick={copyDiagnostics}>Copy</Button>
        </SettingRow>
        {s.general.developerMode && ping.data && (
          <SettingRow
            row="runtime"
            label="Background service"
            description={`pid ${ping.data.pid} · booted in ${ping.data.bootMs} ms · ${Math.round(ping.data.memoryRss / 1048576)} MB · index ${ping.data.index.ok ? `v${ping.data.index.schemaVersion}` : `unavailable (${ping.data.index.error})`}`}
          />
        )}
      </FormSection>
      <FormSection title="Settings">
        <SettingRow row="reset" label="Reset all settings" description="Instances, accounts and worlds are not affected.">
          <Button variant="push" className="text-red" onClick={() => setConfirmReset(true)} disabled={reset.isPending}>
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
        onConfirm={() => reset.mutate(undefined, { onSuccess: () => toast({ kind: 'success', title: 'Settings were reset' }) })}
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
        {info && <p className="selectable mt-0.5 text-small text-label-3">Electron {info.electron} · Chromium {info.chrome} · Node {info.node}</p>}
        <p className="mt-3 max-w-[380px] text-small text-label-2">
          Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
        </p>
      </div>
      <FormSection title="Licence">
        <SettingRow row="licence" label="GNU General Public License v3.0" description="Amethyst is free software. You can redistribute and modify it under the terms of the GPL-3.0.">
          <Button onClick={() => openExternal('https://www.gnu.org/licenses/gpl-3.0.html')}>View</Button>
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
