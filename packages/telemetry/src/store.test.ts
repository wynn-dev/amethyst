import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadTelemetryState, saveTelemetryState } from './store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amethyst-telemetry-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('telemetry state', () => {
  it('defaults to no consent and a random install id when the file is missing', async () => {
    const a = await loadTelemetryState(join(dir, 'telemetry.json'))
    const b = await loadTelemetryState(join(dir, 'telemetry.json'))
    expect(a.consent).toEqual({ usage: false, crashes: false })
    expect(a.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.installId).not.toBe(b.installId)
    expect(a.decidedAt).toBeUndefined()
  })

  it('treats a corrupt or malformed file as defaults', async () => {
    const file = join(dir, 'telemetry.json')
    await writeFile(file, '{not json')
    expect((await loadTelemetryState(file)).consent).toEqual({ usage: false, crashes: false })
    await writeFile(file, JSON.stringify({ installId: 'nope', consent: { usage: 'yes', crashes: 1 } }))
    const state = await loadTelemetryState(file)
    expect(state.consent).toEqual({ usage: false, crashes: false })
    expect(state.installId).not.toBe('nope')
  })

  it('round-trips atomically without leaving temp files', async () => {
    const file = join(dir, 'nested', 'telemetry.json')
    const state = { installId: '3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', consent: { usage: true, crashes: false }, decidedAt: 1 }
    await saveTelemetryState(file, state)
    await saveTelemetryState(file, { ...state, consent: { usage: true, crashes: true } })
    expect(await loadTelemetryState(file)).toEqual({ ...state, consent: { usage: true, crashes: true } })
    expect(await readdir(join(dir, 'nested'))).toEqual(['telemetry.json'])
    expect(JSON.parse(await readFile(file, 'utf8')).installId).toBe(state.installId)
  })
})
