import type { Events } from '@shared/events'

/** Push an event to every connected renderer. */
export type Emit = <K extends keyof Events>(event: K, payload: Events[K]) => void

/** Build-time configuration (from `AMETHYST_*` variables) and the app version. */
export interface RuntimeConfig {
  version: string
  /** Azure app id; Microsoft login is unavailable without it. */
  msaClientId?: string
  /** CurseForge Core API key; CurseForge is hidden without it. */
  curseforgeApiKey?: string
}
