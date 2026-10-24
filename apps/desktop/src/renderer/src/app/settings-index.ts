import type { Settings } from '@/data/settings'

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

export interface SettingsRowIndex {
  pane: SettingsPaneId
  /** Row anchor id inside the pane. */
  row: string
  title: string
  keywords?: string[]
  /** Boolean settings can be toggled inline from the palette with Space. */
  toggle?: { get: (s: Settings) => boolean; patch: (s: Settings, on: boolean) => Partial<Settings> }
}

/**
 * Searchable index of settings rows, shared by the Settings window search field and the command
 * palette's Settings group, so both deep-link to the same rows.
 */
export const SETTINGS_INDEX: SettingsRowIndex[] = [
  { pane: 'general', row: 'appearance', title: 'Appearance', keywords: ['dark mode', 'light mode', 'theme'] },
  { pane: 'general', row: 'on-launch', title: 'When the game launches', keywords: ['hide launcher', 'quit'] },
  {
    pane: 'general',
    row: 'open-log',
    title: 'Open log window on launch',
    toggle: { get: (s) => s.openLogOnLaunch, patch: (_, on) => ({ openLogOnLaunch: on }) },
  },
  {
    pane: 'general',
    row: 'check-problems',
    title: 'Check for problems before launch',
    keywords: ['fast launch'],
    toggle: { get: (s) => s.checkBeforeLaunch, patch: (_, on) => ({ checkBeforeLaunch: on }) },
  },
  { pane: 'general', row: 'data-location', title: 'Data location', keywords: ['folder', 'path'] },
  {
    pane: 'general',
    row: 'streamer',
    title: 'Streamer mode',
    keywords: ['hide usernames'],
    toggle: { get: (s) => s.streamerMode, patch: (_, on) => ({ streamerMode: on }) },
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
  },
  { pane: 'appearance', row: 'background', title: 'Background image or video', keywords: ['wallpaper', 'blur', 'dim'] },
  { pane: 'java', row: 'runtimes', title: 'Installed Java runtimes', keywords: ['jdk', 'jre'] },
  {
    pane: 'java',
    row: 'auto-java',
    title: 'Automatically download required Java',
    toggle: { get: (s) => s.autoJava, patch: (_, on) => ({ autoJava: on }) },
  },
  { pane: 'game', row: 'memory', title: 'Memory', keywords: ['ram', 'heap', 'xmx'] },
  { pane: 'game', row: 'resolution', title: 'Resolution', keywords: ['window size', 'fullscreen'] },
  { pane: 'game', row: 'jvm-args', title: 'JVM arguments' },
  { pane: 'game', row: 'game-args', title: 'Game arguments' },
  { pane: 'game', row: 'wrapper', title: 'Wrapper command', keywords: ['prepend'] },
  { pane: 'game', row: 'env', title: 'Environment variables' },
  { pane: 'network', row: 'proxy', title: 'Proxy' },
  { pane: 'network', row: 'downloads', title: 'Maximum concurrent downloads' },
  {
    pane: 'privacy',
    row: 'usage',
    title: 'Share usage data',
    keywords: ['telemetry', 'analytics'],
    toggle: { get: (s) => s.telemetry.usage, patch: (s, on) => ({ telemetry: { ...s.telemetry, usage: on } }) },
  },
  {
    pane: 'privacy',
    row: 'crashes',
    title: 'Send crash reports',
    keywords: ['telemetry', 'errors'],
    toggle: { get: (s) => s.telemetry.crashes, patch: (s, on) => ({ telemetry: { ...s.telemetry, crashes: on } }) },
  },
  {
    pane: 'updates',
    row: 'auto-update',
    title: 'Automatically download updates',
    toggle: { get: (s) => s.updates.auto, patch: (s, on) => ({ updates: { ...s.updates, auto: on } }) },
  },
  { pane: 'updates', row: 'channel', title: 'Update channel', keywords: ['beta', 'stable', 'nightly'] },
  {
    pane: 'advanced',
    row: 'developer',
    title: 'Developer mode',
    keywords: ['verbose logs', 'debug'],
    toggle: { get: (s) => s.developerMode, patch: (_, on) => ({ developerMode: on }) },
  },
  { pane: 'advanced', row: 'diagnostics', title: 'Copy diagnostic info' },
  { pane: 'advanced', row: 'reset', title: 'Reset all settings' },
  { pane: 'about', row: 'version', title: 'About Amethyst', keywords: ['version', 'licence', 'license'] },
]
