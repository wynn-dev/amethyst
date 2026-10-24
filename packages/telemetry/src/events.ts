/**
 * The complete list of telemetry events Amethyst may send, with the exact properties each one
 * carries. Nothing outside this schema ever leaves the machine: events are validated against it
 * at capture time, unknown properties are dropped, and invalid events are discarded.
 *
 * This module is dependency-free so the renderer can import its types.
 * Keep `docs/PRIVACY.md` in sync with every change here.
 */

/** The two independent consent toggles. Both default to `false`. */
export interface Consent {
  /** "Share usage data": usage events and active-user counts. */
  usage: boolean
  /** "Send crash reports": errors, crashes and performance timings. */
  crashes: boolean
}

export const NO_CONSENT: Readonly<Consent> = Object.freeze({ usage: false, crashes: false })

export type ConsentCategory = keyof Consent

type StringField = { type: 'string'; pattern: RegExp }
type EnumField = { type: 'enum'; values: readonly string[] }
type NumberField = { type: 'number'; max: number }
type FieldSpec = StringField | EnumField | NumberField

interface EventSpec {
  category: ConsentCategory
  fields: Record<string, FieldSpec>
}

const LOADER = { type: 'enum', values: ['vanilla', 'forge', 'neoforge', 'fabric', 'quilt'] } as const
const MC_VERSION = { type: 'string', pattern: /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/ } as const
const SOURCE = { type: 'enum', values: ['modrinth', 'curseforge', 'file'] } as const
/** Milliseconds, capped at one day. */
const DURATION = { type: 'number', max: 86_400_000 } as const
/** Startup/launch timings, capped at ten minutes. */
const TIMING = { type: 'number', max: 600_000 } as const

export const EVENT_SCHEMA = {
  // Usage: gated by `consent.usage`.
  /** Sent once per app session; powers DAU/MAU. */
  app_opened: { category: 'usage', fields: {} },
  /** A route template such as `/instances/$id/mods`, never a concrete URL or name. */
  screen_viewed: { category: 'usage', fields: { screen: { type: 'string', pattern: /^[a-z0-9_$./-]{1,64}$/ } } },
  instance_created: { category: 'usage', fields: { loader: LOADER, mcVersion: MC_VERSION } },
  install_completed: {
    category: 'usage',
    fields: { loader: LOADER, mcVersion: MC_VERSION, durationMs: DURATION, bytes: { type: 'number', max: 1e13 } },
  },
  launch_started: { category: 'usage', fields: {} },
  launch_exited: {
    category: 'usage',
    fields: { exitKind: { type: 'enum', values: ['normal', 'crash', 'killed'] }, durationMs: DURATION },
  },
  modpack_imported: { category: 'usage', fields: { source: SOURCE } },
  content_installed: {
    category: 'usage',
    fields: { source: SOURCE, kind: { type: 'enum', values: ['mod', 'resourcepack', 'shaderpack', 'datapack', 'world'] } },
  },

  // Performance: gated by `consent.crashes` (DECISIONS.md: "errors and crashes plus performance timings").
  perf_startup: { category: 'crashes', fields: { coldStartMs: TIMING, firstPaintMs: TIMING } },
  perf_download: { category: 'crashes', fields: { throughputBps: { type: 'number', max: 1e11 }, files: { type: 'number', max: 1e7 } } },
  perf_launch: { category: 'crashes', fields: { clickToSpawnMs: TIMING } },
} as const satisfies Record<string, EventSpec>

export type EventName = keyof typeof EVENT_SCHEMA

type FieldValue<F> = F extends { type: 'enum'; values: readonly (infer V)[] } ? V : F extends { type: 'number' } ? number : string

export type EventProps<E extends EventName> = {
  -readonly [K in keyof (typeof EVENT_SCHEMA)[E]['fields']]: FieldValue<(typeof EVENT_SCHEMA)[E]['fields'][K]>
}

/** `capture('app_opened')` needs no properties; every other event requires its full set. */
export type EventArgs<E extends EventName> = keyof EventProps<E> extends never ? [props?: EventProps<E>] : [props: EventProps<E>]

/** Events the renderer may capture over RPC. Everything else is captured by the runtime itself. */
export const RENDERER_EVENTS = ['screen_viewed', 'perf_startup'] as const satisfies readonly EventName[]
export type RendererEventName = (typeof RENDERER_EVENTS)[number]

/** The exception event is gated by `consent.crashes`. */
export const EXCEPTION_EVENT = '$exception'

export function isEventName(name: unknown): name is EventName {
  return typeof name === 'string' && Object.hasOwn(EVENT_SCHEMA, name)
}

export function categoryOf(event: string): ConsentCategory | undefined {
  if (event === EXCEPTION_EVENT) return 'crashes'
  return isEventName(event) ? EVENT_SCHEMA[event].category : undefined
}

/**
 * Validate untrusted properties against the schema. Returns a fresh object holding only the
 * declared fields (numbers rounded to integers), or `null` if any field is missing or invalid.
 */
export function validateProps(event: EventName, props: unknown): Record<string, string | number> | null {
  const fields: Record<string, FieldSpec> = EVENT_SCHEMA[event].fields
  const input = (props ?? {}) as Record<string, unknown>
  if (typeof input !== 'object' || Array.isArray(input)) return null
  const out: Record<string, string | number> = {}
  for (const [key, spec] of Object.entries(fields)) {
    const value = Object.hasOwn(input, key) ? input[key] : undefined
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string' || !spec.pattern.test(value)) return null
        out[key] = value
        break
      case 'enum':
        if (typeof value !== 'string' || !spec.values.includes(value)) return null
        out[key] = value
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > spec.max) return null
        out[key] = Math.round(value)
        break
    }
  }
  return out
}
