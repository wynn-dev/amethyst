/* oxlint-disable no-await-in-loop -- the driver is sequential by design */
/**
 * Dev-only end-to-end run of the real UI (`AMETHYST_E2E_UI=core:<screenshot dir>`; a bare `<dir>` also works).
 *
 * Drives the real renderer through DOM events against the real runtime in a temporary data root
 * (`AMETHYST_E2E_CACHE=<data root>` clones its `minecraft/` and `runtimes/` folders in with APFS
 * clones, so no game files are downloaded twice). It completes first run with consent off, adds
 * the offline account "Tester", creates a vanilla 1.21.1 instance in the New Instance sheet, waits
 * for the install task, presses Play, waits for `launch:state` running + ready (the game window),
 * opens the Logs tab, presses Stop, and captures every step in light and dark. Prints `E2E {…}`
 * and exits non-zero when a step fails.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, Menu, nativeTheme, type WebContents } from 'electron'
import type { MenuCommandEvent } from '@shared/menu'
import { showHiddenWindows } from './runtime'
import { openSettingsWindow, sendMenuCommand } from './windows'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fresh data root, pre-seeded from a cache root when one is given. Runs before the runtime starts. */
export function prepareE2eDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'amethyst-e2e-ui-'))
  const cache = process.env.AMETHYST_E2E_CACHE
  if (cache) {
    for (const dir of ['minecraft', 'runtimes']) {
      const src = join(cache, dir)
      // `cp -c` makes APFS clones: instant and no extra disk space. The cache itself is never written.
      if (existsSync(src)) execFileSync('/bin/cp', ['-cR', src, join(root, dir)])
    }
  }
  return root
}

/** DOM helpers injected into the page (plain JS so it survives the context-isolation boundary). */
const HELPERS = String.raw`
(() => {
  // capturePage can't see the native vibrancy material: paint the opaque stand-in (as screenshot mode does).
  document.documentElement.dataset.screenshot = ''
  if (window.__e2e) return
  const visible = (el) => !!el && el.isConnected && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const find = (selector, text, exact) => {
    const all = [...document.querySelectorAll(selector)].filter(visible)
    if (text === undefined) return all[0]
    return all.find((el) => {
      const t = norm(el.textContent), a = norm(el.getAttribute('aria-label'))
      return exact ? t === text || a === text : t.includes(text) || a.includes(text)
    })
  }
  const click = (el) => {
    const r = el.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerdown', o))
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.focus?.()
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }))
  }
  const type = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    el.focus()
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const events = []
  window.amethyst.on((event, payload) => {
    if (event === 'launch:state' || event === 'accounts:changed' || event === 'instances:changed') events.push({ event, payload, at: Date.now() })
  })
  window.__e2e = { find, click, type, events, norm }
})(); true`

interface Step {
  name: string
  ok: boolean
  ms: number
  error?: string
}

export async function runE2eUi(main: BrowserWindow, dir: string, onDone: (ok: boolean) => void): Promise<void> {
  await mkdir(dir, { recursive: true })
  const contents = main.webContents
  contents.setBackgroundThrottling(false)
  if (!contents.getURL() || contents.isLoading()) await new Promise<void>((r) => contents.once('did-finish-load', () => r()))
  main.setContentSize(1200, 780)
  main.show()
  nativeTheme.themeSource = 'light'

  const steps: Step[] = []
  const facts: Record<string, unknown> = {}
  let shot = 0

  const js = <T>(code: string, wc: WebContents = contents): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const inject = (wc: WebContents = contents) => js<boolean>(HELPERS, wc)
  const invoke = <T>(service: string, method: string, args: unknown[] = []): Promise<T> =>
    js<{ ok: boolean; value?: T; error?: { message: string; code?: string } }>(`window.amethyst.invoke(${JSON.stringify(service)}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`).then((r) => {
      if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`)
      return r.value as T
    })

  /** Wait until `expr` (page JS) is truthy; returns its value. */
  async function waitFor<T>(what: string, expr: string, timeoutMs = 20_000, wc: WebContents = contents): Promise<T> {
    const end = Date.now() + timeoutMs
    let last: unknown
    while (Date.now() < end) {
      try {
        // DOM nodes can't cross the boundary: report them as `true`.
        last = await js(`(() => { try { const v = (${expr}); return v instanceof Node ? true : v } catch { return undefined } })()`, wc)
        if (last) return last as T
      } catch {
        // Navigation in progress.
      }
      await sleep(150)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  const clickText = async (selector: string, text: string, opts: { exact?: boolean; timeoutMs?: number; wc?: WebContents } = {}) => {
    const wc = opts.wc ?? contents
    await waitFor(`${selector} “${text}”`, `window.__e2e.find(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${!!opts.exact})`, opts.timeoutMs ?? 15_000, wc)
    await js(`window.__e2e.click(window.__e2e.find(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${!!opts.exact})); true`, wc)
  }
  const typeInto = async (selector: string, value: string) => {
    await waitFor(selector, `window.__e2e.find(${JSON.stringify(selector)})`)
    await js(`window.__e2e.type(window.__e2e.find(${JSON.stringify(selector)}), ${JSON.stringify(value)}); true`)
  }

  async function settle(wc: WebContents, extra = 0) {
    await Promise.race([js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', wc), sleep(800)])
    await sleep(450 + extra)
  }

  /** Capture the window in light and dark. */
  async function capture(name: string, win: BrowserWindow = main) {
    shot++
    const n = String(shot).padStart(2, '0')
    await inject(win.webContents).catch(() => {})
    // No stray focus rings or tooltips from the driver's clicks.
    await js(`document.activeElement?.blur?.(); true`, win.webContents).catch(() => {})
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme
      await settle(win.webContents, 150)
      const image = await Promise.race([win.webContents.capturePage(), sleep(10_000).then(() => undefined)])
      if (image) await writeFile(join(dir, `${theme}-${n}-${name}.png`), image.toPNG())
    }
    nativeTheme.themeSource = 'light'
  }

  async function step(name: string, fn: () => Promise<void>) {
    const t = Date.now()
    try {
      await fn()
      steps.push({ name, ok: true, ms: Date.now() - t })
      console.warn(`E2E STEP ok ${name} (${Date.now() - t} ms)`)
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t, error: (e as Error).message })
      console.warn(`E2E STEP FAILED ${name}: ${(e as Error).message}`)
      await capture(`failed-${name}`).catch(() => {})
      throw e
    }
  }

  const menu = (command: MenuCommandEvent['command'], arg?: string) => sendMenuCommand(contents, { command, ...(arg ? { arg } : {}) })

  /** Wait until the native menu item `id` matches (the menu follows the selection and accounts). */
  async function waitMenu(what: string, id: string, check: (item: Electron.MenuItem) => boolean, timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id)
      if (item && check(item)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for the menu: ${what}`)
  }

  let ok = true
  try {
    await inject()

    await step('first-run', async () => {
      await waitFor('the welcome screen', `document.body.innerText.includes('Welcome to Amethyst')`)
      await capture('firstrun-welcome')
      await clickText('button', 'Get Started')
      await clickText('button', 'Continue', { exact: true })
      await waitFor('the account step', `document.body.innerText.includes('Add your account')`)
      await clickText('button', 'Skip for now')
      await waitFor('the Java step', `document.body.innerText.includes('Java is taken care of')`)
      await capture('firstrun-java')
      await clickText('button', 'Continue', { exact: true })
      await waitFor('the privacy step', `document.body.innerText.includes('Help improve Amethyst')`)
      const off = await js<boolean>(`document.getElementById('fr-usage')?.getAttribute('aria-checked') === 'false' && document.getElementById('fr-crashes')?.getAttribute('aria-checked') === 'false'`)
      if (!off) throw new Error('privacy toggles are not off by default')
      await capture('firstrun-privacy')
      await clickText('button', 'Continue', { exact: true })
      await waitFor('the done step', `document.body.innerText.includes('all set')`)
      await capture('firstrun-done')
      await clickText('button', 'Go to Home')
      const settings = await invoke<{ privacy: { prompted: boolean; usageData: boolean; crashReports: boolean } }>('settings', 'get')
      if (!settings.privacy.prompted || settings.privacy.usageData || settings.privacy.crashReports) throw new Error(`consent not persisted as off: ${JSON.stringify(settings.privacy)}`)
      facts.consent = settings.privacy
    })

    await step('add-offline-account', async () => {
      await waitFor('Home', `document.body.innerText.includes('Create your first instance')`)
      await capture('home-empty')
      await clickText('button[aria-label="Add an account"]', 'Add an account')
      await clickText('[role=menuitem]', 'Add Account')
      await waitFor('the Add Account sheet', `document.body.innerText.includes('Sign in with Microsoft')`)
      await clickText('[aria-label="Account type"] button', 'Offline', { exact: true })
      // Offline accounts need a Microsoft account first, or developer mode: use the in-sheet switch.
      const blocked = await waitFor<string>('the offline form', `document.querySelector('input[placeholder="Steve"]') ? (document.body.innerText.includes('Turn On Developer Mode') ? 'blocked' : 'open') : ''`)
      if (blocked === 'blocked') {
        await capture('add-account-offline-needs-dev-mode')
        await clickText('button', 'Turn On Developer Mode')
        await waitFor('offline accounts to be allowed', `!document.body.innerText.includes('Turn On Developer Mode')`)
      }
      await typeInto('input[placeholder="Steve"]', 'Tester')
      await capture('add-account-offline')
      await clickText('[role=dialog] button', 'Add Account', { exact: true })
      await waitFor('the account chip', `window.__e2e.find('aside button', 'Tester')`)
      const accounts = await invoke<{ name: string; kind: string; selected: boolean }[]>('accounts', 'list')
      if (!accounts.some((a) => a.name === 'Tester' && a.kind === 'offline' && a.selected)) throw new Error(`account not added: ${JSON.stringify(accounts)}`)
      facts.account = accounts[0]
      const account = accounts.find((a) => a.name === 'Tester') as { id?: string } | undefined
      await waitMenu('the account as a checked radio item', `account:${account?.id}`, (i) => i.type === 'radio' && i.checked && i.label.startsWith('Tester'))
      await waitMenu('Play disabled without a selected instance', 'instance.play', (i) => !i.enabled)
      await capture('account-added')
    })

    let instanceId = ''
    await step('create-instance', async () => {
      await clickText('button', 'New Instance', { exact: true })
      await waitFor('the version list', `document.querySelector('input[role=combobox][aria-label="Minecraft version"]')?.value`, 120_000)
      await typeInto('[role=tabpanel] input:not([role=combobox])', 'E2E Vanilla')
      await typeInto('input[role=combobox][aria-label="Minecraft version"]', '1.21.1')
      await waitFor('version 1.21.1 in the list', `[...document.querySelectorAll('[role=option]')].find((o) => window.__e2e.norm(o.querySelector('span')?.textContent) === '1.21.1')`)
      await js(`window.__e2e.click([...document.querySelectorAll('[role=option]')].find((o) => window.__e2e.norm(o.querySelector('span')?.textContent) === '1.21.1')); true`)
      await waitFor('1.21.1 chosen', `document.querySelector('input[role=combobox][aria-label="Minecraft version"]').value === '1.21.1'`)
      await capture('new-instance-sheet')
      await clickText('[data-testid=create-instance]', 'Create')
      instanceId = await waitFor<string>('the instance view', `(location.hash.match(/#\\/instances\\/([^/]+)\\//) || [])[1]`, 30_000)
      facts.instanceId = instanceId
      await settle(contents, 300)
      await capture('instance-installing')
    })

    await step('install', async () => {
      const t = Date.now()
      const end = t + 20 * 60_000
      for (;;) {
        const status = await invoke<{ installed: boolean; installing: boolean; versionId: string }>('install', 'status', [instanceId])
        if (status.installed && !status.installing) {
          facts.install = { ...status, ms: Date.now() - t }
          break
        }
        if (Date.now() > end) throw new Error('install did not finish in 20 minutes')
        const tasks = await invoke<{ name: string; state: string; error: { message: string } | null; instanceId: string | null }[]>('tasks', 'list')
        const failed = tasks.find((x) => x.instanceId === instanceId && x.name === 'install.run' && x.state === 'failed')
        if (failed) throw new Error(`install failed: ${failed.error?.message}`)
        await sleep(1000)
      }
      await waitFor('the Play button', `window.__e2e.find('button[aria-keyshortcuts="Meta+Enter"]', 'Play', true)`, 30_000)
      await waitMenu('Play enabled for the selected instance', 'instance.play', (i) => i.enabled)
      await waitMenu('Stop disabled while idle', 'instance.stop', (i) => !i.enabled)
      await capture('instance-installed')
    })

    await step('play', async () => {
      await clickText('button[aria-keyshortcuts="Meta+Enter"]', 'Play', { exact: true })
      await waitFor('the launch to start', `window.__e2e.events.some((e) => e.event === 'launch:state' && e.payload.state === 'preparing')`, 20_000)
      await capture('launching')
      const outcome = await waitFor<string>(
        'running + ready',
        `(() => { const s = window.__e2e.events.filter((e) => e.event === 'launch:state').map((e) => e.payload); const f = s.find((x) => x.state === 'failed'); if (f) return 'failed:' + f.code + ' ' + f.message; const x = s.find((x) => x.state === 'exited'); if (x) return 'exited:' + x.code; return s.some((x) => x.state === 'running' && x.ready) ? 'ready' : '' })()`,
        240_000,
      )
      if (outcome !== 'ready') {
        showHiddenWindows()
        throw new Error(`launch did not reach ready: ${outcome}`)
      }
      const running = await invoke<{ instanceId: string; pid: number; ready: boolean }[]>('launch', 'listRunning')
      const game = running.find((r) => r.instanceId === instanceId)
      if (!game?.ready || !game.pid) throw new Error(`no running game: ${JSON.stringify(running)}`)
      process.kill(game.pid, 0)
      facts.game = { pid: game.pid, ready: game.ready }
      await waitMenu('Stop enabled while running', 'instance.stop', (i) => i.enabled)
      await waitMenu('Play disabled while running', 'instance.play', (i) => !i.enabled)
      // Give the game a moment to draw, then grab the screen (needs Screen Recording access; best effort).
      await sleep(4000)
      await new Promise<void>((r) => execFile('/usr/sbin/screencapture', ['-x', join(dir, 'game-window-screen.png')], () => r()))
      // "Hide launcher while playing" hid the window: bring it back like a Dock click does.
      showHiddenWindows()
      main.show()
      await settle(contents, 500)
      await capture('running')
    })

    await step('logs', async () => {
      await clickText('[aria-label="Instance sections"] button', 'Logs', { exact: true })
      const rows = await waitFor<number>('log lines', `(() => { const n = document.querySelectorAll('[role=log] .whitespace-pre').length; return n > 5 ? n : 0 })()`, 30_000)
      facts.logRows = rows
      await settle(contents, 800)
      await capture('logs-live')
    })

    await step('stop', async () => {
      await clickText('button[aria-keyshortcuts="Meta+."]', 'Stop', { exact: true })
      await clickText('[role=alertdialog] button', 'Stop', { exact: true })
      const exit = await waitFor<{ killed: boolean; crashed: boolean; code: number | null }>(
        'the game to exit',
        `window.__e2e.events.map((e) => e.payload).find((p) => p.state === 'exited')`,
        30_000,
      )
      facts.exit = exit
      if (exit.crashed) throw new Error(`stopping was reported as a crash: ${JSON.stringify(exit)}`)
      await waitFor('the Play button again', `window.__e2e.find('button[aria-keyshortcuts="Meta+Enter"]', 'Play', true)`, 20_000)
      await settle(contents, 500)
      await capture('stopped-logs')
    })

    await step('tour', async () => {
      await clickText('[aria-label="Instance sections"] button', 'Overview', { exact: true })
      await settle(contents, 800)
      await capture('overview')
      await clickText('[aria-label="Instance sections"] button', 'Settings', { exact: true })
      await settle(contents, 800)
      await capture('instance-settings')
      menu('view.home')
      await settle(contents, 800)
      await capture('home')
      menu('view.activity')
      await settle(contents, 600)
      await capture('activity')
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
      menu('view.palette')
      await settle(contents, 600)
      await capture('palette')
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
      for (const pane of ['general', 'accounts', 'java', 'game', 'privacy', 'updates', 'advanced']) {
        const win = openSettingsWindow(pane)
        win.webContents.setBackgroundThrottling(false)
        if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
        win.show()
        await settle(win.webContents, 900)
        await capture(`settings-${pane}`, win)
      }
    })
  } catch {
    ok = false
  }

  const summary = { ok, steps, facts, screenshots: dir }
  process.stdout.write(`E2E ${JSON.stringify(summary)}\n`)
  onDone(ok)
}
