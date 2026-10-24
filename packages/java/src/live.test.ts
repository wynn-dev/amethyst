// Live installs against Mojang and Azul. Run with AMETHYST_NET_TESTS=1 pnpm test.
// Downloads roughly 100 MB into a temp directory and runs the installed JVMs.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/helpers'
import { installJavaRuntime } from './install'
import { readMachO } from './macho'
import { verifyRuntime } from './managed'
import { fetchRuntimeIndex, type RuntimeIndex } from './mojang'
import { arm64Availability } from './resolve'

const run = promisify(execFile)

async function check(javaPath: string, expectVersion: RegExp): Promise<void> {
  const { stderr } = await run(javaPath, ['-XshowSettings:properties', '-version'], { cwd: '/' })
  expect(stderr).toMatch(/os\.arch = aarch64/)
  expect(stderr).toMatch(expectVersion)
  expect((await readMachO(javaPath))?.archs).toContain('arm64')
}

describe.runIf(process.env.AMETHYST_NET_TESTS)('live Java installs', () => {
  let dir: string
  let cleanup: () => Promise<void>
  let index: RuntimeIndex
  beforeAll(async () => {
    ;({ dir, cleanup } = await tempDir('amethyst-java-live-'))
    index = await fetchRuntimeIndex()
  })
  afterAll(() => cleanup())

  it('builds the Apple Silicon availability table from the live index', () => {
    const table = arm64Availability(index)
    // oxlint-disable-next-line no-console -- the table is the point of this test
    console.log(table.map((r) => `${r.component.padEnd(30)} ${String(r.majorVersion).padEnd(3)} arm64=${r.arm64 ?? '-'} x64=${r.x64 ?? '-'}`).join('\n'))
    expect(table.find((r) => r.component === 'java-runtime-delta')?.arm64).toBeDefined()
  })

  it('installs Java 21 from Mojang (mac-os-arm64) and runs it natively', async () => {
    const started = Date.now()
    const r = await installJavaRuntime({ majorVersion: 21, component: 'java-runtime-delta' }, { runtimesDir: join(dir, 'runtimes'), index })
    expect(r.choice.source).toBe('mojang')
    expect(r.java).toMatchObject({ valid: true, verified: true, arch: 'arm64', majorVersion: 21, managed: true })
    await check(r.runtime.javaPath, /version "21/)
    const { stderr } = await run(r.runtime.javaPath, ['-version'])
    // oxlint-disable-next-line no-console
    console.log(`Mojang Java 21 installed in ${Date.now() - started} ms, files ${JSON.stringify(r.transfer)}\n${stderr}`)
    expect(await verifyRuntime(r.runtime.dir, { full: true })).toMatchObject({ ok: true })
    const again = await installJavaRuntime({ majorVersion: 21, component: 'java-runtime-delta' }, { runtimesDir: join(dir, 'runtimes'), index })
    expect(again.reused).toBe(true)
  }, 600_000)

  it('installs Java 8 from Azul Zulu (no arm64 jre-legacy at Mojang) and runs it natively', async () => {
    const started = Date.now()
    const r = await installJavaRuntime({ majorVersion: 8, component: 'jre-legacy' }, { runtimesDir: join(dir, 'runtimes'), index })
    expect(r.choice.source).toBe('zulu')
    expect(r.java).toMatchObject({ valid: true, verified: true, arch: 'arm64', majorVersion: 8, managed: true })
    await check(r.runtime.javaPath, /version "1\.8\.0_/)
    const { stderr } = await run(r.runtime.javaPath, ['-version'])
    // oxlint-disable-next-line no-console
    console.log(`Zulu Java 8 installed in ${Date.now() - started} ms (${r.runtime.installed.zulu?.name})\n${stderr}`)
    expect(await verifyRuntime(r.runtime.dir, { full: true })).toMatchObject({ ok: true })
  }, 600_000)
})
