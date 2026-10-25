// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rank } from './fuzzy'
import { buildPaletteItems, searchPalette, type PaletteContext } from './palette-items'
import { DEFAULT_APP_SETTINGS, toViewSettings } from '@/data/settings'
import type { InstanceSummary } from '@/data/types'

const HOUR = 3_600_000
const NOW = 1_760_000_000_000
const inst = (id: string, name: string, playedHoursAgo?: number): InstanceSummary => ({
  id,
  name,
  iconHue: 120,
  minecraft: '1.21.1',
  loader: { kind: 'fabric', version: '0.16.5' },
  pinned: false,
  state: { kind: 'idle' },
  ...(playedHoursAgo === undefined ? {} : { lastPlayedAt: NOW - playedHoursAgo * HOUR }),
  playTimeMs: 0,
  createdAt: NOW - 1000 * HOUR,
})
const instances = [
  inst('survival', 'Survival 1.21', 2),
  inst('fabulously', 'Fabulously Optimized', 24),
  inst('a', 'Alpha', 30),
  inst('b', 'Beta', 40),
  inst('c', 'Creative', 50),
  inst('d', 'Delta', 60),
  inst('never', 'Never Played'),
]

describe('fuzzyMatch', () => {
  it('matches subsequences and rejects out-of-order queries', () => {
    expect(fuzzyMatch('nwi', 'New Instance…')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'New Instance…')).toBeNull()
    expect(fuzzyMatch('ecnatsni', 'Instance')).toBeNull()
  })

  it('prefers prefixes and word starts', () => {
    const ranked = rank(['Show in Finder', 'New Instance…', 'Reveal Data Folder'], 'ni', (s) => [s])
    expect(ranked[0]?.item).toBe('New Instance…')
    const prefix = fuzzyMatch('dis', 'Discover')!
    const middle = fuzzyMatch('dis', 'Redistribute')!
    expect(prefix.score).toBeGreaterThan(middle.score)
  })

  it('returns highlight indices', () => {
    expect(fuzzyMatch('mods', 'Survival › Mods')?.indices).toEqual([11, 12, 13, 14])
  })
})

describe('command palette search', () => {
  const view = toViewSettings(DEFAULT_APP_SETTINGS)
  const ctx: PaletteContext = { instances, currentInstanceId: 'survival', settings: { app: DEFAULT_APP_SETTINGS, view } }
  const items = buildPaletteItems(ctx)

  it('shows recent instances (most recent first) and suggestions for an empty query', () => {
    const results = searchPalette(items, '', ctx)
    const recent = results.filter((r) => r.item.group === 'Recent Instances')
    expect(recent).toHaveLength(5)
    expect(recent[0]?.item.title).toBe('Survival 1.21')
    expect(results.some((r) => r.item.group === 'Suggested' && r.item.title === 'New Instance…')).toBe(true)
  })

  it('finds instance tabs, actions and settings, grouped in order', () => {
    const results = searchPalette(items, 'surv mods', ctx)
    expect(results.some((r) => r.item.title === 'Survival 1.21 › Mods')).toBe(true)

    const groups = searchPalette(items, 'update', ctx).map((r) => r.item.group)
    const order = ['Instances', 'Actions', 'Navigation', 'Settings', 'Discover']
    const seen = [...new Set(groups)]
    expect(seen).toEqual(order.filter((g) => seen.includes(g as never)))
  })

  it('offers a Discover search after two characters and caps the list', () => {
    expect(searchPalette(items, 's', ctx).some((r) => r.item.group === 'Discover')).toBe(false)
    const results = searchPalette(items, 'sodium', ctx)
    expect(results.at(-1)?.item.run).toEqual({ kind: 'discover', query: 'sodium' })
    expect(searchPalette(items, 'e', ctx).length).toBeLessThanOrEqual(40)
  })

  it('exposes settings toggles inline', () => {
    const streamer = searchPalette(items, 'streamer mode', ctx).find((r) => r.item.title === 'Streamer mode')
    expect(streamer?.item.toggle).toEqual({ on: false, action: { settings: { general: { streamerMode: true } } } })
    const usage = searchPalette(items, 'share usage', ctx).find((r) => r.item.title === 'Share usage data')
    expect(usage?.item.toggle).toEqual({ on: false, action: { consent: { usage: true, crashes: false } } })
  })

  it('hides instance-only actions when no instance is selected', () => {
    const noInstance = buildPaletteItems({ ...ctx, currentInstanceId: undefined })
    expect(noInstance.some((i) => i.title === 'Play')).toBe(false)
    expect(items.some((i) => i.title === 'Play')).toBe(true)
  })
})
