/** Mock marketplace clients and API objects for offline tests. */
import { curseforgeFingerprintSync, MarketplaceError, type CurseForgeFile, type CurseForgeMod, type ModrinthVersion } from '@amethyst/marketplace'
import type { CurseForgeLookup, ModrinthLookup } from '../resolve'
import { sha } from './build'

export function cfFile(id: number, modId: number, fileName: string, data: string | Uint8Array, downloadUrl: string | null = `https://edge.forgecdn.net/files/${id}/${fileName}`): CurseForgeFile {
  return {
    id,
    modId,
    isAvailable: true,
    displayName: fileName,
    fileName,
    releaseType: 1,
    fileStatus: 4,
    hashes: [
      { value: sha('sha1', data), algo: 1 },
      { value: sha('md5', data), algo: 2 },
    ],
    fileDate: '2024-01-01T00:00:00Z',
    fileLength: Buffer.byteLength(data),
    downloadUrl,
    gameVersions: ['1.20.1'],
    dependencies: [],
    fileFingerprint: curseforgeFingerprintSync(typeof data === 'string' ? Buffer.from(data) : data),
  }
}

export function cfMod(id: number, classId: number, name = `Mod ${id}`): CurseForgeMod {
  return {
    id,
    gameId: 432,
    name,
    slug: `mod-${id}`,
    links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/mod-${id}` },
    summary: '',
    status: 4,
    downloadCount: 0,
    classId,
    categories: [],
    authors: [],
    dateCreated: '2024-01-01T00:00:00Z',
    dateModified: '2024-01-01T00:00:00Z',
  }
}

/** A CurseForge mock that answers 400 to any batch containing one of `badFileIds`. */
export function mockCurseForge(files: CurseForgeFile[], mods: CurseForgeMod[], badFileIds: number[] = []) {
  const calls: { getFiles: number[][]; getMods: number[][] } = { getFiles: [], getMods: [] }
  const client: CurseForgeLookup = {
    async getFiles(ids) {
      calls.getFiles.push([...ids])
      if (ids.some((i) => badFileIds.includes(i))) {
        throw new MarketplaceError('EHTTP', 'HTTP 400', { platform: 'curseforge', status: 400 })
      }
      return files.filter((f) => ids.includes(f.id))
    },
    async getMods(ids) {
      calls.getMods.push([...ids])
      return mods.filter((m) => ids.includes(m.id))
    },
  }
  return { client, calls }
}

export function mrVersion(projectId: string, versionId: string, url: string, data: string | Uint8Array): ModrinthVersion {
  return {
    id: versionId,
    project_id: projectId,
    name: versionId,
    version_number: '1.0',
    version_type: 'release',
    date_published: '2024-01-01T00:00:00Z',
    downloads: 0,
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [{ url, filename: url.split('/').pop() as string, primary: true, size: Buffer.byteLength(data), hashes: { sha1: sha('sha1', data), sha512: sha('sha512', data) } }],
    dependencies: [],
  }
}

/** A Modrinth mock answering `version_files` from `bySha1`. */
export function mockModrinth(bySha1: Record<string, ModrinthVersion>): ModrinthLookup & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async getVersionsFromHashes(hashes) {
      calls.push([...hashes])
      return Object.fromEntries(hashes.filter((h) => bySha1[h]).map((h) => [h, bySha1[h] as ModrinthVersion]))
    },
  }
}
