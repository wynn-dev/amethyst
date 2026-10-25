import { useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Settings as AppSettings, SettingsPatch, ThemeMode } from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { queryClient } from './query'

export type { AppSettings, SettingsPatch }

export const settingsKey = ['settings'] as const

/**
 * Defaults mirrored from the runtime's settings schema. Only used as a placeholder for the very
 * first paint of a fresh install (afterwards the last known settings are cached locally), so the
 * UI never waits on the runtime to render.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: { developerMode: false, streamerMode: false, commandPaletteShortcut: '' },
  appearance: {
    theme: 'system',
    accentColor: '#9b5de5',
    background: { kind: 'none', file: null, fit: 'cover', blur: 0, overlay: true },
    blur: { card: 20, sidebar: 4 },
    vibrancy: true,
  },
  game: {
    java: { policy: 'auto', path: '' },
    memory: { mode: 'unassigned', minMB: 0, maxMB: 0 },
    jvmArgs: [],
    gameArgs: [],
    env: {},
    wrapperCommand: '',
    preLaunchCommand: '',
    resolution: { width: 0, height: 0, fullscreen: false },
    skipVerification: false,
    hideLauncherWhileRunning: true,
    openLogOnStart: false,
    replaceArm64Natives: 'legacy-only',
  },
  network: { proxyEnabled: false, proxyUrl: '', maxConnectionsPerHost: 16, maxApiConnections: 8 },
  updates: { autoDownload: false, installOnQuit: false, includePrereleases: false },
  privacy: { usageData: false, crashReports: false, prompted: false },
  backups: { automatic: true, keep: 5 },
}

const SNAPSHOT_KEY = 'amethyst:settings-snapshot'

function readSnapshot(): AppSettings | undefined {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    return raw ? (JSON.parse(raw) as AppSettings) : undefined
  } catch {
    return undefined
  }
}

function writeSnapshot(s: AppSettings) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s))
  } catch {
    // Storage full or unavailable: the snapshot is only a first-paint optimisation.
  }
}

/** Deep-merge a settings patch (a `null` leaf is left to the runtime, which resets it). */
function applyPatch<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (patch === null ? base : patch) as T
  }
  const out = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = applyPatch(out[k], v)
  return out as T
}

/** Fetch the real settings. Keeps the local first-paint snapshot fresh. */
async function fetchSettings(): Promise<AppSettings> {
  const s = await api.settings.get()
  writeSnapshot(s)
  return s
}

export const settingsQuery = { queryKey: settingsKey, queryFn: fetchSettings }

/** The launcher settings from the runtime (`api.settings.get`), refreshed by `settings:changed`. */
export function useAppSettings(): AppSettings {
  const { data } = useQuery({ ...settingsQuery, placeholderData: () => readSnapshot() ?? DEFAULT_APP_SETTINGS })
  return data ?? DEFAULT_APP_SETTINGS
}

/** True once the real settings arrived (not the placeholder). */
export function useSettingsLoaded(): boolean {
  const q = useQuery({ ...settingsQuery })
  return q.isSuccess && !q.isPlaceholderData
}

/** Apply a settings patch: optimistic, persisted by the runtime, rolled back with a toast on error. */
export async function patchSettings(patch: SettingsPatch): Promise<AppSettings | undefined> {
  const before = queryClient.getQueryData<AppSettings>(settingsKey)
  if (before) queryClient.setQueryData<AppSettings>(settingsKey, applyPatch(before, patch))
  let next: AppSettings
  try {
    next = await api.settings.patch(patch)
  } catch (e) {
    if (before) queryClient.setQueryData(settingsKey, before)
    toastError(e, 'Couldn’t save the setting')
    return undefined
  }
  queryClient.setQueryData(settingsKey, next)
  writeSnapshot(next)
  return next
}

export function usePatchSettings() {
  return patchSettings
}

/** Reset every setting to its default (accounts and instances are kept). */
export function useResetSettings() {
  return useMutation({
    mutationFn: () => api.settings.reset(),
    onSuccess: (s) => {
      queryClient.setQueryData(settingsKey, s)
      writeSnapshot(s)
    },
    onError: (e) => toastError(e, 'Couldn’t reset settings'),
  })
}

/** Where things live on disk. */
export function useDataPaths() {
  return useQuery({ queryKey: ['settings', 'paths'], queryFn: () => api.settings.getPaths() })
}

/** RAM and CPU facts for the memory controls. */
export function useSystemInfo() {
  return useQuery({ queryKey: ['settings', 'system'], queryFn: () => api.settings.getSystemInfo() })
}

/* ------------------------------------------------------------------------------------------ */
/* A small view of the settings for UI code that only needs a few fields                       */
/* ------------------------------------------------------------------------------------------ */

export type Appearance = ThemeMode

/**
 * A flat view of the settings used across the UI. Everything here is backed by the runtime
 * settings; the full appearance group (accent, background, vibrancy) is in `data/appearance.ts`.
 */
export interface Settings {
  appearance: Appearance
  /** `#rrggbb` accent colour. */
  accent: string
  streamerMode: boolean
  developerMode: boolean
}

export function toViewSettings(s: AppSettings): Settings {
  return {
    appearance: s.appearance.theme,
    accent: s.appearance.accentColor.toLowerCase(),
    streamerMode: s.general.streamerMode,
    developerMode: s.general.developerMode,
  }
}

/** The flat settings view (always defined; placeholder until the runtime answers). */
export function useSettings(): Settings {
  const s = useAppSettings()
  return useMemo(() => toViewSettings(s), [s])
}

/** Update view fields through `api.settings.patch`. */
export function updateViewSettings(patch: Partial<Settings>): void {
  const p: SettingsPatch = {}
  if (patch.appearance) p.appearance = { ...p.appearance, theme: patch.appearance }
  if (patch.accent) p.appearance = { ...p.appearance, accentColor: patch.accent }
  if (patch.streamerMode !== undefined) p.general = { ...p.general, streamerMode: patch.streamerMode }
  if (patch.developerMode !== undefined) p.general = { ...p.general, developerMode: patch.developerMode }
  if (Object.keys(p).length) void patchSettings(p)
}

export function useUpdateSettings() {
  return updateViewSettings
}
