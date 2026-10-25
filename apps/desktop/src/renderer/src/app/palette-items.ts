import type { MenuCommand, InstanceTab } from '@shared/menu'
import { INSTANCE_TABS } from '@shared/menu'
import type { InstanceSummary } from '@/data/types'
import { versionLabel } from '@/data/instances'
import { rank, type FuzzyMatch } from './fuzzy'
import { SETTINGS_INDEX, SETTINGS_PANES, type ToggleAction, type ToggleSource } from './settings-index'

export type PaletteGroup = 'Recent Instances' | 'Suggested' | 'Instances' | 'Actions' | 'Navigation' | 'Settings' | 'Discover'

export type PaletteAction =
  | { kind: 'command'; command: MenuCommand; arg?: string }
  | { kind: 'open-instance'; id: string; tab?: InstanceTab }
  | { kind: 'launch'; id: string }
  | { kind: 'settings'; pane: string; row?: string }
  | { kind: 'discover'; query: string }
  | { kind: 'navigate'; to: '/' | '/discover' }

export interface PaletteItem {
  id: string
  group: PaletteGroup
  title: string
  subtitle?: string
  keywords?: string[]
  shortcut?: string
  /** Icon hint for the view: an instance (block icon) or a named glyph. */
  icon: { kind: 'instance'; hue: number; name: string } | { kind: 'glyph'; name: 'action' | 'nav' | 'settings' | 'search' | 'tab' }
  run: PaletteAction
  /** ⌘Return. */
  secondary?: PaletteAction
  /** → / Tab drills into these. */
  children?: PaletteItem[]
  /** Inline toggle (Space). */
  toggle?: { on: boolean; action: ToggleAction }
}

export interface PaletteContext {
  instances: InstanceSummary[]
  currentInstanceId?: string
  settings: ToggleSource
}

const TAB_TITLES: Record<InstanceTab, string> = {
  overview: 'Overview',
  mods: 'Mods',
  'resource-packs': 'Resource Packs',
  shaders: 'Shaders',
  worlds: 'Worlds',
  logs: 'Logs',
  settings: 'Settings',
}

/** Every palette action that mirrors a menu-bar command, with its shortcut. */
const ACTIONS: { title: string; command: MenuCommand; shortcut?: string; keywords?: string[]; arg?: string; needsInstance?: boolean }[] = [
  { title: 'New Instance…', command: 'file.newInstance', shortcut: 'mod+n', keywords: ['create'] },
  { title: 'New Folder', command: 'file.newFolder', shortcut: 'shift+mod+n' },
  { title: 'Import Modpack…', command: 'file.importModpack', shortcut: 'mod+o', keywords: ['mrpack', 'zip', 'curseforge'] },
  { title: 'Add Existing Folder…', command: 'file.addExistingFolder', shortcut: 'shift+mod+o', keywords: ['prism', 'multimc', '.minecraft'] },
  { title: 'Import from URL…', command: 'file.importUrl', shortcut: 'alt+mod+o' },
  { title: 'Export Modpack…', command: 'file.exportModpack', shortcut: 'shift+mod+e', needsInstance: true },
  { title: 'Duplicate Instance…', command: 'file.duplicate', shortcut: 'mod+d', needsInstance: true },
  { title: 'Show in Finder', command: 'file.showInFinder', shortcut: 'shift+mod+r', needsInstance: true, keywords: ['reveal'] },
  { title: 'Reveal Data Folder', command: 'file.openDataFolder' },
  { title: 'Move to Trash…', command: 'file.trash', shortcut: 'mod+backspace', needsInstance: true, keywords: ['delete', 'remove'] },
  { title: 'Play', command: 'instance.play', shortcut: 'mod+enter', needsInstance: true, keywords: ['launch', 'start'] },
  { title: 'Stop', command: 'instance.stop', shortcut: 'mod+period', needsInstance: true, keywords: ['kill', 'quit game'] },
  { title: 'Add Mods…', command: 'instance.addMods', shortcut: 'shift+mod+a', needsInstance: true, keywords: ['browse mods', 'install'] },
  { title: 'Check for Updates', command: 'instance.checkForUpdates', shortcut: 'shift+mod+u', needsInstance: true, keywords: ['update mods'] },
  { title: 'Change Version…', command: 'instance.changeVersion', needsInstance: true, keywords: ['minecraft version', 'loader'] },
  { title: 'Repair Files', command: 'instance.repair', needsInstance: true, keywords: ['verify', 'integrity'] },
  { title: 'Open Logs', command: 'instance.openLogs', shortcut: 'mod+l', needsInstance: true, keywords: ['console', 'crash'] },
  { title: 'Pin/Unpin Instance', command: 'instance.togglePin', needsInstance: true },
  { title: 'Rename Instance…', command: 'instance.rename', needsInstance: true },
  { title: 'Change Icon…', command: 'instance.changeIcon', needsInstance: true },
  { title: 'Reveal Launcher Logs', command: 'help.openLauncherLogs', keywords: ['log folder'] },
  { title: 'Release Notes', command: 'help.releaseNotes', keywords: ['changelog', 'what’s new'] },
  { title: 'Add Account…', command: 'account.add', keywords: ['sign in', 'login', 'microsoft'] },
  { title: 'Manage Accounts…', command: 'account.manage', keywords: ['skin'] },
  { title: 'Show Activity', command: 'view.activity', shortcut: 'alt+mod+a', keywords: ['downloads', 'tasks', 'progress'] },
  { title: 'Show/Hide Sidebar', command: 'view.toggleSidebar', shortcut: 'ctrl+mod+s' },
  { title: 'Show/Hide Inspector', command: 'view.toggleInspector', shortcut: 'alt+mod+i' },
  { title: 'Check for Updates (Amethyst)', command: 'app.checkForUpdates', keywords: ['restart to update'] },
  { title: 'Keyboard Shortcuts', command: 'help.shortcuts', shortcut: 'mod+slash', keywords: ['help', 'cheatsheet'] },
  { title: 'Report an Issue…', command: 'help.reportIssue', keywords: ['bug', 'github'] },
]

export function buildPaletteItems(ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = []
  const hasInstance = !!ctx.currentInstanceId

  for (const inst of ctx.instances) {
    const icon = { kind: 'instance' as const, hue: inst.iconHue, name: inst.name }
    const children: PaletteItem[] = [
      { id: `${inst.id}:open`, group: 'Instances', title: 'Open', icon, run: { kind: 'open-instance', id: inst.id } },
      { id: `${inst.id}:launch`, group: 'Instances', title: 'Launch', shortcut: 'mod+enter', icon, run: { kind: 'launch', id: inst.id } },
      { id: `${inst.id}:finder`, group: 'Instances', title: 'Show in Finder', icon, run: { kind: 'command', command: 'file.showInFinder' } },
      { id: `${inst.id}:dup`, group: 'Instances', title: 'Duplicate…', icon, run: { kind: 'command', command: 'file.duplicate' } },
      { id: `${inst.id}:settings`, group: 'Instances', title: 'Settings', icon, run: { kind: 'open-instance', id: inst.id, tab: 'settings' } },
    ]
    items.push({
      id: `inst:${inst.id}`,
      group: 'Instances',
      title: inst.name,
      subtitle: versionLabel(inst),
      keywords: [inst.minecraft],
      icon,
      run: { kind: 'open-instance', id: inst.id },
      secondary: { kind: 'launch', id: inst.id },
      children,
    })
    for (const tab of INSTANCE_TABS) {
      items.push({
        id: `nav:${inst.id}:${tab}`,
        group: 'Navigation',
        title: `${inst.name} › ${TAB_TITLES[tab]}`,
        icon: { kind: 'glyph', name: 'tab' },
        run: { kind: 'open-instance', id: inst.id, tab },
      })
    }
  }

  for (const a of ACTIONS) {
    if (a.needsInstance && !hasInstance) continue
    items.push({
      id: `cmd:${a.command}:${a.title}`,
      group: 'Actions',
      title: a.title,
      shortcut: a.shortcut,
      keywords: a.keywords,
      icon: { kind: 'glyph', name: 'action' },
      run: { kind: 'command', command: a.command, arg: a.arg },
    })
  }

  items.push(
    { id: 'nav:home', group: 'Navigation', title: 'Home', shortcut: 'shift+mod+h', icon: { kind: 'glyph', name: 'nav' }, run: { kind: 'navigate', to: '/' } },
    { id: 'nav:discover', group: 'Navigation', title: 'Discover', shortcut: 'shift+mod+d', keywords: ['browse', 'modrinth', 'curseforge', 'store'], icon: { kind: 'glyph', name: 'nav' }, run: { kind: 'navigate', to: '/discover' } },
  )

  for (const pane of SETTINGS_PANES) {
    items.push({ id: `set:${pane.id}`, group: 'Settings', title: `Settings › ${pane.title}`, icon: { kind: 'glyph', name: 'settings' }, run: { kind: 'settings', pane: pane.id } })
  }
  for (const row of SETTINGS_INDEX) {
    const pane = SETTINGS_PANES.find((p) => p.id === row.pane)!
    items.push({
      id: `set:${row.pane}:${row.row}`,
      group: 'Settings',
      title: row.title,
      subtitle: pane.title,
      keywords: row.keywords,
      icon: { kind: 'glyph', name: 'settings' },
      run: { kind: 'settings', pane: row.pane, row: row.row },
      toggle: row.toggle ? { on: row.toggle.get(ctx.settings), action: row.toggle.action(ctx.settings, !row.toggle.get(ctx.settings)) } : undefined,
    })
  }
  return items
}

const GROUP_ORDER: PaletteGroup[] = ['Instances', 'Actions', 'Navigation', 'Settings', 'Discover']
const GROUP_LIMIT: Partial<Record<PaletteGroup, number>> = { Instances: 6, Actions: 8, Navigation: 6, Settings: 6 }

export interface PaletteResult {
  item: PaletteItem
  match?: FuzzyMatch
}

/** Empty query: recent instances and suggestions. Otherwise ranked, grouped matches. Capped at 40 rows. */
export function searchPalette(items: PaletteItem[], query: string, ctx: PaletteContext): PaletteResult[] {
  const q = query.trim()
  if (!q) {
    const recent = ctx.instances
      .filter((i) => i.lastPlayedAt)
      .toSorted((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      .slice(0, 5)
      .map((i) => items.find((x) => x.id === `inst:${i.id}`))
      .filter((x): x is PaletteItem => !!x)
      .map((item) => ({ item: { ...item, group: 'Recent Instances' as const } }))
    const suggested: PaletteResult[] = [
      items.find((i) => i.id.startsWith('cmd:file.newInstance')),
      items.find((i) => i.id.startsWith('cmd:file.importModpack')),
      ctx.currentInstanceId ? items.find((i) => i.id.startsWith('cmd:instance.addMods')) : undefined,
      items.find((i) => i.id === 'set:general'),
    ]
      .filter((x): x is PaletteItem => !!x)
      .map((item) => ({ item: { ...item, group: 'Suggested' as const, title: item.id === 'set:general' ? 'Open Settings' : item.title.replace('Add Mods…', 'Browse Mods for This Instance') } }))
    return [...recent, ...suggested]
  }

  const ranked = rank(items, q, (i) => [i.title, ...(i.subtitle ? [i.subtitle] : []), ...(i.keywords ?? [])])
  const out: PaletteResult[] = []
  for (const group of GROUP_ORDER) {
    const inGroup = ranked.filter((r) => r.item.group === group).slice(0, GROUP_LIMIT[group] ?? 6)
    for (const r of inGroup) out.push({ item: r.item, match: r.match })
  }
  if (q.length >= 2) {
    out.push({
      item: {
        id: 'discover:search',
        group: 'Discover',
        title: `Search Modrinth and CurseForge for “${q}”`,
        icon: { kind: 'glyph', name: 'search' },
        run: { kind: 'discover', query: q },
      },
    })
  }
  return out.slice(0, 40)
}
