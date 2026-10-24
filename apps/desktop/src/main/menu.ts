import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, MenuCommandEvent } from '@shared/menu'
import { getSettingsWindow, openSettingsWindow, sendMenuCommand } from './windows'

/**
 * The native menu bar (ui.md B13). Custom items send a `menu:command` event to the renderer,
 * which runs the same handler as the command palette. Standard roles (Edit, Window, Services…)
 * are kept so copy and paste, undo and window management work everywhere.
 */

/** Commands that act on the focused window's own content; everything else targets the main window. */
const LOCAL_COMMANDS = new Set<MenuCommand>(['edit.find', 'edit.findNext', 'edit.findPrevious'])

export function installAppMenu(getMainWindow: () => BrowserWindow): void {
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
  const item = (label: string, command: MenuCommand, accelerator?: string, arg?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: send(command, arg),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        item(`About ${app.name}`, 'app.about'),
        // TODO(wire): becomes "Restart to Update" when the updater has a download ready (B14).
        item('Check for Updates…', 'app.checkForUpdates'),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // TODO(wire): warn when downloads or a launched game are running ("Quit and keep game running").
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
        item('Export Modpack…', 'file.exportModpack', 'Shift+CmdOrCtrl+E'),
        { type: 'separator' },
        item('Duplicate Instance…', 'file.duplicate', 'CmdOrCtrl+D'),
        item('Show in Finder', 'file.showInFinder', 'Shift+CmdOrCtrl+R'),
        item('Open Data Folder', 'file.openDataFolder'),
        { type: 'separator' },
        item('Move to Trash…', 'file.trash', 'CmdOrCtrl+Backspace'),
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
        item('Overview', 'view.tab', 'CmdOrCtrl+1', '1'),
        item('Mods', 'view.tab', 'CmdOrCtrl+2', '2'),
        item('Resource Packs', 'view.tab', 'CmdOrCtrl+3', '3'),
        item('Shaders', 'view.tab', 'CmdOrCtrl+4', '4'),
        item('Worlds', 'view.tab', 'CmdOrCtrl+5', '5'),
        item('Logs', 'view.tab', 'CmdOrCtrl+6', '6'),
        item('Settings', 'view.tab', 'CmdOrCtrl+7', '7'),
        { type: 'separator' },
        item('Show/Hide Sidebar', 'view.toggleSidebar', 'Ctrl+CmdOrCtrl+S'),
        item('Show/Hide Inspector', 'view.toggleInspector', 'Alt+CmdOrCtrl+I'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      // TODO(wire): enable/disable these to match whether an instance is selected (B13).
      label: 'Instance',
      submenu: [
        item('Play', 'instance.play', 'CmdOrCtrl+Return'),
        item('Stop', 'instance.stop', 'CmdOrCtrl+.'),
        item('Force Stop', 'instance.forceStop', 'Alt+CmdOrCtrl+.'),
        { type: 'separator' },
        item('Add Mods…', 'instance.addMods', 'Shift+CmdOrCtrl+A'),
        item('Add Files…', 'instance.addFiles'),
        item('Check for Updates', 'instance.checkForUpdates', 'Shift+CmdOrCtrl+U'),
        item('Change Version…', 'instance.changeVersion'),
        item('Repair Files', 'instance.repair'),
        { type: 'separator' },
        item('Open Logs', 'instance.openLogs', 'CmdOrCtrl+L'),
        item('Open Log Window', 'instance.openLogWindow', 'Alt+CmdOrCtrl+L'),
        { type: 'separator' },
        item('Rename', 'instance.rename'),
        item('Change Icon…', 'instance.changeIcon'),
        item('Pin/Unpin', 'instance.togglePin'),
      ],
    },
    {
      // TODO(wire): list accounts as radio items (⌃⌘1–9) once the accounts service exists.
      label: 'Account',
      submenu: [item('Add Account…', 'account.add'), item('Edit Skin…', 'account.editSkin'), item('Manage Accounts…', 'account.manage')],
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
