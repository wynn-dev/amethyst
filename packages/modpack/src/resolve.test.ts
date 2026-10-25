import { rm } from 'node:fs/promises'
import path from 'node:path'
import { MarketplaceError } from '@amethyst/marketplace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCfZip, makeMrpack, mrFile, tempDir } from './__fixtures__/build'
import { cfFile, cfMod, mockCurseForge, mockModrinth, mrVersion } from './__fixtures__/market'
import { lookupInBatches, readModpack, resolveModpackFiles } from './index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('Modrinth env handling', () => {
  it('skips client-unsupported files and surfaces optional ones as a choice', async () => {
    const file = await makeMrpack(path.join(tmp, 'p.mrpack'), {
      files: [
        mrFile('mods/required.jar', 'R'),
        mrFile('mods/server-only.jar', 'S', { env: { client: 'unsupported', server: 'required' } }),
        mrFile('mods/optional.jar', 'O', { env: { client: 'optional', server: 'optional' } }),
        { ...mrFile('mods/elsewhere.jar', 'E'), downloads: ['https://example.com/elsewhere.jar'] },
      ],
    })
    const m = await readModpack(file)
    const modrinth = mockModrinth({ [mrFile('x', 'E').hashes.sha1]: mrVersion('PPPPPPPP', 'VVVVVVVV', 'https://cdn.modrinth.com/x', 'E') })
    const r = await resolveModpackFiles(m, { modrinth })
    expect(r.files.map((f) => f.path)).toEqual(['mods/required.jar', 'mods/optional.jar', 'mods/elsewhere.jar'])
    expect(r.skipped).toEqual([expect.objectContaining({ path: 'mods/server-only.jar', reason: 'env-unsupported' })])
    expect(r.optional).toEqual([{ path: 'mods/optional.jar', name: 'optional.jar', defaultSelected: true }])
    expect(r.files[0]?.origin).toEqual({ kind: 'modrinth', projectId: 'AAAAAAAA', versionId: 'BBBBBBBB' })
    expect(r.files[2]?.origin).toEqual({ kind: 'modrinth', projectId: 'PPPPPPPP', versionId: 'VVVVVVVV' })
    expect(r.externalHosts).toEqual(['example.com'])
    expect(r.manualDownloads).toEqual([])
  })
})

const pack = async (files: { projectID: number; fileID: number; required?: boolean }[]) =>
  readModpack(await makeCfZip(path.join(tmp, `cf-${Math.random()}.zip`), { files }))

describe('CurseForge resolution', () => {
  it('bisects a rejected batch so only the bad id is dropped', async () => {
    const files = Array.from({ length: 8 }, (_, i) => cfFile(100 + i, 1, `m${i}.jar`, `data${i}`))
    const { client, calls } = mockCurseForge(files, [cfMod(1, 6)], [105])
    const m = await pack([...files.map((f) => ({ projectID: 1, fileID: f.id })), { projectID: 1, fileID: 105 }])
    const r = await resolveModpackFiles(m, { curseforge: client, batchSize: 4 })
    expect(r.files.map((f) => f.path).toSorted()).toEqual(['mods/m0.jar', 'mods/m1.jar', 'mods/m2.jar', 'mods/m3.jar', 'mods/m4.jar', 'mods/m6.jar', 'mods/m7.jar'])
    expect(r.skipped).toEqual([expect.objectContaining({ path: 'curseforge:1/105', reason: 'missing-on-curseforge' })])
    // [100..103] ok; [104..107] rejected → [104,105] rejected → [104] ok, [105] failed; [106,107] ok.
    expect(calls.getFiles).toContainEqual([104, 105, 106, 107])
    expect(calls.getFiles).toContainEqual([105])
    expect(calls.getFiles).toContainEqual([106, 107])
    expect(calls.getMods).toEqual([[1]])
  })

  it('routes by classId, reports blocked files as manual downloads and honours required: false', async () => {
    const files = [
      cfFile(1, 10, 'mod.jar', 'mod'),
      cfFile(2, 20, 'pack.zip', 'rp'),
      cfFile(3, 30, 'shader.zip', 'sh'),
      cfFile(4, 40, 'World.zip', 'w'),
      cfFile(5, 50, 'dp.zip', 'dp'),
      cfFile(6, 60, 'blocked.jar', 'blocked', null),
      cfFile(7, 70, 'custom.jar', 'c'),
      cfFile(8, 80, 'custom.zip', 'c2'),
      cfFile(9, 90, 'optional.jar', 'opt'),
    ]
    const mods = [cfMod(10, 6), cfMod(20, 12), cfMod(30, 6552), cfMod(40, 17), cfMod(50, 6945), cfMod(60, 6, 'Blocked Mod'), cfMod(70, 4546), cfMod(80, 4546), cfMod(90, 6)]
    const { client } = mockCurseForge(files, mods)
    const m = await pack(files.map((f) => ({ projectID: f.modId, fileID: f.id, required: f.id !== 9 })))
    const r = await resolveModpackFiles(m, { curseforge: client })
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).toSorted()).toEqual([
      '.amethyst/datapacks-pending/dp.zip',
      'mods/blocked.jar',
      'mods/custom.jar',
      'mods/mod.jar',
      'mods/optional.jar',
      'resourcepacks/pack.zip',
      'saves/World',
      'shaderpacks/shader.zip',
    ])
    expect(byPath['saves/World']?.kind).toBe('world')
    expect(byPath['mods/mod.jar']).toMatchObject({ downloads: ['https://edge.forgecdn.net/files/1/mod.jar'], origin: { kind: 'curseforge', projectId: 10, fileId: 1 }, size: 3 })
    expect(byPath['mods/mod.jar']?.hashes.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(byPath['mods/blocked.jar']).toMatchObject({ blocked: true, downloads: [], origin: { kind: 'manual' } })
    expect(r.manualDownloads).toEqual([
      {
        name: 'Blocked Mod',
        fileName: 'blocked.jar',
        websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/mod-60/download/6',
        sha1: byPath['mods/blocked.jar']?.hashes.sha1,
        md5: byPath['mods/blocked.jar']?.hashes.md5,
        size: 7,
        path: 'mods/blocked.jar',
        projectId: 60,
        fileId: 6,
      },
    ])
    // No URL is ever invented for the blocked file.
    expect(JSON.stringify(r)).not.toMatch(/forgecdn\.net\/files\/6\//)
    expect(r.datapacks.map((d) => d.path)).toEqual(['.amethyst/datapacks-pending/dp.zip'])
    expect(r.optional).toEqual([{ path: 'mods/optional.jar', name: 'Mod 90', defaultSelected: false }])
    expect(r.skipped).toEqual([expect.objectContaining({ path: 'curseforge:80/8', reason: 'unknown-class' })])
  })

  it('fails clearly when CurseForge is unavailable', async () => {
    const m = await pack([{ projectID: 1, fileID: 2 }])
    await expect(resolveModpackFiles(m, {})).rejects.toMatchObject({ code: 'EMARKET_UNAVAILABLE' })
    const forbidden = {
      getFiles: async () => {
        throw new MarketplaceError('ECF_FORBIDDEN', 'forbidden', { platform: 'curseforge', status: 403 })
      },
      getMods: async () => [],
    }
    await expect(resolveModpackFiles(m, { curseforge: forbidden })).rejects.toMatchObject({ code: 'EMARKET_UNAVAILABLE' })
  })

  it('fails instead of returning an empty plan when CurseForge rejects every id (#971)', async () => {
    const files = [cfFile(1, 10, 'a.jar', 'a'), cfFile(2, 10, 'b.jar', 'b')]
    const { client } = mockCurseForge(files, [cfMod(10, 6)], [1, 2])
    const m = await pack(files.map((f) => ({ projectID: f.modId, fileID: f.id })))
    await expect(resolveModpackFiles(m, { curseforge: client })).rejects.toMatchObject({ code: 'EMARKET_UNAVAILABLE' })
    const noMods = { ...mockCurseForge(files, []).client, getMods: async () => Promise.reject(new MarketplaceError('EHTTP', 'HTTP 400', { platform: 'curseforge', status: 400 })) }
    await expect(resolveModpackFiles(m, { curseforge: noMods })).rejects.toMatchObject({ code: 'EMARKET_UNAVAILABLE' })
  })

  it('lookupInBatches rethrows non-rejection errors', async () => {
    const boom = new MarketplaceError('ENETWORK', 'down', { platform: 'curseforge' })
    await expect(lookupInBatches([1, 2], 1, async () => Promise.reject(boom))).rejects.toBe(boom)
    expect(await lookupInBatches([], 10, async () => [1])).toEqual({ results: [], failed: [] })
  })
})
