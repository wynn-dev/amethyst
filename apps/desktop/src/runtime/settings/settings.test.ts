import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Events } from '@shared/events'
import { DEFAULT_ACCENT } from '@shared/accent'
import { dataLayout, type DataLayout } from '../layout'
import { applySettingsPatch, defaultSettings, parseSettings } from './schema'
import { settingsService, SettingsStore } from './service'

let root: string
let layout: DataLayout
let events: { event: string; payload: unknown }[]
const emit = <K extends keyof Events>(event: K, payload: Events[K]) => {
  events.push({ event, payload })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'amethyst-settings-'))
  layout = dataLayout(root)
  events = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// A 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

describe('settings schema', () => {
  it('defaults to a translucent (vibrancy) sidebar, which can be turned off', () => {
    expect(defaultSettings().appearance.vibrancy).toBe(true)
    expect(parseSettings({ appearance: { vibrancy: 'yes' } }).appearance.vibrancy).toBe(true)
    expect(applySettingsPatch(defaultSettings(), { appearance: { vibrancy: false } }).next.appearance.vibrancy).toBe(false)
  })

  it('is the one source of defaults: the renderer’s first-paint copy must match it exactly', async () => {
    // Renderer modules (resolved by Vitest's alias; outside the node tsconfig, hence untyped).
    const renderer = ['@/data/settings', '@/lib/theme']
    const [{ DEFAULT_APP_SETTINGS }, { DEFAULT_ACCENT }] = await Promise.all(renderer.map((m) => import(m)))
    expect(DEFAULT_APP_SETTINGS).toEqual(defaultSettings())
    expect(DEFAULT_ACCENT).toBe(defaultSettings().appearance.accentColor)
    // A missing file, an empty object and a reset all give the same values.
    expect(parseSettings(undefined)).toEqual(defaultSettings())
    expect(parseSettings({})).toEqual(defaultSettings())
  })

  it('migrates the old purple default accent to the neutral default, on load and in patches', () => {
    expect(defaultSettings().appearance.accentColor).toBe(DEFAULT_ACCENT)
    expect(parseSettings({ appearance: { accentColor: '#9B5DE5' } }).appearance.accentColor).toBe(DEFAULT_ACCENT)
    expect(applySettingsPatch(defaultSettings(), { appearance: { accentColor: '#9b5de5' } }).next.appearance.accentColor).toBe(DEFAULT_ACCENT)
    // Any other colour is kept as chosen.
    expect(parseSettings({ appearance: { accentColor: '#007aff' } }).appearance.accentColor).toBe('#007aff')
  })

  it('falls back per field when loading', () => {
    const s = parseSettings({
      appearance: { theme: 'neon', accentColor: '#ABC', blur: { card: 99, sidebar: 3 } },
      game: { memory: { mode: 'manual', minMB: 8192, maxMB: 4096 }, jvmArgs: ['-Xss2m', '', 3] },
      unknown: true,
    })
    expect(s.appearance.theme).toBe('system')
    expect(s.appearance.accentColor).toBe('#aabbcc')
    expect(s.appearance.blur).toEqual({ card: 20, sidebar: 3 })
    // min > max is unusable: the minimum is dropped, the rest is kept.
    expect(s.game.memory).toEqual({ mode: 'manual', minMB: 0, maxMB: 4096 })
    expect(s.game.jvmArgs).toEqual([])
    expect(s).not.toHaveProperty('unknown')
  })

  it('validates patches strictly and reports every bad key', () => {
    const r = applySettingsPatch(defaultSettings(), {
      appearance: { theme: 'dark', accentColor: 'purple', bogus: 1 },
      game: { memory: { mode: 'manual', minMB: 4096, maxMB: 2048 } },
      network: { maxConnectionsPerHost: 0 },
    })
    expect(r.invalid.toSorted()).toEqual(['appearance.accentColor', 'appearance.bogus', 'game.memory.minMB', 'network.maxConnectionsPerHost'])
  })

  it('rejects code-injecting variables in the game env', () => {
    for (const key of ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
      expect(applySettingsPatch(defaultSettings(), { game: { env: { [key]: 'x' } } }).invalid).toEqual(['game.env'])
    }
    expect(applySettingsPatch(defaultSettings(), { game: { env: { MESA_DEBUG: '1' } } }).next.game.env).toEqual({ MESA_DEBUG: '1' })
    expect(parseSettings({ game: { env: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } } }).game.env).toEqual({})
  })

  it('uses null to reset keys and whole sections', () => {
    const base = applySettingsPatch(defaultSettings(), { appearance: { theme: 'dark', blur: { card: 5 } }, game: { jvmArgs: ['-Dx=1'] } }).next
    const r = applySettingsPatch(base, { appearance: { blur: null }, game: { jvmArgs: null } })
    expect(r.invalid).toEqual([])
    expect(r.next.appearance.blur).toEqual({ card: 20, sidebar: 4 })
    expect(r.next.appearance.theme).toBe('dark')
    expect(r.changed.toSorted()).toEqual(['appearance.blur.card', 'game.jvmArgs'])
  })

  it('normalises proxy URLs and rejects arbitrary background files', () => {
    expect(applySettingsPatch(defaultSettings(), { network: { proxyUrl: 'proxy.local:3128' } }).next.network.proxyUrl).toBe('http://proxy.local:3128')
    expect(applySettingsPatch(defaultSettings(), { appearance: { background: { kind: 'image', file: '../secrets/x.png' } } }).invalid).toEqual([
      'appearance.background.file',
      'appearance.background.kind',
    ])
  })
})

describe('SettingsStore', () => {
  it('persists patches and emits only the changed keys', async () => {
    const store = new SettingsStore(layout, emit)
    await store.load()
    await store.patch({ appearance: { theme: 'dark', accentColor: DEFAULT_ACCENT }, game: { memory: { mode: 'auto' } } })
    expect(events).toEqual([{ event: 'settings:changed', payload: { keys: ['appearance.theme', 'game.memory.mode'], patch: { appearance: { theme: 'dark' }, game: { memory: { mode: 'auto' } } } } }])
    // A no-op patch writes and emits nothing.
    await store.patch({ appearance: { theme: 'dark' } })
    expect(events).toHaveLength(1)
    await store.flush()
    const disk = JSON.parse(await readFile(layout.settings, 'utf8'))
    expect(disk).toMatchObject({ schemaVersion: 1, appearance: { theme: 'dark' }, game: { memory: { mode: 'auto' } } })
  })

  it('rejects invalid patches without applying any part of them', async () => {
    const store = new SettingsStore(layout, emit)
    await store.load()
    await expect(store.patch({ appearance: { theme: 'dark' }, game: { resolution: { width: -5 } } })).rejects.toMatchObject({
      code: 'EINVALID_SETTINGS',
      details: { keys: ['game.resolution.width'] },
    })
    expect(store.value.appearance.theme).toBe('system')
    expect(events).toEqual([])
  })

  it('keeps a corrupt settings file instead of silently resetting it', async () => {
    await writeFile(layout.settings, '{ "appearance": { "theme": "dark" ')
    const store = new SettingsStore(layout, emit)
    const settings = await store.load()
    expect(settings).toEqual(defaultSettings())
    expect(store.loadResult?.outcome).toBe('reset')
    expect((await readdir(root)).some((n) => n.startsWith('settings.json.corrupt-'))).toBe(true)
  })

  it('tells the user once when settings.json was moved aside, even if no window was listening yet', async () => {
    await writeFile(layout.settings, '{ "appearance": ')
    const store = new SettingsStore(layout, emit)
    await store.load()
    expect(events.map((e) => e.event)).toEqual(['settings:notice'])
    const service = settingsService(store, layout)
    const notice = await service.takeNotice()
    expect(notice?.kind).toBe('reset')
    expect(path.basename(notice?.corruptPath ?? '')).toMatch(/^settings\.json\.corrupt-\d+$/)
    expect((await readdir(root)).includes(path.basename(notice?.corruptPath ?? ''))).toBe(true)
    // Taken once: a second window (or a reconnect) gets nothing.
    expect(await service.takeNotice()).toBeNull()
  })

  it('says the settings were restored when the backup copy was used, and has nothing to say otherwise', async () => {
    const first = new SettingsStore(layout, emit)
    await first.load()
    await first.patch({ appearance: { theme: 'dark' } })
    await first.flush()
    await first.patch({ appearance: { theme: 'light' } })
    await first.flush()
    expect(first.takeNotice()).toBeNull()
    await writeFile(layout.settings, 'garbage')
    const second = new SettingsStore(layout, emit)
    await second.load()
    expect(second.loadResult?.outcome).toBe('recovered')
    expect(second.takeNotice()?.kind).toBe('recovered')
  })

  it('reset restores settings.json defaults and removes the background, keeping the privacy answer', async () => {
    const store = new SettingsStore(layout, emit)
    await store.load()
    const src = path.join(root, 'bg.png')
    await writeFile(src, PNG)
    await store.setBackground({ path: src })
    await store.patch({ appearance: { theme: 'dark', accentColor: '#007aff' }, network: { maxConnectionsPerHost: 4 }, privacy: { usageData: true, prompted: true } })
    const s = await store.reset()
    expect(s).toEqual({ ...defaultSettings(), privacy: { usageData: true, crashReports: false, prompted: true } })
    expect(await readdir(layout.themeMedia)).toEqual([])
    await store.flush()
    const disk = parseSettings(JSON.parse(await readFile(layout.settings, 'utf8')))
    expect(disk).toEqual(s)
  })

  it('imports a background by content into theme-media and replaces the old copy', async () => {
    const store = new SettingsStore(layout, emit)
    await store.load()
    const src = path.join(root, 'wallpaper.dat')
    await writeFile(src, PNG)
    const s = await store.setBackground({ path: src })
    expect(s.appearance.background.kind).toBe('image')
    expect(s.appearance.background.file).toMatch(/^theme-media\/[0-9a-f]{40}\.png$/)
    expect(await readdir(layout.themeMedia)).toHaveLength(1)

    const txt = path.join(root, 'notes.png')
    await writeFile(txt, 'not an image')
    await expect(store.setBackground({ path: txt })).rejects.toMatchObject({ code: 'EUNSUPPORTED_MEDIA' })

    await store.setBackground(null)
    expect(store.value.appearance.background).toMatchObject({ kind: 'none', file: null })
    expect(await readdir(layout.themeMedia)).toHaveLength(0)
  })
})
