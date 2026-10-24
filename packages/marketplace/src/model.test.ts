import { describe, expect, it } from 'vitest'
import cfFiles from './__fixtures__/curseforge-files.json'
import cfSearch from './__fixtures__/curseforge-search.json'
import mrProject from './__fixtures__/modrinth-project.json'
import mrSearch from './__fixtures__/modrinth-search.json'
import mrVersions from './__fixtures__/modrinth-versions.json'
import type { CurseForgeFile, CurseForgeMod } from './curseforge'
import {
  curseForgeClassForProjectType,
  curseForgeFileToFile,
  curseForgeFileToVersion,
  curseForgeLoaderType,
  curseForgeModToProject,
  expandLoaders,
  loaderFromCurseForge,
  modrinthHitToProject,
  modrinthProjectToProject,
  modrinthVersionToVersion,
  projectTypeFromCurseForgeClass,
  projectTypeFromModrinth,
  type MarketProjectType,
} from './model'
import type { ModrinthProject, ModrinthSearchHit, ModrinthVersion } from './modrinth'

const hits = mrSearch.hits as unknown as ModrinthSearchHit[]
const mods = cfSearch.data as unknown as CurseForgeMod[]
const files = cfFiles.data as unknown as CurseForgeFile[]

describe('type and loader tables', () => {
  it('round-trips every project type through CurseForge classes', () => {
    const types: MarketProjectType[] = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'world']
    for (const t of types) expect(projectTypeFromCurseForgeClass(curseForgeClassForProjectType(t))).toBe(t)
    expect(curseForgeClassForProjectType('shader')).toBe(6552)
    expect(projectTypeFromCurseForgeClass(4546)).toBeNull()
    expect(projectTypeFromCurseForgeClass(undefined)).toBeNull()
  })

  it('maps Modrinth project types, detecting datapacks by loader', () => {
    expect(projectTypeFromModrinth('mod', ['fabric'])).toBe('mod')
    expect(projectTypeFromModrinth('mod', ['datapack'])).toBe('datapack')
    expect(projectTypeFromModrinth('mod', ['datapack', 'fabric'])).toBe('mod')
    expect(projectTypeFromModrinth('shader')).toBe('shader')
    expect(projectTypeFromModrinth('plugin')).toBeNull()
  })

  it('maps loaders both ways', () => {
    for (const l of ['forge', 'neoforge', 'fabric', 'quilt', 'liteloader', 'cauldron']) {
      expect(loaderFromCurseForge(curseForgeLoaderType(l))).toBe(l)
    }
    expect(curseForgeLoaderType('NeoForge')).toBe(6)
    expect(curseForgeLoaderType('iris')).toBeUndefined()
    expect(loaderFromCurseForge(0)).toBeNull()
  })

  it('expands Quilt and NeoForge 1.20.1', () => {
    expect(expandLoaders('quilt')).toEqual(['quilt', 'fabric'])
    expect(expandLoaders('neoforge', '1.20.1')).toEqual(['neoforge', 'forge'])
    expect(expandLoaders('neoforge', '1.21')).toEqual(['neoforge'])
    expect(expandLoaders('Forge')).toEqual(['forge'])
  })
})

describe('Modrinth mappers', () => {
  it('maps a search hit', () => {
    expect(modrinthHitToProject(hits[0]!)).toEqual({
      key: 'modrinth:AANobbMI',
      source: 'modrinth',
      id: 'AANobbMI',
      slug: 'sodium',
      title: 'Sodium',
      author: 'jellysquid3',
      summary: 'Modern rendering engine',
      iconUrl: 'https://cdn.modrinth.com/data/AANobbMI/icon.png',
      projectType: 'mod',
      downloads: 50000000,
      followers: 20000,
      categories: ['optimization'],
      loaders: ['fabric', 'quilt'],
      gameVersions: ['1.20.1', '1.20.4'],
      createdAt: '2021-01-03T00:00:00Z',
      updatedAt: '2024-05-01T00:00:00Z',
      side: { client: 'required', server: 'unsupported' },
      websiteUrl: 'https://modrinth.com/mod/sodium',
    })
    expect(modrinthHitToProject(hits[1]!).iconUrl).toBeNull()
    expect(modrinthHitToProject(hits[2]!).projectType).toBe('datapack')
  })

  it('maps a project', () => {
    const p = modrinthProjectToProject(mrProject as unknown as ModrinthProject)
    expect(p).toMatchObject({
      key: 'modrinth:AANobbMI',
      author: '',
      categories: ['optimization', 'utility'],
      loaders: ['fabric', 'quilt'],
      followers: 20000,
      updatedAt: '2024-05-01T00:00:00Z',
    })
  })

  it('maps a version with files and dependencies', () => {
    const v = modrinthVersionToVersion(mrVersions[1] as unknown as ModrinthVersion)
    expect(v).toMatchObject({
      key: 'modrinth:abcdEFGH',
      source: 'modrinth',
      projectId: 'AANobbMI',
      releaseType: 'beta',
      loaders: ['fabric', 'quilt'],
      changelog: 'Fixes',
      installable: true,
    })
    expect(v.files[1]).toEqual({
      source: 'modrinth',
      id: null,
      projectId: 'AANobbMI',
      versionId: 'abcdEFGH',
      fileName: 'sodium-0.5.3.jar',
      url: 'https://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/sodium-0.5.3.jar',
      websiteUrl: null,
      manualDownloadRequired: false,
      size: 200,
      sha1: '3333333333333333333333333333333333333333',
      sha512: 'bb',
      fingerprint: null,
      primary: true,
      fileType: null,
    })
    expect(v.files[0]?.fileType).toBe('sources-jar')
    expect(v.dependencies).toEqual([
      { projectId: 'P7dR8mSH', versionId: null, fileName: null, type: 'required' },
      { projectId: 'YL57xq9U', versionId: 'Iris0001', fileName: null, type: 'optional' },
      { projectId: null, versionId: null, fileName: 'lib.jar', type: 'embedded' },
    ])
  })
})

describe('CurseForge mappers', () => {
  it('maps a mod, deriving loaders and versions from latestFilesIndexes', () => {
    expect(curseForgeModToProject(mods[0]!)).toEqual({
      key: 'curseforge:394468',
      source: 'curseforge',
      id: '394468',
      slug: 'sodium',
      title: 'Sodium',
      author: 'jellysquid3',
      summary: 'Rendering',
      iconUrl: 'https://media.forgecdn.net/avatars/thumbnails/1.png',
      projectType: 'mod',
      downloads: 1000,
      followers: 12,
      categories: ['Map and Information'],
      loaders: ['fabric', 'quilt'],
      gameVersions: ['1.20.1'],
      createdAt: '2021-01-01T00:00:00Z',
      updatedAt: '2024-05-02T00:00:00Z',
      websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/sodium',
    })
    expect(curseForgeModToProject(mods[1]!).iconUrl).toBeNull()
  })

  it('keeps a null downloadUrl and points at the file page instead', () => {
    const restricted = files[0]!
    const f = curseForgeFileToFile(restricted, mods[1]!)
    expect(f).toEqual({
      source: 'curseforge',
      id: '4000012',
      projectId: '238222',
      versionId: '4000012',
      fileName: 'jei-1.20.1-forge-15.2.0.27.jar',
      url: null,
      websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/jei/download/4000012',
      manualDownloadRequired: true,
      size: 1234567,
      sha1: 'abcdef0123456789abcdef0123456789abcdef01',
      sha512: null,
      fingerprint: 3456789012,
      primary: true,
      fileType: null,
    })
    // Never a guessed CDN URL, with or without the mod.
    const bare = curseForgeFileToFile(restricted)
    expect(bare.url).toBeNull()
    expect(bare.websiteUrl).toBe('https://www.curseforge.com/projects/238222')
    expect(JSON.stringify(bare)).not.toContain('forgecdn')
  })

  it('builds the page URL from class and slug when links are missing', () => {
    const shader = { id: 9, slug: 'complementary', classId: 6552 }
    expect(curseForgeFileToFile(files[0]!, shader).websiteUrl).toBe(
      'https://www.curseforge.com/minecraft/shaders/complementary/download/4000012',
    )
  })

  it('maps a file to a version', () => {
    const v = curseForgeFileToVersion(files[0]!)
    expect(v).toMatchObject({
      key: 'curseforge:4000012',
      projectId: '238222',
      name: 'jei-1.20.1-15.2.0.27',
      releaseType: 'release',
      gameVersions: ['1.20.1'],
      loaders: ['forge', 'neoforge'],
      installable: true,
    })
    expect(v.dependencies).toEqual([
      { projectId: '306612', versionId: null, fileName: null, type: 'required' },
      { projectId: '1', versionId: null, fileName: null, type: 'optional', tool: true },
      { projectId: '2', versionId: null, fileName: null, type: 'embedded' },
      { projectId: '3', versionId: null, fileName: null, type: 'incompatible' },
    ])
    expect(curseForgeFileToVersion(files[1]!).releaseType).toBe('beta')
    expect(curseForgeFileToVersion(files[2]!).installable).toBe(false)
  })
})
