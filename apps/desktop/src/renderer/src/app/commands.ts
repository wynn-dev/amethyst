import type { MenuCommand } from '@shared/menu'
import { INSTANCE_TABS, type InstanceTab } from '@shared/menu'
import type { UpdaterState } from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { chooseInstanceIcon, getInstanceSummary, instanceActions, libraryActions } from '@/data/instances'
import { queryClient } from '@/data/query'
import { updaterActions, updaterKey } from '@/data/updater'
import { addResourceFiles } from '@/data/content'
import { openModpackExport, openModpackImport, useModpackUi } from '@/data/modpacks'
import { pickFiles } from '@/lib/files'
import type { InstanceSummary } from '@/data/types'
import { toast } from '@/ui/toast-store'
import { router } from './router'
import { focusFindTarget, useUi } from './ui-store'

/** The instance whose detail view is showing, if any. */
export function currentInstanceId(): string | undefined {
  for (const m of router.state.matches) {
    const id = (m.params as { instanceId?: string }).instanceId
    if (id) return id
  }
  return undefined
}

export function currentInstance(): InstanceSummary | undefined {
  const id = currentInstanceId()
  return id ? getInstanceSummary(id) : undefined
}

export function currentTab(): InstanceTab | undefined {
  const path = router.state.location.pathname
  const tab = path.split('/')[3]
  return (INSTANCE_TABS as readonly string[]).includes(tab ?? '') ? (tab as InstanceTab) : undefined
}

export function openInstance(id: string, tab: InstanceTab = currentTab() ?? 'overview') {
  router.navigate({ to: `/instances/$instanceId/${tab}`, params: { instanceId: id } })
}

export const TAB_LABELS: Record<InstanceTab, string> = {
  overview: 'Overview',
  mods: 'Mods',
  'resource-packs': 'Resource Packs',
  shaders: 'Shaders',
  worlds: 'Worlds',
  logs: 'Logs',
  settings: 'Settings',
}

/**
 * Opens the Settings window. Main intercepts `window.open` for the app's own `#/settings/...`
 * URLs and shows (or focuses) the single Settings window at that pane.
 */
export function openSettings(pane = 'general', row?: string) {
  const hash = `#/settings/${pane}${row ? `?row=${encodeURIComponent(row)}` : ''}`
  window.open(`${location.origin}${location.pathname}${hash}`, 'amethyst-settings')
}

/** Open one of the well-known data folders in Finder. */
export async function openDataFolder(which: 'dataRoot' | 'logs' | 'instances' | 'backups') {
  try {
    const paths = await queryClient.fetchQuery({ queryKey: ['settings', 'paths'], queryFn: () => api.settings.getPaths() })
    await api.shell.openFolder(paths[which])
  } catch (e) {
    toastError(e, 'Couldn’t open the folder')
  }
}

export function openExternal(url: string) {
  void api.shell.openExternal(url).catch((e: unknown) => toastError(e, 'Couldn’t open the link'))
}

const RELEASES_URL = 'https://github.com/wynn-dev/amethyst/releases/tag/nightly'
const ISSUES_URL = 'https://github.com/wynn-dev/amethyst/issues/new'

/** Runs a menu-bar or palette command. The single dispatcher keeps menu, palette and shortcuts in sync. */
export function runCommand(command: MenuCommand, arg?: string): void {
  const ui = useUi.getState()
  const inst = currentInstance()
  const needInstance = (fn: (i: InstanceSummary) => void) => {
    if (inst) fn(inst)
    else toast({ kind: 'info', title: 'Select an instance first' })
  }

  switch (command) {
    case 'view.home':
      return void router.navigate({ to: '/' })
    case 'view.back':
      return router.history.back()
    case 'view.discover':
      return void router.navigate({ to: '/discover', search: {} })
    case 'view.palette':
      return ui.set({ palette: !ui.palette })
    case 'view.activity':
      return ui.set({ activity: !ui.activity })
    case 'view.toggleSidebar':
      return ui.set({ sidebarCollapsed: !ui.sidebarCollapsed })
    case 'view.toggleInspector':
      return ui.set({ inspector: !ui.inspector })
    case 'view.filterSidebar':
      ui.set({ sidebarCollapsed: false, sidebarFilterOpen: true })
      requestAnimationFrame(() => document.getElementById('sidebar-filter')?.focus())
      return
    case 'view.tab': {
      const id = currentInstanceId()
      const tab = INSTANCE_TABS[Number(arg) - 1] ?? (INSTANCE_TABS as readonly string[]).find((t) => t === arg)
      if (id && tab) openInstance(id, tab as InstanceTab)
      return
    }
    case 'help.shortcuts':
      return ui.set({ shortcuts: true })
    case 'file.newInstance':
      return ui.set({ newInstance: true })
    case 'file.newFolder':
      return ui.set({ newFolder: {} })
    case 'account.add':
      return ui.set({ addAccount: true })
    case 'account.manage':
    case 'account.editSkin':
      return openSettings('accounts')
    case 'edit.find':
      if (!focusFindTarget()) toast({ kind: 'info', title: 'Nothing to search here' })
      return
    case 'edit.findNext':
    case 'edit.findPrevious':
      window.dispatchEvent(new CustomEvent('amethyst:find-step', { detail: command === 'edit.findNext' ? 1 : -1 }))
      return
    case 'instance.play':
      return needInstance((i) => {
        if (i.state.kind === 'idle') instanceActions.launch(i)
        else if (i.state.kind === 'problem') toast({ kind: 'warning', title: `“${i.name}” can’t be played`, message: i.state.message })
        else toast({ kind: 'info', title: i.state.kind === 'running' ? `“${i.name}” is already running` : `“${i.name}” is busy` })
      })
    case 'instance.stop':
    case 'instance.forceStop':
      return needInstance((i) => {
        if (i.state.kind === 'running' || i.state.kind === 'launching') instanceActions.stop(i, command === 'instance.forceStop')
        else toast({ kind: 'info', title: `“${i.name}” isn’t running` })
      })
    case 'instance.addMods':
      return needInstance((i) => router.navigate({ to: '/discover', search: { type: 'mod', target: i.id } }))
    case 'instance.openLogs':
    case 'instance.openLogWindow':
      return needInstance((i) => openInstance(i.id, 'logs'))
    case 'instance.changeVersion':
      return needInstance((i) => ui.set({ changeVersion: { id: i.id, name: i.name } }))
    case 'instance.checkForUpdates':
      return needInstance((i) => openInstance(i.id, 'mods'))
    case 'instance.togglePin':
      return needInstance((i) => void libraryActions.togglePin(i))
    case 'instance.rename':
      return needInstance((i) => ui.set({ rename: { id: i.id, name: i.name } }))
    case 'instance.changeIcon':
      return needInstance((i) => void chooseInstanceIcon(i))
    case 'file.duplicate':
      return needInstance((i) => ui.set({ duplicate: { id: i.id, name: i.name } }))
    case 'file.trash':
      return needInstance((i) => ui.set({ trash: { id: i.id, name: i.name } }))
    case 'file.showInFinder':
      return needInstance((i) => void instanceActions.revealInFinder(i))
    case 'file.openDataFolder':
      return void openDataFolder('dataRoot')
    case 'instance.repair':
      return needInstance((i) => void instanceActions.repair(i))
    case 'app.about':
      return openSettings('about')
    case 'app.checkForUpdates': {
      const state = queryClient.getQueryData<UpdaterState>(updaterKey)
      if (state?.status === 'ready') return void updaterActions.restart()
      openSettings('updates')
      return void updaterActions.check()
    }
    case 'file.addExistingFolder':
      return ui.set({ newInstance: true, newInstanceSource: 'folder' })
    case 'file.importModpack':
      return void pickFiles('modpack', { title: 'Import Modpack' }).then(([path]) => path && openModpackImport({ path }))
    case 'file.importUrl':
      return useModpackUi.getState().set({ importUrl: true })
    case 'file.exportModpack':
      return needInstance((i) => openModpackExport(i.id, i.name))
    case 'instance.addFiles':
      return needInstance((i) => {
        const tab = currentTab()
        const kind = tab === 'resource-packs' ? 'resourcepacks' : tab === 'shaders' ? 'shaderpacks' : tab === 'worlds' ? 'saves' : 'mods'
        if (kind === 'mods' && tab !== 'mods') openInstance(i.id, 'mods')
        void pickFiles(kind).then(async (paths) => {
          if (paths.length > 0) await addResourceFiles(i.id, kind, paths)
        })
      })
    case 'help.openLauncherLogs':
      return void openDataFolder('logs')
    case 'help.releaseNotes':
      return openExternal(RELEASES_URL)
    case 'help.reportIssue':
      return openExternal(ISSUES_URL)
  }
}

/** Every shortcut, for the ⌘/ overlay and the palette. Mirrors `src/main/menu.ts`. */
export const SHORTCUTS: { group: string; items: { label: string; keys: string }[] }[] = [
  {
    group: 'General',
    items: [
      { label: 'Command Palette', keys: 'mod+k' },
      { label: 'Settings', keys: 'mod+comma' },
      { label: 'Keyboard Shortcuts', keys: 'mod+slash' },
      { label: 'New Instance', keys: 'mod+n' },
      { label: 'New Folder', keys: 'shift+mod+n' },
      { label: 'Import Modpack', keys: 'mod+o' },
      { label: 'Add Existing Folder', keys: 'shift+mod+o' },
      { label: 'Import from URL', keys: 'alt+mod+o' },
      { label: 'Find', keys: 'mod+f' },
      { label: 'Find Next / Previous', keys: 'mod+g' },
    ],
  },
  {
    group: 'View',
    items: [
      { label: 'Home', keys: 'shift+mod+h' },
      { label: 'Discover', keys: 'shift+mod+d' },
      { label: 'Activity', keys: 'alt+mod+a' },
      { label: 'Instance tabs (Overview … Settings)', keys: 'mod+1' },
      { label: 'Show/Hide Sidebar', keys: 'ctrl+mod+s' },
      { label: 'Show/Hide Inspector', keys: 'alt+mod+i' },
      { label: 'Filter Sidebar', keys: 'alt+mod+f' },
      { label: 'Enter Full Screen', keys: 'ctrl+mod+f' },
    ],
  },
  {
    group: 'Instance',
    items: [
      { label: 'Play', keys: 'mod+enter' },
      { label: 'Stop', keys: 'mod+period' },
      { label: 'Force Stop', keys: 'alt+mod+period' },
      { label: 'Add Mods', keys: 'shift+mod+a' },
      { label: 'Check for Updates', keys: 'shift+mod+u' },
      { label: 'Open Logs', keys: 'mod+l' },
      { label: 'Open Log Window', keys: 'alt+mod+l' },
      { label: 'Export Modpack', keys: 'shift+mod+e' },
      { label: 'Duplicate Instance', keys: 'mod+d' },
      { label: 'Show in Finder', keys: 'shift+mod+r' },
      { label: 'Move to Trash', keys: 'mod+backspace' },
    ],
  },
  {
    group: 'Lists and tables',
    items: [
      { label: 'Select All', keys: 'mod+a' },
      { label: 'Toggle Enabled', keys: 'space' },
      { label: 'Open', keys: 'enter' },
      { label: 'Move Up / Down in Load Order', keys: 'alt+mod+up' },
      { label: 'Move to Trash', keys: 'mod+backspace' },
    ],
  },
]
