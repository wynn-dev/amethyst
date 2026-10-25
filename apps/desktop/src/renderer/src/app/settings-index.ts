import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { patchSettings, updateViewSettings, type AppSettings, type Settings, type SettingsPatch } from '@/data/settings'

/** Settings window panes, in sidebar order (B7). */
export const SETTINGS_PANES = [
  { id: 'general', title: 'General' },
  { id: 'accounts', title: 'Accounts' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'java', title: 'Java' },
  { id: 'game', title: 'Game Defaults' },
  { id: 'network', title: 'Network' },
  { id: 'privacy', title: 'Privacy' },
  { id: 'updates', title: 'Updates' },
  { id: 'advanced', title: 'Advanced' },
  { id: 'about', title: 'About' },
] as const

export type SettingsPaneId = (typeof SETTINGS_PANES)[number]['id']

/** What toggling a setting does: a runtime settings patch, a local view preference, or a consent change. */
export type ToggleAction = { settings: SettingsPatch } | { view: Partial<Settings> } | { consent: { usage: boolean; crashes: boolean } }

/** Settings as the toggles read them: the runtime settings plus the appearance view. */
export interface ToggleSource {
  app: AppSettings
  view: Settings
}

export interface SettingsRowIndex {
  pane: SettingsPaneId
  /** Row anchor id inside the pane. */
  row: string
  title: string
  keywords?: string[]
  /** Boolean settings can be toggled inline from the palette with Space. */
  toggle?: { get: (s: ToggleSource) => boolean; action: (s: ToggleSource, on: boolean) => ToggleAction }
}

/** Apply a toggle from the palette. Consent goes through telemetry (it applies immediately). */
export function applyToggle(action: ToggleAction): void {
  if ('settings' in action) void patchSettings(action.settings)
  else if ('view' in action) updateViewSettings(action.view)
  else void api.telemetry.setConsent(action.consent).catch((e: unknown) => toastError(e, 'Couldn’t change the privacy setting'))
}

const consent = (s: ToggleSource) => ({ usage: s.app.privacy.usageData, crashes: s.app.privacy.crashReports })

/**
 * Searchable index of settings rows, shared by the Settings window search field and the command
 * palette's Settings group, so both deep-link to the same rows.
 */
export const SETTINGS_INDEX: SettingsRowIndex[] = [
  { pane: 'general', row: 'appearance', title: 'Appearance', keywords: ['dark mode', 'light mode', 'theme'] },
  {
    pane: 'general',
    row: 'hide-launcher',
    title: 'Hide launcher while playing',
    keywords: ['when the game launches'],
    toggle: { get: (s) => s.app.game.hideLauncherWhileRunning, action: (_, on) => ({ settings: { game: { hideLauncherWhileRunning: on } } }) },
  },
  {
    pane: 'general',
    row: 'open-log',
    title: 'Open the log when the game starts',
    keywords: ['log window', 'console'],
    toggle: { get: (s) => s.app.game.openLogOnStart, action: (_, on) => ({ settings: { game: { openLogOnStart: on } } }) },
  },
  {
    pane: 'general',
    row: 'check-problems',
    title: 'Check files before launch',
    keywords: ['fast launch', 'verify'],
    toggle: { get: (s) => !s.app.game.skipVerification, action: (_, on) => ({ settings: { game: { skipVerification: !on } } }) },
  },
  { pane: 'general', row: 'data-location', title: 'Data location', keywords: ['folder', 'path'] },
  {
    pane: 'general',
    row: 'streamer',
    title: 'Streamer mode',
    keywords: ['hide usernames'],
    toggle: { get: (s) => s.app.general.streamerMode, action: (_, on) => ({ settings: { general: { streamerMode: on } } }) },
  },
  {
    pane: 'general',
    row: 'backups',
    title: 'Back up worlds automatically',
    keywords: ['backup', 'version change'],
    toggle: { get: (s) => s.app.backups.automatic, action: (_, on) => ({ settings: { backups: { automatic: on } } }) },
  },
  { pane: 'accounts', row: 'accounts', title: 'Accounts', keywords: ['microsoft', 'offline', 'sign in'] },
  { pane: 'accounts', row: 'skin', title: 'Skin and cape', keywords: ['skin', 'cape'] },
  { pane: 'appearance', row: 'mode', title: 'Appearance mode', keywords: ['dark', 'light', 'system'] },
  { pane: 'appearance', row: 'accent', title: 'Accent colour', keywords: ['color', 'colour'] },
  {
    pane: 'appearance',
    row: 'translucent',
    title: 'Translucent sidebar',
    keywords: ['vibrancy', 'transparency'],
    toggle: { get: (s) => s.app.appearance.vibrancy, action: (_, on) => ({ settings: { appearance: { vibrancy: on } } }) },
  },
  { pane: 'appearance', row: 'background', title: 'Background image or video', keywords: ['wallpaper', 'blur', 'dim'] },
  { pane: 'java', row: 'runtimes', title: 'Installed Java runtimes', keywords: ['jdk', 'jre'] },
  { pane: 'java', row: 'java-policy', title: 'Java selection', keywords: ['automatic', 'prefer installed', 'custom java'] },
  { pane: 'game', row: 'memory', title: 'Memory', keywords: ['ram', 'heap', 'xmx'] },
  { pane: 'game', row: 'resolution', title: 'Resolution', keywords: ['window size', 'fullscreen'] },
  { pane: 'game', row: 'jvm-args', title: 'JVM arguments' },
  { pane: 'game', row: 'game-args', title: 'Game arguments' },
  { pane: 'game', row: 'wrapper', title: 'Wrapper command', keywords: ['prepend'] },
  { pane: 'game', row: 'prelaunch', title: 'Pre-launch command' },
  { pane: 'game', row: 'env', title: 'Environment variables' },
  { pane: 'game', row: 'natives', title: 'Apple silicon native libraries', keywords: ['arm64', 'lwjgl', 'rosetta'] },
  { pane: 'network', row: 'proxy', title: 'Proxy' },
  { pane: 'network', row: 'downloads', title: 'Maximum concurrent downloads' },
  {
    pane: 'privacy',
    row: 'usage',
    title: 'Share usage data',
    keywords: ['telemetry', 'analytics'],
    toggle: { get: (s) => s.app.privacy.usageData, action: (s, on) => ({ consent: { ...consent(s), usage: on } }) },
  },
  {
    pane: 'privacy',
    row: 'crashes',
    title: 'Send crash reports',
    keywords: ['telemetry', 'errors'],
    toggle: { get: (s) => s.app.privacy.crashReports, action: (s, on) => ({ consent: { ...consent(s), crashes: on } }) },
  },
  { pane: 'updates', row: 'update-status', title: 'Check for updates', keywords: ['restart to update', 'nightly'] },
  {
    pane: 'advanced',
    row: 'developer',
    title: 'Developer mode',
    keywords: ['verbose logs', 'debug'],
    toggle: { get: (s) => s.app.general.developerMode, action: (_, on) => ({ settings: { general: { developerMode: on } } }) },
  },
  { pane: 'advanced', row: 'diagnostics', title: 'Copy diagnostic info' },
  { pane: 'advanced', row: 'reset', title: 'Reset all settings' },
  { pane: 'about', row: 'version', title: 'About Amethyst', keywords: ['version', 'licence', 'license'] },
]
