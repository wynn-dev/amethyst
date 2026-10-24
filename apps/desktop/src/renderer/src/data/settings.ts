import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Appearance = 'system' | 'light' | 'dark'

export interface Settings {
  appearance: Appearance
  /** `amethyst` (default) or a swatch hex colour. */
  accent: string
  translucentSidebar: boolean
  sidebarIconSize: 'small' | 'medium' | 'large'
  background: { kind: 'none' | 'image' | 'video'; url?: string; fit: 'fill' | 'fit'; dim: number; blur: number; volume: number }
  onLaunch: 'keep' | 'hide' | 'quit'
  openLogOnLaunch: boolean
  checkBeforeLaunch: boolean
  dataPath: string
  streamerMode: boolean
  autoJava: boolean
  memory: { auto: boolean; minMb: number; maxMb: number }
  resolution: { width: number; height: number; fullscreen: boolean }
  jvmArgs: string
  gameArgs: string
  wrapper: string
  env: { key: string; value: string }[]
  proxy: { mode: 'system' | 'none' | 'manual'; host: string; port: number }
  maxDownloads: number
  telemetry: { usage: boolean; crashes: boolean }
  updates: { auto: boolean; channel: 'stable' | 'beta' }
  developerMode: boolean
}

export const defaultSettings: Settings = {
  appearance: 'system',
  accent: 'amethyst',
  translucentSidebar: true,
  sidebarIconSize: 'medium',
  background: { kind: 'none', fit: 'fill', dim: 30, blur: 12, volume: 0 },
  onLaunch: 'keep',
  openLogOnLaunch: false,
  checkBeforeLaunch: true,
  dataPath: '~/Library/Application Support/Amethyst',
  streamerMode: false,
  autoJava: true,
  memory: { auto: true, minMb: 1024, maxMb: 4096 },
  resolution: { width: 854, height: 480, fullscreen: false },
  jvmArgs: '',
  gameArgs: '',
  wrapper: '',
  env: [],
  proxy: { mode: 'system', host: '', port: 8080 },
  maxDownloads: 16,
  // Safe by default: nothing is sent until the user opts in (DECISIONS.md, ui.md B10).
  telemetry: { usage: false, crashes: false },
  updates: { auto: true, channel: 'stable' },
  developerMode: false,
}

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

interface SettingsStore {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  reset: () => void
}

const KEY = 'amethyst:settings'

/**
 * Global settings, stored locally for now.
 * TODO(wire): replace with api.settings.get() → Settings, api.settings.update(patch: Partial<Settings>), and
 * subscribe('settings:changed', patch) so both windows stay in sync. Appearance should also set
 * `nativeTheme.themeSource` in main so the vibrancy material matches.
 */
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      settings: defaultSettings,
      update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      reset: () => set({ settings: defaultSettings }),
    }),
    {
      name: KEY,
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        settings: { ...defaultSettings, ...(persisted as Partial<SettingsStore> | undefined)?.settings },
      }),
    },
  ),
)

// The Settings window and the main window share localStorage; follow the other window's writes.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) useSettingsStore.persist.rehydrate()
  })
}

export function useSettings(): Settings {
  return useSettingsStore((s) => s.settings)
}

export function useUpdateSettings() {
  return useSettingsStore((s) => s.update)
}

/** Applies appearance and accent to the document. Call once per window. */
export function applyAppearance(settings: Pick<Settings, 'appearance' | 'accent'>) {
  const root = document.documentElement
  if (settings.appearance === 'system') delete root.dataset.appearance
  else root.dataset.appearance = settings.appearance
  if (settings.accent === 'amethyst') root.style.removeProperty('--accent')
  else root.style.setProperty('--accent', settings.accent)
}
