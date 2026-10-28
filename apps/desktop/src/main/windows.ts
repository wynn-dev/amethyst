import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell, type WebContents } from 'electron'
import { MAIN_EVENT_CHANNEL } from '@shared/rpc'
import { DEFAULT_ACCENT } from '@shared/accent'
import type { MenuCommandEvent } from '@shared/menu'
import { writeBackgroundFixture, writeModFixtures } from './screenshot-fixtures'

/**
 * Window management beyond the main window: the Settings window (B7), routing renderer
 * `window.open` calls, and the dev-only screenshot mode.
 */

const isDev = !app.isPackaged

export const preloadPath = () => join(import.meta.dirname, '../preload/index.cjs')

/** Loads the renderer bundle at a hash route, e.g. `#/settings/general`. */
export function loadRoute(win: BrowserWindow, hash = ''): Promise<void> {
  if (isDev && process.env.ELECTRON_RENDERER_URL) return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash}`)
  return win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') })
}

/** Sends a menu command to one renderer, through the same channel as every main→renderer event. */
export function sendMenuCommand(contents: WebContents, payload: MenuCommandEvent): void {
  if (!contents.isDestroyed()) contents.send(MAIN_EVENT_CHANNEL, 'menu:command', payload)
}

let settingsWindow: BrowserWindow | undefined

/** Shows the single Settings window, at a pane (and optionally a highlighted row). ⌘, opens it. */
export function openSettingsWindow(pane = 'general', row?: string): BrowserWindow {
  const hash = `#/settings/${encodeURIComponent(pane)}${row ? `?row=${encodeURIComponent(row)}` : ''}`
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {})
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 680,
    minHeight: 440,
    title: 'Settings',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    fullscreenable: false,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  settingsWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = undefined
  })
  guardNavigation(win.webContents)
  loadRoute(win, hash)
  return win
}

export function getSettingsWindow(): BrowserWindow | undefined {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined
}

/**
 * The renderer opens the Settings window with `window.open('…#/settings/<pane>?row=…')`. Every
 * other `window.open` is denied; https links go to the default browser.
 */
export function handleWindowOpen(url: string): { action: 'deny' } {
  const settings = /#\/settings\/([\w-]+)(?:\?row=([\w%-]+))?/.exec(url)
  if (settings) openSettingsWindow(settings[1], settings[2] ? decodeURIComponent(settings[2]) : undefined)
  else if (url.startsWith('https://')) shell.openExternal(url)
  return { action: 'deny' }
}

/** Never let a renderer navigate away or open windows. In-page hash changes are not navigations. */
export function guardNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
  contents.on('will-navigate', (event) => event.preventDefault())
}

/* ------------------------------------------------------------------------------------------ */
/* Screenshot mode (dev only)                                                                 */
/* ------------------------------------------------------------------------------------------ */

interface Shot {
  name: string
  hash: string
  /** RPC calls made before `setup` (e.g. settings the page reads as it loads after the reload). */
  before?: RpcStep[]
  /** JavaScript to run before navigating (e.g. set the fixture mode). Triggers a reload when `reload`. */
  setup?: string
  reload?: boolean
  /** A menu command to send after navigating (opens palette, sheets, popovers). */
  command?: MenuCommandEvent
  /** Capture the Settings window instead of the main window. */
  settings?: { pane: string }
  /** Extra settle time in ms. */
  wait?: number
  /** RPC calls made through the main window's bridge before the shot (awaited, in order). */
  invoke?: RpcStep[]
  /** JavaScript run in the main window after navigating and before `command` (e.g. open an instance the command acts on). */
  prepare?: string
  /** JavaScript run in the captured window before settling (e.g. scroll a row into view). */
  script?: string
  /** RPC calls made after the shot, to leave the state as it was. */
  cleanup?: RpcStep[]
  /** JavaScript run in the main window after the shot, to leave the state as it was. */
  cleanupScript?: string
}

/** `[service, method, args]`; the string `BACKGROUND_FIXTURE` in args becomes the generated image's path. */
type RpcStep = [string, string, unknown[]]

const ACCENT_SHOTS: [string, string][] = [
  ['neutral', DEFAULT_ACCENT],
  ['blue', '#007aff'],
  ['pink', '#ff2d55'],
  ['red', '#ff3b30'],
  ['orange', '#ff9500'],
  ['yellow', '#e5b000'],
  ['green', '#28a745'],
  ['graphite', '#8e8e93'],
]
const resetAppearance: RpcStep[] = [
  ['settings', 'setBackground', [null]],
  ['settings', 'patch', [{ appearance: { accentColor: DEFAULT_ACCENT } }]],
]

/** Sample instances, created once per screenshot profile (the game installs only at first launch). */
const SAMPLE_INSTANCES = [
  { name: 'Survival', runtime: { minecraft: '1.21.1', fabric: '0.16.9' } },
  { name: 'Create: Above & Beyond', runtime: { minecraft: '1.18.2', forge: '40.2.4' } },
  { name: 'Vanilla', runtime: { minecraft: '1.21.4' } },
  { name: 'Skyblock', runtime: { minecraft: '1.20.1', quilt: '0.26.4' } },
]
// `MOD_FIXTURES` becomes the generated jars' paths; they are added to the first instance.
const seedInstances = `(async () => {
  const list = await window.amethyst.invoke('instances', 'list', [])
  if (!list.ok || list.value.length > 0) return
  for (const input of ${JSON.stringify(SAMPLE_INSTANCES)}) {
    const made = await window.amethyst.invoke('instances', 'create', [input])
    if (made.ok && input.name === 'Survival') await window.amethyst.invoke('resources', 'add', [made.value.id, 'mods', "MOD_FIXTURES"])
  }
})()`
/** Opens a sample instance's tab by name (instance ids are random). */
const openSample = (name: string, tab: string) =>
  `window.amethyst.invoke('instances', 'list', []).then((l) => { const i = l.ok && l.value.find((x) => x.name === ${JSON.stringify(name)}); if (i) location.hash = '#/instances/' + i.id + '/${tab}' })`

/** Clicks the first element matching `selector` whose text includes `text` (in the shot's window). */
const clickText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))?.click()`

/** Installs a sample instance (a real download in the screenshot profile) to show the Play button's progress pill. */
const installSample = (name: string) =>
  `window.amethyst.invoke('instances', 'list', []).then((l) => { const i = l.ok && l.value.find((x) => x.name === ${JSON.stringify(name)}); if (i) { location.hash = '#/instances/' + i.id + '/overview'; window.amethyst.invoke('install', 'install', [i.id]) } })`
const cancelTasks = `window.amethyst.invoke('tasks', 'list', []).then((l) => { for (const t of l.ok ? l.value : []) window.amethyst.invoke('tasks', 'cancel', [t.id]) })`

const firstRun = (step: string, completed = false) =>
  `localStorage.setItem('amethyst:first-run', ${JSON.stringify(JSON.stringify({ state: { completed, step }, version: 1 }))})`

// First run shows only while Privacy is unanswered (the Home shot answers it).
const unanswered: RpcStep[] = [['settings', 'patch', [{ privacy: { prompted: false } }]]]

const SHOTS: Shot[] = [
  { name: 'firstrun-welcome', hash: '#/welcome', before: unanswered, setup: firstRun('welcome'), reload: true },
  { name: 'firstrun-appearance', hash: '#/welcome', before: unanswered, setup: firstRun('appearance'), reload: true },
  { name: 'firstrun-account', hash: '#/welcome', before: unanswered, setup: firstRun('account'), reload: true },
  { name: 'firstrun-java', hash: '#/welcome', before: unanswered, setup: firstRun('java'), reload: true },
  { name: 'firstrun-privacy', hash: '#/welcome', before: unanswered, setup: firstRun('privacy'), reload: true },
  { name: 'firstrun-done', hash: '#/welcome', before: unanswered, setup: firstRun('done'), reload: true },
  { name: 'home', hash: '#/', setup: `${firstRun('done', true)}; localStorage.removeItem('amethyst:fixtures')`, reload: true, invoke: [['settings', 'patch', [{ privacy: { prompted: true } }]]], script: seedInstances, wait: 400 },
  { name: 'discover', hash: '#/discover?type=modpack' },
  { name: 'discover-target', hash: '#/discover?type=mod&target=survival' },
  { name: 'project', hash: '#/discover/modpack-0' },
  { name: 'instance-overview', hash: '#/', script: openSample('Survival', 'overview') },
  { name: 'instance-mods', hash: '#/', script: openSample('Survival', 'mods') },
  { name: 'instance-resource-packs', hash: '#/', script: openSample('Survival', 'resource-packs') },
  { name: 'instance-shaders', hash: '#/', script: openSample('Survival', 'shaders') },
  { name: 'instance-worlds', hash: '#/', script: openSample('Survival', 'worlds') },
  { name: 'instance-logs', hash: '#/', script: openSample('Survival', 'logs') },
  { name: 'instance-settings', hash: '#/', script: openSample('Survival', 'settings') },
  { name: 'instance-vanilla-mods', hash: '#/', script: openSample('Vanilla', 'mods') },
  { name: 'instance-create', hash: '#/', script: openSample('Create: Above & Beyond', 'overview') },
  { name: 'instance-installing', hash: '#/', script: installSample('Vanilla'), wait: 2500, cleanupScript: cancelTasks },
  { name: 'activity-installing', hash: '#/', script: installSample('Vanilla'), command: { command: 'view.activity' }, wait: 2500, cleanupScript: cancelTasks },
  { name: 'palette', hash: '#/', script: openSample('Survival', 'overview'), command: { command: 'view.palette' } },
  { name: 'activity', hash: '#/', command: { command: 'view.activity' } },
  { name: 'shortcuts', hash: '#/', command: { command: 'help.shortcuts' } },
  { name: 'new-instance', hash: '#/', command: { command: 'file.newInstance' }, wait: 600 },
  { name: 'new-instance-fabric', hash: '#/', command: { command: 'file.newInstance' }, wait: 900, script: `${clickText('[role=radio]', 'Fabric')}; ${clickText('button', 'Advanced')}` },
  { name: 'new-instance-url', hash: '#/', command: { command: 'file.newInstance' }, wait: 400, script: clickText('[role=tab]', 'From URL') },
  { name: 'new-instance-folder', hash: '#/', command: { command: 'file.addExistingFolder' }, wait: 600 },
  { name: 'change-version', hash: '#/', prepare: openSample('Survival', 'overview'), command: { command: 'instance.changeVersion' }, wait: 600 },
  { name: 'export-modpack', hash: '#/', prepare: openSample('Survival', 'overview'), command: { command: 'file.exportModpack' }, wait: 600 },
  { name: 'import-url', hash: '#/', command: { command: 'file.importUrl' }, wait: 400 },
  { name: 'add-account', hash: '#/', command: { command: 'account.add' }, wait: 400 },
  { name: 'launch-prompt', hash: '#/', prepare: openSample('Vanilla', 'overview'), command: { command: 'instance.play' }, wait: 800 },
  { name: 'home-empty', hash: '#/', setup: `localStorage.setItem('amethyst:fixtures', 'empty')`, reload: true },
  { name: 'mods-loading', hash: '#/instances/survival/mods', setup: `localStorage.setItem('amethyst:fixtures', 'loading')`, reload: true },
  { name: 'discover-error', hash: '#/discover?type=mod', setup: `localStorage.setItem('amethyst:fixtures', 'error')`, reload: true },
  { name: 'settings-general', hash: '', settings: { pane: 'general' }, setup: `localStorage.removeItem('amethyst:fixtures')`, reload: true },
  { name: 'settings-accounts', hash: '', settings: { pane: 'accounts' } },
  { name: 'settings-appearance', hash: '', settings: { pane: 'appearance' } },
  { name: 'settings-privacy', hash: '', settings: { pane: 'privacy' } },
  { name: 'settings-java', hash: '', settings: { pane: 'java' } },
  { name: 'settings-game', hash: '', settings: { pane: 'game' } },
  { name: 'settings-network', hash: '', settings: { pane: 'network' } },
  { name: 'settings-updates', hash: '', settings: { pane: 'updates' } },
  { name: 'settings-advanced', hash: '', settings: { pane: 'advanced' } },
  { name: 'settings-about', hash: '', settings: { pane: 'about' } },
  // Skins and appearance. The skin pages are dev-only routes (run the screenshot mode under `electron-vite dev`).
  { name: 'skins-viewers', hash: '#/dev/skins', wait: 800 },
  { name: 'skins-editors', hash: '#/dev/skins?view=editors', wait: 1200 },
  ...ACCENT_SHOTS.map(([name, color]): Shot => ({ name: `appearance-accent-${name}`, hash: '', settings: { pane: 'appearance' }, invoke: [['settings', 'patch', [{ appearance: { accentColor: color } }]]] })),
  {
    name: 'appearance-background',
    hash: '',
    settings: { pane: 'appearance' },
    invoke: [
      ['settings', 'patch', [{ appearance: { accentColor: DEFAULT_ACCENT } }]],
      ['settings', 'setBackground', [{ path: 'BACKGROUND_FIXTURE' }]],
    ],
    wait: 300,
    script: `document.getElementById('row-background')?.scrollIntoView({ block: 'center' })`,
  },
  { name: 'home-background', hash: '#/' },
  { name: 'instance-background', hash: '#/', script: openSample('Survival', 'mods'), cleanup: resetAppearance },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settle(contents: WebContents, extra = 0) {
  // Two animation frames after the route's lazy chunk and data have rendered, plus motion time.
  // Bounded: frames can be throttled while a window is occluded, which must never hang the run.
  await bounded(contents.executeJavaScript('new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500) })'))
  await sleep(700 + extra)
}

/** Every step is bounded so one stuck page can never hang the whole run. */
const bounded = <T>(p: Promise<T>, ms = 8_000) => Promise.race([p, sleep(ms).then(() => undefined)])

async function reload(contents: WebContents) {
  const done = new Promise<void>((r) => contents.once('did-finish-load', () => r()))
  contents.reload()
  await bounded(done)
}

/**
 * `AMETHYST_SCREENSHOT=<dir>`: walks the key routes in light and dark, writes PNGs, then quits.
 * `capturePage` cannot see the native vibrancy material, so the renderer is told to paint an
 * opaque approximation of it (`data-screenshot`).
 */
export async function runScreenshots(main: BrowserWindow, dir: string, onDone: () => void): Promise<void> {
  await mkdir(dir, { recursive: true })
  const background = await writeBackgroundFixture(dir)
  const mods = await writeModFixtures(dir)
  // `AMETHYST_SCREENSHOT_FILTER=<regex>` captures only the matching shots (setup of skipped shots still runs).
  // `AMETHYST_SCREENSHOT_NETWORK=1` also captures the `*-installing` shots, which start a real game download (then cancel it).
  const filter = process.env.AMETHYST_SCREENSHOT_FILTER ? new RegExp(process.env.AMETHYST_SCREENSHOT_FILTER) : undefined
  const call = async (steps: RpcStep[] | undefined) => {
    for (const [service, method, args] of steps ?? []) {
      const json = JSON.stringify(args).replaceAll('"BACKGROUND_FIXTURE"', JSON.stringify(background))
      const r = await bounded(contents.executeJavaScript(`window.amethyst.invoke(${JSON.stringify(service)}, ${JSON.stringify(method)}, ${json})`))
      if (r && !(r as { ok: boolean }).ok) console.warn(`SCREENSHOT RPC ${service}.${method} failed: ${JSON.stringify(r)}`)
    }
  }
  const contents = main.webContents
  contents.setBackgroundThrottling(false)
  if (!contents.getURL() || contents.isLoading()) await new Promise<void>((r) => contents.once('did-finish-load', () => r()))
  main.setContentSize(1200, 780)
  main.show()
  main.focus()
  const mark = `document.documentElement.dataset.screenshot = ''`

  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    for (const shot of SHOTS) {
      try {
        await captureShot(shot, theme)
      } catch (e) {
        // A page reload can reject an in-flight executeJavaScript; log it and move on.
        console.warn(`SCREENSHOT FAILED ${theme}-${shot.name}: ${(e as Error).message}`)
      }
    }
  }
  console.warn(`SCREENSHOTS ${dir}`)
  onDone()

  async function captureShot(shot: Shot, theme: 'light' | 'dark') {
    await call(shot.before)
    if (shot.setup) await bounded(contents.executeJavaScript(`${shot.setup}; true`))
    if (shot.reload) await reload(contents)
    await call(shot.invoke)
    if (filter && !filter.test(shot.name)) {
      await call(shot.cleanup)
      return
    }
    if (shot.name.includes('installing') && !process.env.AMETHYST_SCREENSHOT_NETWORK) return
    await bounded(contents.executeJavaScript(`${mark}; true`))
    let target = main
    if (shot.settings) {
      target = openSettingsWindow(shot.settings.pane)
      target.webContents.setBackgroundThrottling(false)
      if (target.webContents.isLoading()) await new Promise<void>((r) => target.webContents.once('did-finish-load', () => r()))
      await bounded(target.webContents.executeJavaScript(`${mark}; true`))
      target.show()
      target.focus()
    } else {
      getSettingsWindow()?.hide()
      main.focus()
      await bounded(contents.executeJavaScript(`location.hash = ${JSON.stringify(shot.hash)}; true`))
      if (shot.prepare) {
        await settle(contents)
        await bounded(contents.executeJavaScript(`${shot.prepare}; true`))
      }
      if (shot.command) {
        await settle(contents)
        sendMenuCommand(contents, shot.command)
      }
    }
    if (shot.script) {
      await settle(target.webContents)
      await bounded(target.webContents.executeJavaScript(`${shot.script.replaceAll('"MOD_FIXTURES"', JSON.stringify(mods))}; true`))
    }
    await settle(target.webContents, shot.wait)
    const image = await Promise.race([target.webContents.capturePage(), sleep(10_000).then(() => undefined)])
    if (!image) {
      console.warn(`SCREENSHOT TIMEOUT ${theme}-${shot.name}`)
      return
    }
    await writeFile(join(dir, `${theme}-${shot.name}.png`), image.toPNG())
    await call(shot.cleanup)
    if (shot.cleanupScript) await bounded(contents.executeJavaScript(`${shot.cleanupScript}; true`))
    // Overlays opened by a command are discarded with a reload before the next shot.
    if (shot.command) await reload(contents)
  }
}
