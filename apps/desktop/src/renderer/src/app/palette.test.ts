import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rank } from './fuzzy'
import { buildPaletteItems, searchPalette, type PaletteContext } from './palette-items'
import { fixtureInstances } from '@/data/fixtures'
import { defaultSettings } from '@/data/settings'

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
  const ctx: PaletteContext = { instances: fixtureInstances, currentInstanceId: 'survival', settings: defaultSettings }
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
    expect(streamer?.item.toggle).toEqual({ on: false, patch: { streamerMode: true } })
  })

  it('hides instance-only actions when no instance is selected', () => {
    const noInstance = buildPaletteItems({ ...ctx, currentInstanceId: undefined })
    expect(noInstance.some((i) => i.title === 'Play')).toBe(false)
    expect(items.some((i) => i.title === 'Play')).toBe(true)
  })
})
