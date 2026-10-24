/**
 * End-to-end installs against the real services. Opt in with `AMETHYST_NET_TESTS=1`; the
 * Forge/NeoForge installs also need `AMETHYST_JAVA=/path/to/java` (Java 17+ runs their processors).
 * `AMETHYST_NET_ROOT=/some/dir` reuses (and keeps) a Minecraft directory between runs.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnose, resolveVersion } from '@amethyst/game'
import { createTask } from '@amethyst/task'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/helpers'
import { createMetadataClient, type InstallPlan, planInstall, runInstall } from './index'

const NET = !!process.env.AMETHYST_NET_TESTS
const JAVA = process.env.AMETHYST_JAVA
const MINUTES = 60_000

let root: string
const meta = createMetadataClient()

async function install(plan: InstallPlan) {
  const started = Date.now()
  const task = createTask('install', (ctx) => runInstall(plan, { root, ctx, meta, java: JAVA, onProcessorLog: () => {} }))
  const result = await task.promise
  console.warn(`[live] ${result.versionId}: ${((Date.now() - started) / 1000).toFixed(1)} s, planned ${(plan.totalBytes / 1e6).toFixed(1)} MB`)
  const resolved = await resolveVersion(join(root, 'versions'), result.versionId)
  const issues = await diagnose(resolved, root, { jvmArch: 'arm64', hash: 'always' })
  expect(issues.filter((i) => i.problem !== 'unavailable')).toEqual([])
  return result
}

describe.runIf(NET)('live installs', () => {
  beforeAll(async () => {
    root = process.env.AMETHYST_NET_ROOT ?? (await tempDir('amethyst-live-'))
  })
  afterAll(async () => {
    if (!process.env.AMETHYST_NET_ROOT) await rm(root, { recursive: true, force: true })
  })

  it('reads every metadata source', async () => {
    const manifest = (await meta.minecraftManifest()).data
    expect(manifest.versions.some((v) => v.id === '1.21.1')).toBe(true)
    expect((await meta.loaderVersions('fabric')).length).toBeGreaterThan(0)
    expect((await meta.loaderVersions('quilt')).length).toBeGreaterThan(0)
    expect((await meta.forgeVersions('1.20.1')).some((v) => v.version === '47.3.0')).toBe(true)
    const neo = await meta.neoForgeVersions('1.21.1')
    expect(neo.length).toBeGreaterThan(0)
    expect(neo.every((v) => v.version.startsWith('21.1.'))).toBe(true)
    expect((await meta.neoForgeVersions('1.20.1')).every((v) => v.project === 'forge')).toBe(true)
  })

  it('installs vanilla 1.21.1', { timeout: 30 * MINUTES }, async () => {
    const result = await install(await planInstall({ minecraft: '1.21.1' }, { root, meta }))
    expect(result).toMatchObject({ versionId: '1.21.1', javaMajor: 21 })
  })

  it('installs Fabric for 1.21.1', { timeout: 10 * MINUTES }, async () => {
    const loader = (await meta.loaderVersions('fabric')).find((l) => l.stable)?.version as string
    const result = await install(await planInstall({ minecraft: '1.21.1', loader: { kind: 'fabric', version: loader } }, { root, meta }))
    expect(result.versionId).toBe(`1.21.1-fabric${loader}`)
  })

  describe.runIf(!!JAVA)('with Java', () => {
    it('installs NeoForge for 1.21.1', { timeout: 20 * MINUTES }, async () => {
      const neo = (await meta.neoForgeVersions('1.21.1')).find((v) => !v.prerelease)?.version as string
      const result = await install(await planInstall({ minecraft: '1.21.1', loader: { kind: 'neoforge', version: neo } }, { root, meta }))
      expect(result).toMatchObject({ versionId: `neoforge-${neo}`, loader: { format: 'modern' } })
    })

    it('installs Forge 1.20.1-47.3.0', { timeout: 30 * MINUTES }, async () => {
      const result = await install(await planInstall({ minecraft: '1.20.1', loader: { kind: 'forge', version: '47.3.0' } }, { root, meta }))
      expect(result).toMatchObject({ versionId: '1.20.1-forge-47.3.0', loader: { format: 'modern' } })
    })
  })
})
