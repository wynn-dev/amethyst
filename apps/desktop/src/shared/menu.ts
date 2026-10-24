/**
 * Commands the native menu bar sends to the focused renderer (`menu:command` event). The renderer
 * maps each to the same handler the command palette uses, so the two never drift.
 */
export const MENU_COMMANDS = [
  'app.about',
  'app.checkForUpdates',
  'file.newInstance',
  'file.newFolder',
  'file.importModpack',
  'file.addExistingFolder',
  'file.importUrl',
  'file.exportModpack',
  'file.duplicate',
  'file.showInFinder',
  'file.openDataFolder',
  'file.trash',
  'edit.find',
  'edit.findNext',
  'edit.findPrevious',
  'view.home',
  'view.back',
  'view.discover',
  'view.palette',
  'view.activity',
  'view.tab',
  'view.toggleSidebar',
  'view.toggleInspector',
  'view.filterSidebar',
  'instance.play',
  'instance.stop',
  'instance.forceStop',
  'instance.addMods',
  'instance.addFiles',
  'instance.checkForUpdates',
  'instance.changeVersion',
  'instance.repair',
  'instance.openLogs',
  'instance.openLogWindow',
  'instance.rename',
  'instance.changeIcon',
  'instance.togglePin',
  'account.add',
  'account.editSkin',
  'account.manage',
  'help.shortcuts',
  'help.openLauncherLogs',
  'help.releaseNotes',
  'help.reportIssue',
] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

export interface MenuCommandEvent {
  command: MenuCommand
  /** Optional argument, e.g. the tab for `view.tab`. */
  arg?: string
}

/** Instance tabs, in ⌘1–⌘7 order. */
export const INSTANCE_TABS = ['overview', 'mods', 'resource-packs', 'shaders', 'worlds', 'logs', 'settings'] as const
export type InstanceTab = (typeof INSTANCE_TABS)[number]
