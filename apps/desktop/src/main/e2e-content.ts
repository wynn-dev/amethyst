/* oxlint-disable no-await-in-loop, no-console -- a sequential, dev-only UI driver */
/**
 * Dev-only end-to-end UI run of the content and Discover areas (`AMETHYST_E2E_UI=content`).
 *
 *   pnpm --filter @amethyst/desktop build
 *   AMETHYST_E2E_UI=content electron apps/desktop        (unset ELECTRON_RUN_AS_NODE first)
 *
 * It uses a throwaway data root (or `AMETHYST_E2E_ROOT`) and drives the real renderer with real
 * mouse and keyboard events against the real runtime and network:
 *
 *   1. create a Fabric 1.21.1 instance through the runtime API
 *   2. search Discover for "sodium", install it, and find it in the Mods tab
 *   3. disable and re-enable it, move it to the Trash, then Undo
 *   4. import a generated world zip, back it up, restore the backup as a copy
 *   5. import a generated Fabric 1.21.1 .mrpack (Lithium plus an override) via preview → import
 *   6. export the instance as an .mrpack
 *
 * Every step is captured in light and dark into `AMETHYST_E2E_OUT` (default `<root>/screenshots`).
 * Native panels are answered through `queueDialogAnswer`. Prints `E2E PASS` or `E2E FAIL …`.
 */
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeTheme, type BrowserWindow } from 'electron'
import { queueDialogAnswer } from './os-services'
import { sendMenuCommand } from './windows'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Step extends Error {}

export async function runContentE2E(win: BrowserWindow, root: string, onDone: (ok: boolean) => void): Promise<void> {
  const out = process.env.AMETHYST_E2E_OUT || join(root, 'screenshots')
  const work = join(root, 'e2e-files')
  await mkdir(out, { recursive: true })
  await mkdir(work, { recursive: true })
  const c = win.webContents
  c.setBackgroundThrottling(false)
  c.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.warn(`E2E renderer ${e.level}: ${e.message}`)
  })
  win.setContentSize(1200, 780)
  win.show()
  win.focus()
  const shots: string[] = []
  let step = 'start'

  const js = <T>(code: string): Promise<T> => c.executeJavaScript(code, true) as Promise<T>
  const log = (msg: string) => console.warn(`E2E ${msg}`)

  /** Poll a renderer expression until it is truthy. */
  async function waitFor(what: string, code: string, timeoutMs = 20_000): Promise<unknown> {
    const end = Date.now() + timeoutMs
    let last: unknown
    while (Date.now() < end) {
      try {
        last = await js(`(() => { try { return !!(${code}) } catch { return false } })()`)
        if (last) return last
      } catch {
        // navigation in progress
      }
      await sleep(250)
    }
    throw new Step(`timed out waiting for ${what}`)
  }

  const invoke = async <T>(service: string, method: string, ...args: unknown[]): Promise<T> => {
    const r = await js<{ ok: boolean; value?: T; error?: { message: string; code?: string } }>(`window.amethyst.invoke(${JSON.stringify(service)}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`)
    if (!r.ok) throw new Step(`${service}.${method} failed: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`)
    return r.value as T
  }

  /** Install DOM helpers (once per page load). */
  const helpers = `window.__e2e = {
    visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' },
    all(sel) { return [...document.querySelectorAll(sel)].filter((e) => this.visible(e)) },
    text(el) { return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() },
    byText(sel, text, exact) { return this.all(sel).find((e) => exact ? this.text(e) === text : this.text(e).includes(text)) },
    byLabel(sel, label) { return this.all(sel).find((e) => (e.getAttribute('aria-label') || '').startsWith(label)) },
    rect(el) { if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } },
    rowOf(text) { return this.all('[role=row]').find((r) => r.getAttribute('aria-rowindex') !== '1' && this.text(r).includes(text)) },
  }`
  const ensureHelpers = () => js(`if (!window.__e2e) { ${helpers} }; true`)

  async function clickAt(pos: { x: number; y: number } | null, what: string) {
    if (!pos) throw new Step(`cannot find ${what}`)
    c.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y })
    c.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(40)
    c.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(250)
  }
  /** Click the element an expression (using `__e2e`) returns, waiting for it to appear. */
  async function click(what: string, finder: string, timeoutMs = 20_000) {
    await ensureHelpers()
    await waitFor(what, `(() => { const e = ${finder}; return e && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && e.getAttribute('data-disabled') === null })()`, timeoutMs)
    await clickAt(await js(`__e2e.rect(${finder})`), what)
  }
  const button = (text: string, exact = true, scope = 'document') => `[...${scope === 'document' ? 'document' : scope}.querySelectorAll('button,[role=menuitem],[role=checkbox],[role=radio]')].filter((e) => __e2e.visible(e)).find((e) => ${exact ? `__e2e.text(e) === ${JSON.stringify(text)}` : `__e2e.text(e).includes(${JSON.stringify(text)})`} || (e.getAttribute('aria-label') || '') === ${JSON.stringify(text)})`

  async function typeInto(placeholder: string, text: string) {
    await ensureHelpers()
    const finder = `document.querySelector('input[placeholder=${JSON.stringify(placeholder)}]')`
    await waitFor(`the “${placeholder}” field`, finder)
    await clickAt(await js(`__e2e.rect(${finder})`), placeholder)
    await js(`(() => { const e = ${finder}; e.focus(); e.select(); return true })()`)
    c.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    c.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await c.insertText(text)
    await sleep(300)
  }

  async function go(hash: string) {
    await js(`location.hash = ${JSON.stringify(hash)}; true`)
    await sleep(400)
    await ensureHelpers()
  }

  /** Light and dark captures of the current state. */
  async function shoot(name: string) {
    await sleep(500)
    const n = String(shots.length / 2 + 1).padStart(2, '0')
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
      await sleep(350)
      const image = await c.capturePage()
      const file = join(out, `${n}-${name}-${theme}.png`)
      await writeFile(file, image.toPNG())
      shots.push(file)
    }
    nativeTheme.themeSource = 'light'
    log(`shot ${name}`)
  }

  try {
    // 0. A completed first run, and the runtime up.
    step = 'boot'
    if (!c.getURL() || c.isLoading()) await new Promise<void>((r) => c.once('did-finish-load', () => r()))
    await js(`localStorage.setItem('amethyst:first-run', JSON.stringify({ state: { completed: true, step: 'done' }, version: 1 })); true`)
    const loaded = new Promise<void>((r) => c.once('did-finish-load', () => r()))
    c.reload()
    await loaded
    await js(`document.documentElement.dataset.screenshot = ''; true`)
    await invoke('runtime', 'ping')
    await ensureHelpers()

    // 1. A Fabric 1.21.1 instance through the runtime API.
    step = 'create instance'
    const loaders = await invoke<{ items: { version: string; stable: boolean }[] }>('versions', 'listLoaders', 'fabric', '1.21.1')
    const fabric = (loaders.items.find((l) => l.stable) ?? loaders.items[0])?.version
    if (!fabric) throw new Step('no Fabric loader for 1.21.1')
    const inst = await invoke<{ id: string; name: string }>('instances', 'create', { name: 'E2E Fabric', runtime: { minecraft: '1.21.1', fabric } })
    log(`instance ${inst.id} (fabric ${fabric})`)

    // 2. Discover → search "sodium" → install → Mods tab.
    step = 'discover sodium'
    await go(`#/discover?type=mod&target=${encodeURIComponent(inst.id)}`)
    await waitFor('the target bar', `__e2e.byText('div', 'Installing to:')`)
    await typeInto('Search mods', 'sodium')
    const sodiumRow = `[...document.querySelectorAll('[role=listitem]')].find((r) => [...r.querySelectorAll('a')].some((a) => __e2e.text(a) === 'Sodium'))`
    await waitFor('Sodium in the results', sodiumRow, 30_000)
    await shoot('discover-search-sodium')
    await click('Install on the Sodium row', `[...${sodiumRow}.querySelectorAll('button')].find((b) => __e2e.text(b).includes('Install'))`)
    await waitFor('Sodium to be installed', `[...${sodiumRow}.querySelectorAll('button')].some((b) => __e2e.text(b).includes('Installed'))`, 120_000)
    await shoot('discover-sodium-installed')
    await go(`#/instances/${inst.id}/mods`)
    await waitFor('Sodium in the Mods tab', `__e2e.rowOf('Sodium')`, 30_000)
    await waitFor('the Sodium icon', `__e2e.rowOf('Sodium').querySelector('img')`, 10_000).catch(() => undefined)
    await clickAt(await js(`__e2e.rect(__e2e.rowOf('Sodium').querySelectorAll('[role=gridcell]')[1])`), 'the Sodium row')
    await waitFor('the inspector', `__e2e.byText('aside[aria-label="Mod details"] h2', 'Sodium')`)
    await sleep(600)
    await shoot('mods-sodium')

    // 3. Disable, re-enable, Trash, Undo.
    step = 'disable and trash'
    const box = `document.querySelector('[role=checkbox][aria-label="Enable Sodium"]')`
    await click('the Sodium checkbox', box)
    await waitFor('Sodium disabled', `${box}.getAttribute('aria-checked') === 'false' && __e2e.rowOf('Sodium').className.includes('opacity')`, 10_000)
    await shoot('mods-sodium-disabled')
    await click('the Sodium checkbox', box)
    await waitFor('Sodium enabled', `${box}.getAttribute('aria-checked') === 'true'`, 10_000)
    await click('Move to Trash… in the inspector', button('Move to Trash…', true, `document.querySelector('aside[aria-label="Mod details"]')`))
    await click('the confirmation', `[...document.querySelectorAll('[role=alertdialog] button')].find((b) => __e2e.text(b) === 'Move to Trash')`)
    await waitFor('the Undo toast', button('Undo'), 15_000)
    await waitFor('Sodium gone', `!__e2e.rowOf('Sodium')`, 10_000)
    await shoot('mods-sodium-trashed-undo-toast')
    await click('Undo', button('Undo'))
    await waitFor('Sodium back', `__e2e.rowOf('Sodium')`, 15_000)
    await waitFor('the Restored toast', `__e2e.byText('li,[role=status],div', 'Restored “Sodium”')`, 10_000).catch(() => undefined)
    await shoot('mods-sodium-restored')

    // 4. Worlds: import a generated zip, back up, restore as a copy.
    step = 'worlds'
    const worldZip = await makeWorldZip(work)
    await go(`#/instances/${inst.id}/worlds`)
    await waitFor('the Worlds tab', `__e2e.byText('h2,p,span', 'No worlds yet') || __e2e.byText('button', 'Add World')`)
    queueDialogAnswer([worldZip])
    await click('Add World', button('Add World'))
    await click('Import World Archive', button('Import World Archive (.zip)…'))
    await waitFor('the imported world', `__e2e.rowOf('E2E World')`, 30_000)
    await clickAt(await js(`__e2e.rect(__e2e.rowOf('E2E World').querySelector('[role=gridcell]'))`), 'the world row')
    await waitFor('the world inspector', `__e2e.byText('aside[aria-label="World details"] h2', 'E2E World')`)
    await shoot('worlds-imported')
    await click('Back Up', button('Back Up', true, `document.querySelector('aside[aria-label="World details"]')`))
    await waitFor('the backup', `__e2e.byText('aside[aria-label="World details"] li', 'Manual')`, 30_000)
    await shoot('worlds-backed-up')
    await click('the backup menu', `__e2e.byLabel('button', 'Restore or delete the backup')`)
    await click('Restore as a Copy', button('Restore as a Copy'))
    await waitFor('the restored copy', `__e2e.all('[role=row]').filter((r) => __e2e.text(r).includes('restored')).length > 0`, 30_000)
    await shoot('worlds-restored-copy')

    // 5. Import a generated .mrpack (Lithium + an override) via preview → import.
    step = 'modpack import'
    const mrpack = await makeMrpack(work, fabric)
    await go(`#/`)
    queueDialogAnswer([mrpack])
    sendMenuCommand(c, { command: 'file.importModpack' })
    await waitFor('the import review', `__e2e.byText('[role=dialog]', 'E2E Pack') && ${button('Import')}`, 60_000)
    await shoot('modpack-import-review')
    await click('Import', button('Import'))
    await waitFor('the import to finish', `__e2e.byText('li,div', 'Imported “E2E Pack”')`, 20 * 60_000)
    await shoot('modpack-imported-toast')
    const instances = await invoke<{ id: string; name: string }[]>('instances', 'list')
    const pack = instances.find((i) => i.name === 'E2E Pack')
    if (!pack) throw new Step('the imported instance is missing')
    await go(`#/instances/${pack.id}/mods`)
    await waitFor('Lithium in the pack', `__e2e.rowOf('Lithium')`, 30_000)
    const override = await stat(join(root, 'instances', 'E2E Pack', 'config', 'e2e-override.txt')).catch(() => undefined)
    if (!override) log('note: override file not found at the expected path')
    await shoot('modpack-mods')

    // 6. Export the imported instance as an .mrpack.
    step = 'export'
    const exported = join(work, 'E2E Export.mrpack')
    await go(`#/instances/${pack.id}/overview`)
    await sleep(500)
    sendMenuCommand(c, { command: 'file.exportModpack' })
    await waitFor('the export sheet', `__e2e.byText('[role=dialog]', 'Files to include') && __e2e.byText('[role=dialog] li', 'mods/')`, 20_000)
    await shoot('export-sheet')
    queueDialogAnswer(exported)
    await click('Export…', button('Export…'))
    await waitFor('the export toast', `__e2e.byText('li,div', 'Exported “E2E Pack”')`, 120_000)
    const size = (await stat(exported)).size
    log(`exported ${exported} (${size} bytes)`)
    await shoot('export-done')

    console.warn(`E2E PASS ${shots.length} screenshots in ${out}`)
    console.warn(`E2E SHOTS ${JSON.stringify(shots)}`)
    onDone(true)
  } catch (e) {
    try {
      const file = join(out, `failed-${step.replace(/\W+/g, '-')}.png`)
      await writeFile(file, (await c.capturePage()).toPNG())
      console.warn(`E2E failure screenshot ${file}`)
    } catch {
      // ignore
    }
    console.warn(`E2E FAIL at ${step}: ${(e as Error).message}`)
    onDone(false)
  }
}

/** A minimal world: `E2E World/level.dat` with a level name and version, zipped. */
async function makeWorldZip(dir: string): Promise<string> {
  const { nbt, writeNbt } = await import('@amethyst/nbt')
  const { createZip } = await import('@amethyst/zip')
  const data = await writeNbt(
    {
      root: nbt.compound({
        Data: nbt.compound({
          LevelName: nbt.string('E2E World'),
          Version: nbt.compound({ Name: nbt.string('1.21.1'), Id: nbt.int(3955) }),
          DataVersion: nbt.int(3955),
          GameType: nbt.int(0),
          Difficulty: nbt.byte(2),
          allowCommands: nbt.byte(0),
          LastPlayed: nbt.long(BigInt(Date.now())),
          WorldGenSettings: nbt.compound({ seed: nbt.long(123456789n) }),
        }),
      }),
    },
    { compression: 'gzip' },
  )
  const file = join(dir, 'E2E World.zip')
  const z = createZip(file)
  z.addBuffer(Buffer.from(data), 'E2E World/level.dat')
  await z.finish()
  return file
}

/** A Fabric 1.21.1 `.mrpack`: Lithium from Modrinth plus one override file. */
async function makeMrpack(dir: string, fabric: string): Promise<string> {
  const { createZip } = await import('@amethyst/zip')
  const res = await fetch('https://api.modrinth.com/v2/project/lithium/version?loaders=%5B%22fabric%22%5D&game_versions=%5B%221.21.1%22%5D', { headers: { 'user-agent': 'wynn-dev/amethyst e2e' } })
  if (!res.ok) throw new Step(`Modrinth lookup failed: HTTP ${res.status}`)
  const versions = (await res.json()) as { files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha1: string; sha512: string } }[] }[]
  const file = versions[0]?.files.find((f) => f.primary) ?? versions[0]?.files[0]
  if (!file) throw new Step('no Lithium file for 1.21.1')
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: 'E2E Pack',
    summary: 'A generated pack for the content e2e run',
    files: [{ path: `mods/${file.filename}`, hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 }, env: { client: 'required', server: 'required' }, downloads: [file.url], fileSize: file.size }],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': fabric },
  }
  const out = join(dir, 'E2E Pack.mrpack')
  const z = createZip(out)
  z.addBuffer(Buffer.from(JSON.stringify(index, null, 2)), 'modrinth.index.json')
  z.addBuffer(Buffer.from(`made by the e2e driver ${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}\n`), 'overrides/config/e2e-override.txt')
  await z.finish()
  return out
}
