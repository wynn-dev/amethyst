import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, MenuCommandEvent, MenuContext } from '@shared/menu'
import type { AccountRow, RunningGame, TaskView } from '@shared/services'
import type { RuntimeSupervisor } from './runtime'
import type { Updater } from './updater'
import { getSettingsWindow, openSettingsWindow, sendMenuCommand } from './windows'

/**
 * The native menu bar (ui.md B13). Custom items send a `menu:command` event to the renderer,
 * which runs the same handler as the command palette. Standard roles (Edit, Window, Services…)
 * are kept so copy and paste, undo and window management work everywhere.
 *
 * The menu follows live state, and is rebuilt only when what it shows changes:
 * - the updater: "Check for Updates…" becomes "Restart to Update" once a download is ready (B14);
 * - the main window's selection (`window.setMenuContext`): instance items are disabled without one.
 *   Only the main window has a selection, and instance commands always go to it, so the context
 *   applies whichever window is focused;
 * - the runtime's account list, shown as radio items (⌃⌘1–9), kept current by `accounts:changed`.
 */

/** Commands that act on the focused window's own content; everything else targets the main window. */
const LOCAL_COMMANDS = new Set<MenuCommand>(['edit.find', 'edit.findNext', 'edit.findPrevious'])

/** How long after the runtime is (re)started to read the accounts, so the menu never adds to boot. */
const ACCOUNTS_DELAY_MS = 1_500

export interface AppMenuOptions {
  /** The main window, created if it was closed. */
  getMainWindow: () => BrowserWindow
  updater: Updater
  runtime: RuntimeSupervisor
}

export interface AppMenu {
  /** The main window's renderer reported its selection. */
  setContext(context: MenuContext): void
}

const NO_CONTEXT: MenuContext = { instance: null }

/** Keep only well-formed fields: the context comes from a renderer. */
export function sanitizeMenuContext(value: unknown): MenuContext {
  const inst = (value as { instance?: unknown } | null)?.instance as Record<string, unknown> | null | undefined
  if (!inst || typeof inst !== 'object' || typeof inst.id !== 'string') return NO_CONTEXT
  return { instance: { id: inst.id.slice(0, 200), canPlay: inst.canPlay === true, canStop: inst.canStop === true, pinned: inst.pinned === true } }
}

export function installAppMenu({ getMainWindow, updater, runtime }: AppMenuOptions): AppMenu {
  let context: MenuContext = NO_CONTEXT
  let accounts: Pick<AccountRow, 'id' | 'name' | 'kind' | 'selected'>[] = []
  let builtKey = ''

  const send = (command: MenuCommand, arg?: string) => () => {
    const payload: MenuCommandEvent = arg === undefined ? { command } : { command, arg }
    const focused = BrowserWindow.getFocusedWindow()
    const settings = getSettingsWindow()
    if (focused && focused === settings && LOCAL_COMMANDS.has(command)) return sendMenuCommand(focused.webContents, payload)
    const main = getMainWindow()
    if (!main.isVisible()) main.show()
    if (focused !== main) main.focus()
    sendMenuCommand(main.webContents, payload)
  }
  // Ids (`instance.play`, `view.tab.2`, `account:<id>`) let the UI driver check the menu state.
  const item = (label: string, command: MenuCommand, accelerator?: string, arg?: string, enabled = true): MenuItemConstructorOptions => ({
    id: arg === undefined ? command : `${command}.${arg}`,
    label,
    accelerator,
    enabled,
    click: send(command, arg),
  })

  const selectAccount = (id: string) => {
    runtime.call('accounts', 'select', [id]).catch((e: unknown) => console.warn('cannot select the account', e))
  }

  function template(): MenuItemConstructorOptions[] {
    const ready = updater.state.status === 'ready'
    const inst = context.instance
    const has = inst !== null
    return [
      {
        label: app.name,
        submenu: [
          item(`About ${app.name}`, 'app.about'),
          // The renderer's handler restarts when an update is ready, and checks otherwise.
          item(ready ? 'Restart to Update' : 'Check for Updates…', 'app.checkForUpdates'),
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          // Quitting asks first while downloads or a game are running (see `confirmQuit`).
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          item('New Instance…', 'file.newInstance', 'CmdOrCtrl+N'),
          item('New Folder', 'file.newFolder', 'Shift+CmdOrCtrl+N'),
          { type: 'separator' },
          item('Import Modpack…', 'file.importModpack', 'CmdOrCtrl+O'),
          item('Add Existing Folder…', 'file.addExistingFolder', 'Shift+CmdOrCtrl+O'),
          item('Import from URL…', 'file.importUrl', 'Alt+CmdOrCtrl+O'),
          item('Export Modpack…', 'file.exportModpack', 'Shift+CmdOrCtrl+E', undefined, has),
          { type: 'separator' },
          item('Duplicate Instance…', 'file.duplicate', 'CmdOrCtrl+D', undefined, has),
          item('Show in Finder', 'file.showInFinder', 'Shift+CmdOrCtrl+R', undefined, has),
          item('Open Data Folder', 'file.openDataFolder'),
          { type: 'separator' },
          item('Move to Trash…', 'file.trash', 'CmdOrCtrl+Backspace', undefined, has),
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          item('Find…', 'edit.find', 'CmdOrCtrl+F'),
          item('Find Next', 'edit.findNext', 'CmdOrCtrl+G'),
          item('Find Previous', 'edit.findPrevious', 'Shift+CmdOrCtrl+G'),
          { type: 'separator' },
          { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
          // macOS adds "AutoFill", "Start Dictation" and "Emoji & Symbols" to the Edit menu itself.
        ],
      },
      {
        label: 'View',
        submenu: [
          item('Home', 'view.home', 'Shift+CmdOrCtrl+H'),
          item('Discover', 'view.discover', 'Shift+CmdOrCtrl+D'),
          item('Back', 'view.back', 'CmdOrCtrl+['),
          { type: 'separator' },
          item('Command Palette…', 'view.palette', 'CmdOrCtrl+K'),
          item('Activity', 'view.activity', 'Alt+CmdOrCtrl+A'),
          item('Filter Instances', 'view.filterSidebar', 'Alt+CmdOrCtrl+F'),
          { type: 'separator' },
          item('Overview', 'view.tab', 'CmdOrCtrl+1', '1', has),
          item('Mods', 'view.tab', 'CmdOrCtrl+2', '2', has),
          item('Resource Packs', 'view.tab', 'CmdOrCtrl+3', '3', has),
          item('Shaders', 'view.tab', 'CmdOrCtrl+4', '4', has),
          item('Worlds', 'view.tab', 'CmdOrCtrl+5', '5', has),
          item('Logs', 'view.tab', 'CmdOrCtrl+6', '6', has),
          item('Settings', 'view.tab', 'CmdOrCtrl+7', '7', has),
          { type: 'separator' },
          item('Show/Hide Sidebar', 'view.toggleSidebar', 'Ctrl+CmdOrCtrl+S'),
          item('Show/Hide Inspector', 'view.toggleInspector', 'Alt+CmdOrCtrl+I'),
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
        ],
      },
      {
        label: 'Instance',
        submenu: [
          item('Play', 'instance.play', 'CmdOrCtrl+Return', undefined, inst?.canPlay ?? false),
          item('Stop', 'instance.stop', 'CmdOrCtrl+.', undefined, inst?.canStop ?? false),
          item('Force Stop', 'instance.forceStop', 'Alt+CmdOrCtrl+.', undefined, inst?.canStop ?? false),
          { type: 'separator' },
          item('Add Mods…', 'instance.addMods', 'Shift+CmdOrCtrl+A', undefined, has),
          item('Add Files…', 'instance.addFiles', undefined, undefined, has),
          item('Check for Updates', 'instance.checkForUpdates', 'Shift+CmdOrCtrl+U', undefined, has),
          item('Change Version…', 'instance.changeVersion', undefined, undefined, has),
          item('Repair Files', 'instance.repair', undefined, undefined, has),
          { type: 'separator' },
          item('Open Logs', 'instance.openLogs', 'CmdOrCtrl+L', undefined, has),
          item('Open Log Window', 'instance.openLogWindow', 'Alt+CmdOrCtrl+L', undefined, has),
          { type: 'separator' },
          item('Rename', 'instance.rename', undefined, undefined, has),
          item('Change Icon…', 'instance.changeIcon', undefined, undefined, has),
          item(inst?.pinned ? 'Unpin' : 'Pin', 'instance.togglePin', undefined, undefined, has),
        ],
      },
      {
        label: 'Account',
        submenu: [
          ...accounts.map(
            (a, i): MenuItemConstructorOptions => ({
              id: `account:${a.id}`,
              label: a.kind === 'offline' ? `${a.name} (Offline)` : a.name,
              type: 'radio',
              checked: a.selected,
              accelerator: i < 9 ? `Ctrl+CmdOrCtrl+${i + 1}` : undefined,
              click: () => selectAccount(a.id),
            }),
          ),
          ...(accounts.length > 0 ? ([{ type: 'separator' }] as MenuItemConstructorOptions[]) : []),
          item('Add Account…', 'account.add'),
          item('Edit Skin…', 'account.editSkin', undefined, undefined, accounts.length > 0),
          item('Manage Accounts…', 'account.manage'),
        ],
      },
      {
        role: 'windowMenu',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          {
            label: 'Main Window',
            accelerator: 'CmdOrCtrl+0',
            click: () => {
              const main = getMainWindow()
              main.show()
              main.focus()
            },
          },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
      {
        role: 'help',
        submenu: [
          item(`${app.name} Help`, 'help.shortcuts'),
          item('Keyboard Shortcuts', 'help.shortcuts', 'CmdOrCtrl+/'),
          { type: 'separator' },
          item('Open Launcher Logs', 'help.openLauncherLogs'),
          item('Release Notes', 'help.releaseNotes'),
          { label: 'Report an Issue…', click: () => shell.openExternal('https://github.com/wynn-dev/amethyst/issues/new') },
        ],
      },
    ]
  }

  /** Rebuild only when something the menu shows changed (updater progress ticks don't count). */
  function rebuild(): void {
    const key = JSON.stringify([updater.state.status === 'ready', context, accounts])
    if (key === builtKey) return
    builtKey = key
    Menu.setApplicationMenu(Menu.buildFromTemplate(template()))
  }

  let accountsTimer: NodeJS.Timeout | undefined
  let accountsRequest = 0
  async function refreshAccounts(): Promise<void> {
    const request = ++accountsRequest
    try {
      const list = await runtime.call('accounts', 'list')
      if (request !== accountsRequest) return
      accounts = list
        .map(({ id, name, kind, selected }) => ({ id, name, kind, selected }))
        .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
      rebuild()
    } catch {
      // The runtime is restarting; `runtime:ready` triggers another read.
    }
  }

  updater.onChange(rebuild)
  runtime.onEvent((event) => {
    if (event === 'accounts:changed') {
      clearTimeout(accountsTimer)
      void refreshAccounts()
    } else if (event === 'runtime:ready') {
      clearTimeout(accountsTimer)
      accountsTimer = setTimeout(() => void refreshAccounts(), ACCOUNTS_DELAY_MS)
    }
  })
  rebuild()

  return {
    setContext(next) {
      context = sanitizeMenuContext(next)
      rebuild()
    },
  }
}

/**
 * Asks before quitting (or restarting to update) while downloads or installs are running or a game
 * launched by Amethyst is running (B13, B14). Games are separate processes and keep running, so
 * quitting is always allowed; downloads and installs are cancelled. Resolves `true` to go ahead.
 */
export async function confirmQuit(runtime: RuntimeSupervisor, action: 'quit' | 'restart' = 'quit'): Promise<boolean> {
  // A slow or restarting runtime must never block quitting.
  const [tasks, games] = await Promise.all([
    runtime.call('tasks', 'list', [], 1_000).catch((): TaskView[] => []),
    runtime.call('launch', 'listRunning', [], 1_000).catch((): RunningGame[] => []),
  ])
  const busy = tasks.filter((t) => t.state === 'running' || t.state === 'pending').length
  const playing = games.length
  if (busy === 0 && playing === 0) return true

  const verb = action === 'restart' ? 'Restart' : 'Quit'
  const message =
    busy > 0
      ? busy === 1
        ? 'A download or install is still running'
        : `${busy} downloads or installs are still running`
      : playing === 1
        ? 'Minecraft is running'
        : `${playing} Minecraft games are running`
  const detail = [
    `${verb} ${app.name} anyway?`,
    busy > 0 ? (busy === 1 ? 'It will be cancelled.' : 'They will be cancelled.') : '',
    playing > 0 ? 'Minecraft will keep running.' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const options = { type: 'warning' as const, buttons: [verb, 'Cancel'], defaultId: 0, cancelId: 1, message, detail, noLink: true }
  const parent = BrowserWindow.getFocusedWindow()
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response === 0
}
