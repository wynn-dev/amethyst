import { homedir, userInfo } from 'node:os'
import type { EventMessage, PostHog, PostHogOptions } from 'posthog-node'
import {
  categoryOf,
  EXCEPTION_EVENT,
  isEventName,
  NO_CONSENT,
  RENDERER_EVENTS,
  validateProps,
  type Consent,
  type EventArgs,
  type EventName,
} from './events'
import { buildExceptionList } from './exception'
import { createScrubber, type ScrubOptions } from './scrub'

export const DEFAULT_HOST = 'https://eu.i.posthog.com'

export interface AppInfo {
  appVersion: string
  /** The macOS product version, e.g. `15.1`. */
  osVersion: string
  arch: string
  electronVersion?: string
}

export interface TelemetryOptions {
  /** PostHog project key. When missing, the client is a no-op. */
  apiKey?: string
  /** PostHog host. Defaults to the EU cloud. */
  host?: string
  /** A random UUID generated and stored by the caller. Never derived from an account. */
  installId: string
  appInfo: AppInfo
  /** The user's current choice. Pass `NO_CONSENT` until they have decided. */
  consent: Consent
  /** Defaults to the current home directory and OS username. */
  scrub?: ScrubOptions
  /** Send a batch once this many events are queued. Default 20. */
  flushAt?: number
  /** Send queued events after this long. The timer only runs while events are queued. Default 30 s. */
  flushIntervalMs?: number
  /** Oldest events are dropped beyond this. Default 200. */
  maxQueueSize?: number
  /** Replaces posthog-node's HTTP transport (tests). */
  fetch?: PostHogOptions['fetch']
}

export interface ExceptionContext {
  /** The process the error came from. */
  source: 'main' | 'runtime' | 'renderer'
  /** `false` for uncaught exceptions and unhandled rejections. Default `false`. */
  handled?: boolean
  /** The process is about to exit because of this error. */
  fatal?: boolean
}

export interface Telemetry {
  /** `false` when no API key was compiled in: every call is a no-op. */
  readonly enabled: boolean
  getConsent(): Consent
  /** Apply a new consent choice immediately. Revoking a category deletes its queued events. */
  setConsent(consent: Consent): void
  /** Capture a typed event. Returns `true` if it was queued for sending. */
  capture<E extends EventName>(event: E, ...args: EventArgs<E>): boolean
  /** Capture an event from an untrusted source (the renderer); only `allowed` names are accepted. */
  captureUntrusted(event: unknown, props: unknown, allowed?: readonly EventName[]): boolean
  /** Capture an error as `$exception`, with a scrubbed message and stack. Rate limited. */
  captureException(error: unknown, context: ExceptionContext): boolean
  /** Remove this exact string from every future report (e.g. a player name). */
  addSensitive(value: string): void
  /** Send queued events now. Never rejects; gives up after `timeoutMs`. */
  flush(timeoutMs?: number): Promise<void>
  /** Send what is queued (within `timeoutMs`) and stop. Never rejects. Call on quit. */
  shutdown(timeoutMs?: number): Promise<void>
}

const EXCEPTIONS_PER_MINUTE = 10
// posthog-node keeps its batch queue under this persisted-property key.
const POSTHOG_QUEUE_KEY = 'queue' as Parameters<PostHog['getPersistedProperty']>[0]

type QueueItem = { message?: { event?: string } }

/** Remove events from posthog-node's in-memory batch queue (public persisted-property API). */
function filterQueue(client: PostHog, keep: (item: QueueItem) => boolean): void {
  const queue = client.getPersistedProperty(POSTHOG_QUEUE_KEY) as QueueItem[] | undefined
  if (Array.isArray(queue)) client.setPersistedProperty(POSTHOG_QUEUE_KEY, queue.filter(keep))
}

function defaultScrubOptions(): ScrubOptions {
  let username: string | undefined
  try {
    username = userInfo().username
  } catch {
    username = undefined
  }
  return { homeDir: homedir(), username }
}

/** Resolve with the promise's value, or `undefined` if it rejects or takes longer than `ms`. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, ms))
    timer.unref?.()
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      () => (clearTimeout(timer), resolve(undefined)),
    )
  })
}

const normaliseConsent = (c: Partial<Consent> | undefined): Consent => ({ usage: c?.usage === true, crashes: c?.crashes === true })

export function createTelemetry(options: TelemetryOptions): Telemetry {
  let consent = normaliseConsent(options.consent ?? NO_CONSENT)
  const scrub = createScrubber(options.scrub ?? defaultScrubOptions())
  const apiKey = options.apiKey?.trim()

  const getConsent = () => ({ ...consent })
  const base = {
    getConsent,
    addSensitive: (value: string) => scrub.addSensitive(value),
  }

  if (!apiKey) {
    return {
      ...base,
      enabled: false,
      setConsent: (next) => void (consent = normaliseConsent(next)),
      capture: () => false,
      captureUntrusted: () => false,
      captureException: () => false,
      flush: async () => {},
      shutdown: async () => {},
    }
  }

  const { appInfo, installId } = options
  const maxQueueSize = options.maxQueueSize ?? 200
  const commonProperties = {
    $app_version: appInfo.appVersion,
    $os: 'macOS',
    $os_version: appInfo.osVersion,
    arch: appInfo.arch,
    ...(appInfo.electronVersion ? { electron_version: appInfo.electronVersion } : {}),
    // Never record the client IP, never resolve a location, never build a person profile.
    $ip: null,
    $geoip_disable: true,
    $process_person_profile: false,
  }

  let closed = false
  let client: PostHog | undefined
  let loading: Promise<PostHog | undefined> | undefined
  // Events captured (with consent) while posthog-node is still being imported. Bounded.
  let pending: EventMessage[] = []
  const exceptionTimes: number[] = []

  const isAllowed = (event: string | undefined) => {
    const category = event === undefined ? undefined : categoryOf(event)
    return category !== undefined && consent[category]
  }

  const loadClient = (): Promise<PostHog | undefined> =>
    (loading ??= import('posthog-node')
      .then(({ PostHog }) => {
        const c = new PostHog(apiKey, {
          host: options.host || DEFAULT_HOST,
          flushAt: options.flushAt ?? 20,
          flushInterval: options.flushIntervalMs ?? 30_000,
          maxQueueSize,
          disableGeoip: true,
          isServer: false,
          enableExceptionAutocapture: false,
          requestTimeout: 10_000,
          fetchRetryCount: 1,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          // Re-check consent while posthog-node prepares each event...
          before_send: (message) => (isAllowed(message.event) ? message : null),
        })
        // ...and again the moment it enters the queue (preparation is async, so consent may have
        // been revoked in between). The listener runs before posthog-node can start a flush.
        c.on('capture', (message: { event?: string }) => {
          if (!isAllowed(message.event)) filterQueue(c, (item) => item.message !== message)
        })
        c.on('error', () => {})
        client = c
        for (const message of pending) if (isAllowed(message.event)) c.capture(message)
        pending = []
        return c
      })
      .catch(() => undefined))

  const enqueue = (message: EventMessage) => {
    if (client) {
      client.capture(message)
      return
    }
    if (pending.length >= maxQueueSize) pending.shift()
    pending.push(message)
    void loadClient()
  }

  const dropQueued = () => {
    pending = pending.filter((m) => isAllowed(m.event))
    if (client) filterQueue(client, (item) => isAllowed(item.message?.event))
  }

  const telemetry: Telemetry = {
    ...base,
    enabled: true,

    setConsent(next) {
      const before = consent
      consent = normaliseConsent(next)
      if ((before.usage && !consent.usage) || (before.crashes && !consent.crashes)) dropQueued()
    },

    capture(event, ...args) {
      if (closed || !isAllowed(event)) return false
      const props = validateProps(event, args[0])
      if (!props) return false
      enqueue({ distinctId: installId, event, properties: { ...props, ...commonProperties } })
      return true
    },

    captureUntrusted(event, props, allowed = RENDERER_EVENTS) {
      if (!isEventName(event) || !allowed.includes(event)) return false
      return telemetry.capture(event, props as never)
    },

    captureException(error, context) {
      if (closed || !isAllowed(EXCEPTION_EVENT)) return false
      const now = Date.now()
      while (exceptionTimes.length && now - exceptionTimes[0]! > 60_000) exceptionTimes.shift()
      if (exceptionTimes.length >= EXCEPTIONS_PER_MINUTE) return false
      exceptionTimes.push(now)
      const handled = context.handled ?? false
      const $exception_list = buildExceptionList(error, scrub, {
        handled,
        platform: context.source === 'renderer' ? 'web:javascript' : 'node:javascript',
      })
      enqueue({
        distinctId: installId,
        event: EXCEPTION_EVENT,
        properties: {
          $exception_list,
          $exception_level: context.fatal ? 'fatal' : 'error',
          source: context.source,
          ...commonProperties,
        },
        // We attach the `$exception_list` metadata ourselves; this silences posthog-node's warning.
        _originatedFromCaptureException: true,
      } as EventMessage)
      return true
    },

    async flush(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      const c = client ?? (pending.length ? await settleWithin(loadClient(), timeoutMs) : undefined)
      if (c) await settleWithin(c.flush(), deadline - Date.now())
    },

    async shutdown(timeoutMs = 2_000) {
      closed = true
      const deadline = Date.now() + timeoutMs
      const c = client ?? (pending.length ? await settleWithin(loadClient(), timeoutMs) : undefined)
      if (c) await settleWithin(c.shutdown(Math.max(0, deadline - Date.now())), deadline - Date.now())
    },
  }
  return telemetry
}

