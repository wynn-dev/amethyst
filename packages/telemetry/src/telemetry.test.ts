import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { PostHogOptions } from 'posthog-node'
import { createTelemetry, DEFAULT_HOST, type TelemetryOptions } from './telemetry'

type Fetch = NonNullable<PostHogOptions['fetch']>
interface SentEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}

const hang = () => new Promise<void>(() => {})
const INSTALL_ID = '3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'

function setup(overrides: Partial<TelemetryOptions> = {}, respond?: () => Promise<void>) {
  const requests: { url: string; batch: SentEvent[] }[] = []
  const fetch: Fetch = async (url, init) => {
    await respond?.()
    const body = init.body
    const bytes = typeof body === 'string' ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await (body as Blob).arrayBuffer())
    const json = init.headers['Content-Encoding'] === 'gzip' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
    requests.push({ url, batch: JSON.parse(json).batch })
    return { status: 200, text: async () => '{}', json: async () => ({}) }
  }
  const telemetry = createTelemetry({
    apiKey: 'phc_test',
    installId: INSTALL_ID,
    appInfo: { appVersion: '0.1.0-nightly.7', osVersion: '15.1', arch: 'arm64', electronVersion: '45.0.0' },
    consent: { usage: false, crashes: false },
    scrub: { homeDir: '/Users/alexsmith', username: 'alexsmith' },
    fetch,
    ...overrides,
  })
  const sent = () => requests.flatMap((r) => r.batch)
  return { telemetry, requests, sent }
}

describe('createTelemetry', () => {
  it('is a no-op without an API key', async () => {
    const { telemetry, requests } = setup({ apiKey: undefined, consent: { usage: true, crashes: true } })
    expect(telemetry.enabled).toBe(false)
    expect(telemetry.capture('app_opened')).toBe(false)
    expect(telemetry.captureException(new Error('x'), { source: 'runtime' })).toBe(false)
    await telemetry.flush()
    await telemetry.shutdown()
    expect(requests).toHaveLength(0)
    // Consent is still tracked so the UI can show it.
    expect(telemetry.getConsent()).toEqual({ usage: true, crashes: true })
  })

  it('sends and queues nothing without consent', async () => {
    const { telemetry, requests } = setup()
    expect(telemetry.capture('app_opened')).toBe(false)
    expect(telemetry.capture('perf_launch', { clickToSpawnMs: 120 })).toBe(false)
    expect(telemetry.captureException(new Error('boom'), { source: 'runtime' })).toBe(false)
    await telemetry.flush()
    // Granting consent later must not resurrect earlier events.
    telemetry.setConsent({ usage: true, crashes: true })
    await telemetry.flush()
    await telemetry.shutdown()
    expect(requests).toHaveLength(0)
  })

  it('sends usage events to the EU host with anonymous common properties', async () => {
    const { telemetry, requests, sent } = setup({ consent: { usage: true, crashes: false } })
    expect(telemetry.capture('app_opened')).toBe(true)
    expect(telemetry.capture('instance_created', { loader: 'fabric', mcVersion: '1.21.1' })).toBe(true)
    await telemetry.flush()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`${DEFAULT_HOST}/batch/`)
    const [opened, created] = sent()
    expect(opened!.event).toBe('app_opened')
    expect(opened!.distinct_id).toBe(INSTALL_ID)
    expect(opened!.properties).toMatchObject({
      $app_version: '0.1.0-nightly.7',
      $os: 'macOS',
      $os_version: '15.1',
      arch: 'arm64',
      electron_version: '45.0.0',
      $ip: null,
      $geoip_disable: true,
      $process_person_profile: false,
    })
    expect(created!.properties).toMatchObject({ loader: 'fabric', mcVersion: '1.21.1' })
  })

  it('only sends declared properties', async () => {
    const { telemetry, sent } = setup({ consent: { usage: true, crashes: false } })
    telemetry.capture('screen_viewed', { screen: '/instances/$id/mods', username: 'alexsmith' } as never)
    await telemetry.flush()
    const props = sent()[0]!.properties
    expect(props.screen).toBe('/instances/$id/mods')
    expect(props).not.toHaveProperty('username')
    const custom = Object.keys(props).filter((k) => !k.startsWith('$'))
    expect(custom.toSorted()).toEqual(['arch', 'electron_version', 'screen'])
  })

  it('rejects events with invalid properties', () => {
    const { telemetry } = setup({ consent: { usage: true, crashes: true } })
    expect(telemetry.capture('instance_created', { loader: 'optifine' as never, mcVersion: '1.20.1' })).toBe(false)
    expect(telemetry.capture('instance_created', { loader: 'forge', mcVersion: '/Users/alexsmith/x' })).toBe(false)
    expect(telemetry.capture('launch_exited', { exitKind: 'crash', durationMs: -5 })).toBe(false)
    expect(telemetry.capture('screen_viewed', { screen: '/instances/My Pack' })).toBe(false)
    expect(telemetry.capture('install_completed', { loader: 'forge', mcVersion: '1.20.1' } as never)).toBe(false)
  })

  it('gates performance events and exceptions on crash consent, separately from usage', async () => {
    const { telemetry, sent } = setup({ consent: { usage: true, crashes: false } })
    expect(telemetry.capture('perf_startup', { coldStartMs: 800, firstPaintMs: 300 })).toBe(false)
    expect(telemetry.captureException(new Error('x'), { source: 'main' })).toBe(false)
    telemetry.setConsent({ usage: false, crashes: true })
    expect(telemetry.capture('app_opened')).toBe(false)
    expect(telemetry.capture('perf_download', { throughputBps: 12_345.6, files: 3 })).toBe(true)
    await telemetry.flush()
    expect(sent().map((e) => e.event)).toEqual(['perf_download'])
    expect(sent()[0]!.properties.throughputBps).toBe(12_346)
  })

  it('deletes queued events when consent is revoked, before the client loads', async () => {
    const { telemetry, requests } = setup({ consent: { usage: true, crashes: true } })
    telemetry.capture('app_opened')
    telemetry.captureException(new Error('x'), { source: 'runtime' })
    telemetry.setConsent({ usage: false, crashes: false })
    await telemetry.flush()
    await telemetry.shutdown()
    expect(requests).toHaveLength(0)
  })

  it('deletes queued events when consent is revoked, after the client loaded', async () => {
    const { telemetry, sent } = setup({ consent: { usage: true, crashes: true } })
    telemetry.capture('app_opened')
    await telemetry.flush()
    expect(sent()).toHaveLength(1)
    telemetry.capture('launch_started')
    telemetry.capture('perf_launch', { clickToSpawnMs: 90 })
    // Revoking usage drops only usage events.
    telemetry.setConsent({ usage: false, crashes: true })
    await telemetry.flush()
    await telemetry.shutdown()
    expect(sent().map((e) => e.event)).toEqual(['app_opened', 'perf_launch'])
  })

  it('accepts only allow-listed events from untrusted callers', async () => {
    const { telemetry, sent } = setup({ consent: { usage: true, crashes: true } })
    expect(telemetry.captureUntrusted('install_completed', { loader: 'forge', mcVersion: '1.20.1', durationMs: 1, bytes: 1 })).toBe(false)
    expect(telemetry.captureUntrusted('$exception', {})).toBe(false)
    expect(telemetry.captureUntrusted('toString', {})).toBe(false)
    expect(telemetry.captureUntrusted('screen_viewed', { screen: 'home' })).toBe(true)
    expect(telemetry.captureUntrusted('perf_startup', { coldStartMs: 700, firstPaintMs: 250 })).toBe(true)
    await telemetry.flush()
    expect(sent().map((e) => e.event)).toEqual(['screen_viewed', 'perf_startup'])
  })

  it('sends exceptions with a scrubbed message and stack', async () => {
    const { telemetry, sent } = setup({ consent: { usage: false, crashes: true } })
    const error = new Error("EACCES: open '/Users/alexsmith/Library/Application Support/Amethyst/instances/Alex SMP/options.txt'", {
      cause: new Error('token=eyJabc.eyJdef.ghi for alex@example.com'),
    })
    error.stack = [
      `Error: ${error.message}`,
      '    at readOptions (/Applications/Amethyst.app/Contents/Resources/app.asar/out/main/runtime.js:1:2345)',
      '    at async Promise.all (index 0)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n')
    expect(telemetry.captureException(error, { source: 'runtime', fatal: true })).toBe(true)
    telemetry.addSensitive('Alex SMP')
    await telemetry.flush()

    const [event] = sent()
    expect(event!.event).toBe('$exception')
    const json = JSON.stringify(event)
    expect(json).not.toMatch(/alexsmith|Alex SMP|alex@example|eyJabc|\/Applications/)
    expect(event!.properties).toMatchObject({ $exception_level: 'fatal', source: 'runtime', $ip: null })
    const list = event!.properties.$exception_list as { type: string; value: string; mechanism: object; stacktrace?: { frames: object[] } }[]
    expect(list).toHaveLength(2)
    expect(list[0]!.value).toBe("EACCES: open '~/Library/Application Support/Amethyst/instances/<redacted>/options.txt'")
    expect(list[0]!.mechanism).toMatchObject({ type: 'generic', handled: false })
    expect(list[0]!.stacktrace!.frames).toEqual([
      { platform: 'node:javascript', filename: 'node:internal/process/task_queues', function: 'process.processTicksAndRejections', lineno: 105, colno: 5, in_app: false },
      { platform: 'node:javascript', filename: 'app:///out/main/runtime.js', function: 'readOptions', lineno: 1, colno: 2345, in_app: true },
    ])
    expect(list[1]!.mechanism).toMatchObject({ type: 'chained', parent_id: 0 })
    expect(list[1]!.value).toBe('token=<redacted> for <email>')
  })

  it('accepts non-Error throwables and rate limits exceptions', async () => {
    const { telemetry, sent } = setup({ consent: { usage: false, crashes: true } })
    expect(telemetry.captureException('plain string', { source: 'renderer' })).toBe(true)
    expect(telemetry.captureException({ name: 'TypeError', message: 'x is undefined' }, { source: 'renderer' })).toBe(true)
    for (let i = 0; i < 20; i++) telemetry.captureException(new Error(`e${i}`), { source: 'runtime' })
    await telemetry.flush()
    expect(sent()).toHaveLength(10)
    expect((sent()[1]!.properties.$exception_list as { type: string }[])[0]!.type).toBe('TypeError')
  })

  it('never blocks: flush and shutdown give up after their timeout', async () => {
    const { telemetry } = setup({ consent: { usage: true, crashes: false } }, hang)
    telemetry.capture('app_opened')
    const started = Date.now()
    await telemetry.flush(100)
    await telemetry.shutdown(100)
    expect(Date.now() - started).toBeLessThan(1_000)
    // Nothing is accepted after shutdown.
    expect(telemetry.capture('app_opened')).toBe(false)
  })
})
