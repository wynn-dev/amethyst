import { useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Settings as AppSettings, SettingsPatch, ThemeMode } from '@shared/services'
import { assetUrl } from '@shared/paths'
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
    vibrancy: false,
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
/* View model for the appearance UI (shared with the Appearance pane and the background layer)  */
/* ------------------------------------------------------------------------------------------ */

export type Appearance = ThemeMode

/**
 * The appearance-centric view of the settings used across the UI. Backed by the runtime settings;
 * the few purely visual preferences the runtime has no field for (sidebar icon size, background
 * dim and volume, the translucent sidebar) are kept per Mac in local storage.
 */
export interface Settings {
  appearance: Appearance
  /** `amethyst` (the default accent) or a `#RRGGBB` swatch colour. */
  accent: string
  translucentSidebar: boolean
  sidebarIconSize: 'small' | 'medium' | 'large'
  background: { kind: 'none' | 'image' | 'video'; url?: string; fit: 'fill' | 'fit'; dim: number; blur: number; volume: number }
  streamerMode: boolean
  developerMode: boolean
}

const DEFAULT_ACCENT = '#9b5de5'

export const ACCENTS: { id: string; label: string; color: string }[] = [
  { id: 'amethyst', label: 'Amethyst', color: '#8b55d6' },
  { id: '#007aff', label: 'Blue', color: '#007aff' },
  { id: '#af52de', label: 'Purple', color: '#af52de' },
  { id: '#ff2d55', label: 'Pink', color: '#ff2d55' },
  { id: '#ff3b30', label: 'Red', color: '#ff3b30' },
  { id: '#ff9500', label: 'Orange', color: '#ff9500' },
  { id: '#e5b000', label: 'Yellow', color: '#e5b000' },
  { id: '#28a745', label: 'Green', color: '#28a745' },
  { id: '#8e8e93', label: 'Graphite', color: '#8e8e93' },
]

interface LocalPrefs {
  translucentSidebar: boolean
  sidebarIconSize: Settings['sidebarIconSize']
  dim: number
  volume: number
}

const useLocalPrefs = create<LocalPrefs & { set: (p: Partial<LocalPrefs>) => void }>()(
  persist((set) => ({ translucentSidebar: true, sidebarIconSize: 'medium', dim: 30, volume: 0, set: (p) => set(p) }), {
    name: 'amethyst:local-prefs',
    version: 1,
  }),
)

// The Settings window and the main window share localStorage; follow the other window's writes.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'amethyst:local-prefs') void useLocalPrefs.persist.rehydrate()
  })
}

export function toViewSettings(s: AppSettings, local: LocalPrefs): Settings {
  const bg = s.appearance.background
  return {
    appearance: s.appearance.theme,
    accent: s.appearance.accentColor.toLowerCase() === DEFAULT_ACCENT ? 'amethyst' : s.appearance.accentColor,
    translucentSidebar: local.translucentSidebar,
    sidebarIconSize: local.sidebarIconSize,
    background: {
      kind: bg.kind,
      url: bg.file ? assetUrl(bg.file) : undefined,
      fit: bg.fit === 'contain' ? 'fit' : 'fill',
      dim: local.dim,
      blur: bg.blur,
      volume: local.volume,
    },
    streamerMode: s.general.streamerMode,
    developerMode: s.general.developerMode,
  }
}

/** The appearance view of the settings (always defined; placeholder until the runtime answers). */
export function useSettings(): Settings {
  const s = useAppSettings()
  const translucentSidebar = useLocalPrefs((p) => p.translucentSidebar)
  const sidebarIconSize = useLocalPrefs((p) => p.sidebarIconSize)
  const dim = useLocalPrefs((p) => p.dim)
  const volume = useLocalPrefs((p) => p.volume)
  return useMemo(() => toViewSettings(s, { translucentSidebar, sidebarIconSize, dim, volume }), [s, translucentSidebar, sidebarIconSize, dim, volume])
}

/** Update view-model fields: runtime-backed ones go to `api.settings.patch`, the rest stay local. */
export function updateViewSettings(patch: Partial<Settings>): void {
  const p: SettingsPatch = {}
  const local: Partial<LocalPrefs> = {}
  if (patch.appearance) p.appearance = { ...p.appearance, theme: patch.appearance }
  if (patch.accent) p.appearance = { ...p.appearance, accentColor: patch.accent === 'amethyst' ? DEFAULT_ACCENT : patch.accent }
  if (patch.streamerMode !== undefined) p.general = { ...p.general, streamerMode: patch.streamerMode }
  if (patch.developerMode !== undefined) p.general = { ...p.general, developerMode: patch.developerMode }
  if (patch.background) {
    const b = patch.background
    // The media file itself is set with `api.settings.setBackground` (it is copied into theme-media/).
    p.appearance = { ...p.appearance, background: { kind: b.kind, fit: b.fit === 'fit' ? 'contain' : 'cover', blur: Math.round(b.blur) } }
    local.dim = b.dim
    local.volume = b.volume
  }
  if (patch.translucentSidebar !== undefined) local.translucentSidebar = patch.translucentSidebar
  if (patch.sidebarIconSize) local.sidebarIconSize = patch.sidebarIconSize
  if (Object.keys(local).length) useLocalPrefs.getState().set(local)
  if (Object.keys(p).length) void patchSettings(p)
}

export function useUpdateSettings() {
  return updateViewSettings
}

/** Applies the colour scheme and accent to the document. Call once per window. */
export function applyAppearance(settings: Pick<Settings, 'appearance' | 'accent'>) {
  const root = document.documentElement
  if (settings.appearance === 'system') delete root.dataset.appearance
  else root.dataset.appearance = settings.appearance
  if (settings.accent === 'amethyst') root.style.removeProperty('--accent')
  else root.style.setProperty('--accent', settings.accent)
}
