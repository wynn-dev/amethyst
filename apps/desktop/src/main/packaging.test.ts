/**
 * Packaging and release configuration that only matters in the signed, Finder-launched app, so
 * no unit of code exercises it: pin it here (known-issues §1 #781, #1765, #925; lesson 12).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const desktop = path.resolve(import.meta.dirname, '../..')
const repo = path.resolve(desktop, '../..')
const read = (...p: string[]) => readFileSync(path.join(...p), 'utf8')

/** The value of a `key: value` line in a YAML file (unquoted), or undefined. */
const yamlValue = (yaml: string, key: string) => new RegExp(`^\\s*${key}:\\s*['"]?(.*?)['"]?\\s*$`, 'm').exec(yaml)?.[1]

const workflow = (file: string) => read(repo, '.github', 'workflows', file)
/** The text of one job: from `  <name>:` to the next top-level job. */
const job = (yaml: string, name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(yaml)?.[1] ?? ''

describe('macOS packaging', () => {
  const builder = read(desktop, 'electron-builder.yml')
  const entitlements = read(desktop, 'build', 'entitlements.mac.plist')
  const entitled = (key: string) => new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`).test(entitlements)

  it('signs with the hardened runtime and notarizes', () => {
    expect(yamlValue(builder, 'hardenedRuntime')).toBe('true')
    expect(yamlValue(builder, 'notarize')).toBe('true')
    expect(entitled('com.apple.security.cs.allow-jit')).toBe(true)
  })

  it('flips the Electron fuses that stop the app binary being used as a Node or debug shell', () => {
    // The block under `electronFuses:` (two-space indented `key: value` lines).
    const block = /^electronFuses:\n((?: {2}.*\n|\s*#.*\n)+)/m.exec(builder)?.[1] ?? ''
    const fuse = (key: string) => yamlValue(block, key)?.replace(/\s*#.*$/, '')
    expect(fuse('runAsNode')).toBe('false')
    expect(fuse('enableNodeOptionsEnvironmentVariable')).toBe('false')
    expect(fuse('enableNodeCliInspectArguments')).toBe('false')
    expect(fuse('enableEmbeddedAsarIntegrityValidation')).toBe('true')
    expect(fuse('onlyLoadAppFromAsar')).toBe('true')
    expect(fuse('enableCookieEncryption')).toBe('true')
    // Left at its default (on): the renderer is a file:// page and its module scripts don't load
    // without it, so the packaged app opens a blank window (the packaged smoke test checks this).
    expect(fuse('grantFileProtocolExtraPrivileges')).toBeUndefined()
    // onlyLoadAppFromAsar needs the app to be an asar at all.
    expect(yamlValue(builder, 'asar')).toBe('true')
  })

  it('never runs the Electron binary as Node: the runtime is a utilityProcess', () => {
    // With the RunAsNode fuse off, ELECTRON_RUN_AS_NODE does nothing, so no shipped code may need it.
    const main = read(desktop, 'src', 'main', 'runtime.ts')
    expect(main).toMatch(/utilityProcess\.fork\(/)
    for (const file of ['runtime.ts', 'index.ts', 'os-services.ts', 'updater.ts']) {
      const src = read(desktop, 'src', 'main', file)
      expect({ file, runAsNode: /ELECTRON_RUN_AS_NODE|child_process/.test(src) }).toEqual({ file, runAsNode: false })
    }
  })

  it('lets games ask for the microphone (voice-chat mods) and the local network (LAN worlds)', () => {
    // Amethyst is the TCC responsible process for the Java child: without these macOS denies silently.
    expect(yamlValue(builder, 'NSMicrophoneUsageDescription')?.length).toBeGreaterThan(20)
    expect(entitled('com.apple.security.device.audio-input')).toBe(true)
    expect(yamlValue(builder, 'NSLocalNetworkUsageDescription')?.length).toBeGreaterThan(20)
  })
})

describe('release workflows', () => {
  const workflows = ['ci.yml', 'nightly.yml', 'natives-lwjgl2.yml', 'natives-lwjgl3-glfw.yml']

  it('passes --amethyst-smoke to every smoke run, since a packaged app ignores the variable alone', () => {
    for (const file of ['ci.yml', 'nightly.yml']) {
      const steps = workflow(file).split(/\n {6}- /).filter((s) => s.includes("AMETHYST_SMOKE: '1'"))
      for (const step of steps) expect({ file, step: step.split('\n')[0], flag: step.includes('--amethyst-smoke') }).toMatchObject({ flag: true })
    }
  })

  it('pins every action by commit SHA and never leaves git credentials on disk', () => {
    for (const file of workflows) {
      const yaml = workflow(file)
      for (const [, ref] of yaml.matchAll(/uses:\s*(\S+)/g)) expect({ file, ref, pinned: /@[0-9a-f]{40}$/.test(ref!) }).toMatchObject({ pinned: true })
      const checkouts = yaml.split(/\n {6}- /).filter((s) => s.startsWith('uses: actions/checkout@'))
      expect({ file, checkouts: checkouts.length }).toEqual({ file, checkouts: 1 })
      for (const step of checkouts) expect({ file, persist: /persist-credentials:\s*false/.test(step) }).toEqual({ file, persist: true })
    }
  })

  it('builds the nightly with a read-only token and publishes it from a separate, uncancellable job', () => {
    const yaml = workflow('nightly.yml')
    expect(yamlValue(yaml.split(/^jobs:/m)[0]!, 'contents')).toBe('read')
    const build = job(yaml, 'build')
    const publish = job(yaml, 'publish')
    expect(build).toMatch(/permissions:\s*\n\s*contents: read/)
    expect(build).not.toMatch(/contents: write/)
    expect(build).toMatch(/upload-artifact@/)
    expect(publish).toMatch(/needs: build/)
    expect(publish).toMatch(/contents: write/)
    expect(publish).toMatch(/group: nightly-publish\s*\n\s*cancel-in-progress: false/)
    // Publishing runs no repository code and holds no signing secrets.
    expect(publish).not.toMatch(/actions\/checkout@|secrets\./)
    // No delete-then-create gap: the release is updated in place and the tag moved through the API.
    expect(yaml).not.toMatch(/gh release delete|git push/)
    expect(publish).toMatch(/gh release upload "\$TAG" "\$\{ASSETS\[@\]\}" --clobber/)
    expect(publish).toMatch(/git\/refs\/tags\/\$TAG/)
  })

  it('never replaces a published natives release, and only publishes natives from main', () => {
    for (const file of ['natives-lwjgl2.yml', 'natives-lwjgl3-glfw.yml']) {
      const yaml = workflow(file)
      expect({ file, clobber: yaml.includes('--clobber') }).toEqual({ file, clobber: false })
      expect({ file, main: /if: github\.ref == 'refs\/heads\/main'/.test(job(yaml, 'build')) }).toEqual({ file, main: true })
      expect(yaml).toMatch(/already exists[\s\S]*?exit 1/)
    }
  })

  it('bound every smoke test of the app with a timeout, so a hung window fails the run', () => {
    for (const file of ['ci.yml', 'nightly.yml']) {
      const steps = read(repo, '.github', 'workflows', file).split(/\n {6}- /)
      const smoke = steps.filter((s) => s.includes('AMETHYST_SMOKE'))
      expect({ file, count: smoke.length > 0 }).toEqual({ file, count: true })
      for (const step of smoke) expect({ file, step: step.split('\n')[0], timeout: /timeout-minutes:\s*\d+/.test(step) }).toMatchObject({ timeout: true })
    }
  })
})
