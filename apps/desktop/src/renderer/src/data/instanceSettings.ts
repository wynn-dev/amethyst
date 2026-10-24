import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSettings, type Settings } from './settings'

/**
 * Per-instance settings. Every overridable field is optional: `undefined` means "inherit the
 * global default from Settings → Game Defaults".
 */
export interface InstanceSettings {
  notes: string
  /** `auto`, or a JavaRuntime id. */
  javaRuntime: string
  memory?: Settings['memory']
  resolution?: Settings['resolution']
  hideLauncher?: boolean
  openLogOnLaunch?: boolean
  shareOptions: boolean
  jvmArgs?: string
  gameArgs?: string
  wrapper?: string
  preLaunch?: string
  env?: { key: string; value: string }[]
  modpack: { version: string; author: string; description: string; url: string }
}

export const defaultInstanceSettings: InstanceSettings = {
  notes: '',
  javaRuntime: 'auto',
  shareOptions: false,
  modpack: { version: '1.0.0', author: '', description: '', url: '' },
}

/** Fields that inherit from the global settings when unset. */
export type OverridableKey = 'memory' | 'resolution' | 'hideLauncher' | 'openLogOnLaunch' | 'jvmArgs' | 'gameArgs' | 'wrapper' | 'env'

interface Store {
  byId: Record<string, Partial<InstanceSettings>>
  update: (id: string, patch: Partial<InstanceSettings>) => void
  reset: (id: string, key: keyof InstanceSettings) => void
}

/**
 * TODO(wire): replace with api.instances.getSettings(id) → InstanceSettings and
 * api.instances.updateSettings(id, patch: Partial<InstanceSettings>) where a `null` value resets a
 * field to inherit; invalidate on `instances:changed`.
 */
const useStore = create<Store>()(
  persist(
    (set) => ({
      byId: {},
      update: (id, patch) => set((s) => ({ byId: { ...s.byId, [id]: { ...s.byId[id], ...patch } } })),
      reset: (id, key) =>
        set((s) => {
          const next = { ...s.byId[id] }
          delete next[key]
          return { byId: { ...s.byId, [id]: next } }
        }),
    }),
    { name: 'amethyst:instance-settings', version: 1 },
  ),
)

const EMPTY: Partial<InstanceSettings> = {}

export function useInstanceSettings(id: string) {
  const own = useStore((s) => s.byId[id] ?? EMPTY)
  const update = useStore((s) => s.update)
  const reset = useStore((s) => s.reset)
  const global = useSettings()
  const settings: InstanceSettings = { ...defaultInstanceSettings, ...own }
  /** Values after inheritance, for display. */
  const effective = {
    memory: own.memory ?? global.memory,
    resolution: own.resolution ?? global.resolution,
    hideLauncher: own.hideLauncher ?? global.onLaunch === 'hide',
    openLogOnLaunch: own.openLogOnLaunch ?? global.openLogOnLaunch,
    jvmArgs: own.jvmArgs ?? global.jvmArgs,
    gameArgs: own.gameArgs ?? global.gameArgs,
    wrapper: own.wrapper ?? global.wrapper,
    env: own.env ?? global.env,
  }
  return {
    settings,
    effective,
    isInherited: (key: OverridableKey) => own[key] === undefined,
    update: (patch: Partial<InstanceSettings>) => update(id, patch),
    reset: (key: keyof InstanceSettings) => reset(id, key),
  }
}
