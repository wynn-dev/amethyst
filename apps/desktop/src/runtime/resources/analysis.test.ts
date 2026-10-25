import type { ContentEntry, ModLoader, ModMetadata } from '@amethyst/content'
import { describe, expect, it } from 'vitest'
import { analyzeMods, type AnalyzedMod } from './analysis'
import { pendingRow } from './rows'

function mod(file: string, id: string, loaders: ModLoader[]): AnalyzedMod {
  const meta: ModMetadata = { loaders, byLoader: {}, id, authors: [], links: {}, environment: 'both', dependencies: [], provides: { [id]: '1.0' }, warnings: [] }
  const row = { ...pendingRow(file, 'mods', file, { size: 1, mtimeMs: 0, isDirectory: false, enabled: true }), pending: false }
  const entry = { path: `/i/mods/${file}`, fileName: file, baseName: file, kind: 'mods', isDirectory: false, enabled: true, size: 1, mtimeMs: 0, ino: 1, cached: false, mod: meta } satisfies ContentEntry
  return { row, entry }
}

describe('analyzeMods loader compatibility', () => {
  const mods = [mod('forge-only.jar', 'forgeonly', ['forge']), mod('fabric-only.jar', 'fabriconly', ['fabric']), mod('neo.jar', 'neo', ['neoforge'])]

  it('accepts Forge mods on NeoForge for Minecraft 1.20.1 only', () => {
    expect(analyzeMods(mods, 'neoforge', '1.20.1').incompatible.map((i) => i.id)).toEqual(['fabric-only.jar'])
    expect(analyzeMods(mods, 'neoforge', '1.21.1').incompatible.map((i) => i.id)).toEqual(['forge-only.jar', 'fabric-only.jar'])
    expect(analyzeMods(mods, 'neoforge').incompatible.map((i) => i.id)).toEqual(['forge-only.jar', 'fabric-only.jar'])
  })

  it('accepts Fabric mods on Quilt', () => {
    expect(analyzeMods(mods, 'quilt', '1.21.1').incompatible.map((i) => i.id)).toEqual(['forge-only.jar', 'neo.jar'])
  })
})
