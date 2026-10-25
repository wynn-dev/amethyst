import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, shell, type OpenDialogOptions as ElectronOpenDialogOptions } from 'electron'
import type { MenuContext } from '@shared/menu'
import type { DialogService, FileFilter, ShellService, ThemeMode, WindowService } from '@shared/services'
import { callingWebContents } from './rpc/server'
import { showHiddenWindows } from './runtime'

/**
 * Small window, Finder and dialog services the renderer needs (main process only). Every input is
 * validated here: paths must be absolute, URLs must be `https:`.
 */

const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

function absolute(p: unknown): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw fail('EINVALID_ARGUMENT', 'An absolute path is required')
  return p
}

function filters(list: FileFilter[] | undefined): FileFilter[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list
    .filter((f) => typeof f?.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name, extensions: f.extensions.filter((e) => typeof e === 'string' && /^[\w*]+$/.test(e)) }))
}

/**
 * Dev-only UI drivers (`AMETHYST_E2E_UI`) answer panels themselves: a queued answer is returned
 * instead of showing the native panel. Nothing is ever queued in normal runs.
 */
const e2eAnswers: (string[] | string | null)[] = []
export function queueDialogAnswer(answer: string[] | string | null): void {
  e2eAnswers.push(answer)
}

export function windowService(mainWindow: () => BrowserWindow | undefined, onMenuContext: (context: MenuContext) => void): WindowService {
  return {
    async setThemeSource(theme: ThemeMode) {
      if (theme !== 'light' && theme !== 'dark' && theme !== 'system') throw fail('EINVALID_ARGUMENT', 'Unknown theme')
      // Screenshot and UI end-to-end runs pin the theme themselves.
      if (process.env.AMETHYST_SCREENSHOT || process.env.AMETHYST_E2E_UI) return
      nativeTheme.themeSource = theme
    },
    async setDockProgress(fraction) {
      const value = fraction === null || !Number.isFinite(fraction) ? -1 : Math.min(1, Math.max(0, fraction))
      mainWindow()?.setProgressBar(value)
    },
    async setDockBadge(text) {
      app.dock?.setBadge(typeof text === 'string' ? text.slice(0, 8) : '')
    },
    async focusMain() {
      showHiddenWindows()
      const win = mainWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    async setMenuContext(context) {
      // Only the main window has a selection; other windows' (stale or hostile) calls are ignored.
      const caller = callingWebContents()
      if (!caller || caller !== mainWindow()?.webContents) return
      onMenuContext(context)
    },
  }
}

/** Folder extensions macOS treats as packages (opened, launched or installed as one item, not browsed). */
const PACKAGE_EXTENSIONS = new Set([
  'action',
  'app',
  'appex',
  'bundle',
  'component',
  'framework',
  'kext',
  'mdimporter',
  'mpkg',
  'pkg',
  'plugin',
  'prefpane',
  'qlgenerator',
  'saver',
  'service',
  'systemextension',
  'wdgt',
  'workflow',
  'xpc',
])

/**
 * True for a folder Finder would open as a package rather than browse: a known package
 * extension, or any `name.ext` folder with a bundle's `Contents/Info.plist`.
 */
export async function isPackageDirectory(dir: string): Promise<boolean> {
  const ext = /\.([A-Za-z0-9-]+)$/.exec(path.basename(dir))?.[1]?.toLowerCase()
  if (!ext) return false
  if (PACKAGE_EXTENSIONS.has(ext)) return true
  return (await stat(path.join(dir, 'Contents', 'Info.plist')).catch(() => undefined)) !== undefined
}

export const shellService: ShellService = {
  async showItemInFolder(p) {
    const file = absolute(p)
    if (!(await stat(file).catch(() => undefined))) throw fail('ENOT_FOUND', 'The file or folder no longer exists')
    shell.showItemInFolder(file)
  },
  async openFolder(p) {
    // Through symlinks: what matters is what Finder would open.
    const dir = await realpath(absolute(p)).catch(() => undefined)
    const st = dir ? await stat(dir).catch(() => undefined) : undefined
    if (!dir || !st) throw fail('ENOT_FOUND', 'The folder no longer exists')
    // `openPath` on an app (or any other bundle) launches or installs it: only ever reveal those.
    if (!st.isDirectory() || (await isPackageDirectory(dir))) return shell.showItemInFolder(dir)
    const error = await shell.openPath(dir)
    if (error) throw fail('EOPEN_FAILED', error)
  },
  async openExternal(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw fail('EINVALID_ARGUMENT', 'Only https: links can be opened')
    await shell.openExternal(url)
  },
}

export function dialogService(): DialogService {
  return {
    async open(options) {
      if (e2eAnswers.length > 0) {
        const a = e2eAnswers.shift()
        return Array.isArray(a) ? a : a ? [a] : []
      }
      const o = options ?? {}
      const properties: ElectronOpenDialogOptions['properties'] = [o.directory ? 'openDirectory' : 'openFile']
      if (o.multiple) properties.push('multiSelections')
      if (o.treatPackagesAsDirectories) properties.push('treatPackageAsDirectory')
      const f = filters(o.filters)
      const opts: ElectronOpenDialogOptions = {
        properties,
        ...(typeof o.title === 'string' ? { title: o.title, message: o.title } : {}),
        ...(f ? { filters: f } : {}),
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      return result.canceled ? [] : result.filePaths
    },
    async saveFile(options) {
      if (e2eAnswers.length > 0) {
        const a = e2eAnswers.shift()
        return Array.isArray(a) ? (a[0] ?? null) : (a ?? null)
      }
      const o = options ?? {}
      const f = filters(o.filters)
      const opts = {
        ...(typeof o.title === 'string' ? { title: o.title, message: o.title } : {}),
        ...(typeof o.defaultName === 'string' ? { defaultPath: o.defaultName.replace(/[/:]/g, '-') } : {}),
        ...(f ? { filters: f } : {}),
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
      return result.canceled || !result.filePath ? null : result.filePath
    },
  }
}
