// @vitest-environment happy-dom
import type { MarketInstallResult, MarketVersionRow, ResourcePage } from '@shared/services'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  marketplace: { getVersions: vi.fn<(platform: string, id: string, query?: unknown) => Promise<unknown[]>>(), install: vi.fn<(input: unknown) => Promise<MarketInstallResult>>() },
  resources: { list: vi.fn<() => Promise<Pick<ResourcePage, 'items'>>>() },
}))
const toast = vi.hoisted(() => vi.fn<(t: unknown) => void>())
vi.mock('@/lib/rpc', () => ({ api }))
vi.mock('@/ui/toast-store', () => ({ toast }))
vi.mock('@/lib/error-text', () => ({ errorMessage: (e: unknown) => String(e), reportError: vi.fn<() => void>() }))
vi.mock('@/lib/files', () => ({ openExternal: vi.fn<() => void>() }))
vi.mock('./query', () => ({ queryClient: { invalidateQueries: vi.fn<() => void>() } }))
vi.mock('./content', () => ({ resourceKeys: { kind: () => ['resources'] } }))

const { installProject } = await import('./market')

const row = (id: string, dependencies: MarketVersionRow['dependencies'] = []): MarketVersionRow => ({
  id,
  platform: 'modrinth',
  projectId: 'PROJ0001',
  name: id,
  versionNumber: id,
  releaseType: 'release',
  publishedAt: '2026-01-01T00:00:00Z',
  downloads: 0,
  gameVersions: ['1.21.1'],
  loaders: ['fabric'],
  file: { fileName: `${id}.jar`, size: 1, sha1: null },
  manualDownloadRequired: false,
  dependencies,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.resources.list.mockResolvedValue({ items: [] })
  api.marketplace.install.mockResolvedValue({ resource: { kind: 'mods', id: 'x.jar' }, manual: [] })
})

describe('installProject dependencies', () => {
  it('reports a required dependency with no compatible version instead of skipping it silently', async () => {
    const target = { id: 'inst', name: 'Pack', minecraft: '26.1', loader: { kind: 'fabric', version: '0.17.0' } } as const
    // A null version id means "any compatible version"; here none exists for 26.1.
    api.marketplace.getVersions.mockImplementation(async (_p: string, id: string) => (id === 'PROJ0001' ? [row('VERSION1', [{ projectId: 'DEPPROJ1', versionId: null, type: 'required' }, { projectId: 'OPTPROJ1', versionId: null, type: 'optional' }])] : []))
    expect(await installProject({ platform: 'modrinth', id: 'PROJ0001', title: 'Mod', projectType: 'mod' }, target)).toBe(true)
    expect(api.marketplace.getVersions).toHaveBeenCalledWith('modrinth', 'DEPPROJ1', { gameVersion: '26.1', loader: 'fabric' })
    // Optional dependencies are never resolved or installed.
    expect(api.marketplace.getVersions).not.toHaveBeenCalledWith('modrinth', 'OPTPROJ1', expect.anything())
    expect(api.marketplace.install).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning', message: expect.stringContaining('1 required dependency has no version for 26.1 with fabric') }))
  })
})
