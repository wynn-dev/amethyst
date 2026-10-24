import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import type { DialogService, FileFilter, ShellService } from '@shared/services'
import { registerMainService } from './rpc/server'

/**
 * Native open/save panels and Finder/browser hand-offs for the renderer (`api.dialog`,
 * `api.shell`). Panels are sheets on the focused window, as macOS expects.
 */

const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

function filters(list: FileFilter[] | undefined): Electron.FileFilter[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list
    .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name, extensions: f.extensions.filter((e) => typeof e === 'string' && /^[\w*]+$/.test(e)) }))
}

const parent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

/**
 * Dev-only UI drivers (`AMETHYST_E2E_UI`) answer panels themselves: a queued answer is returned
 * instead of showing the native panel. Never set in packaged builds.
 */
const e2eAnswers: (string[] | string | null)[] = []
export function queueDialogAnswer(answer: string[] | string | null): void {
  e2eAnswers.push(answer)
}

export const dialogService: DialogService = {
  async openFiles(options = {}) {
    if (e2eAnswers.length > 0) {
      const a = e2eAnswers.shift()
      return Array.isArray(a) ? a : a ? [a] : []
    }
    const properties: OpenDialogOptions['properties'] = [options.directories ? 'openDirectory' : 'openFile']
    if (options.multiple) properties.push('multiSelections')
    const opts: OpenDialogOptions = {
      properties,
      ...(options.title ? { title: options.title, message: options.title } : {}),
      ...(options.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
      ...(filters(options.filters) ? { filters: filters(options.filters) } : {}),
    }
    const win = parent()
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  },
  async saveFile(options = {}) {
    if (e2eAnswers.length > 0) {
      const a = e2eAnswers.shift()
      return Array.isArray(a) ? (a[0] ?? null) : (a ?? null)
    }
    const opts = {
      ...(options.title ? { title: options.title, message: options.title } : {}),
      ...(options.defaultName ? { defaultPath: options.defaultName.replace(/[/:]/g, '-') } : {}),
      ...(filters(options.filters) ? { filters: filters(options.filters) } : {}),
    }
    const win = parent()
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return res.canceled || !res.filePath ? null : res.filePath
  },
}

export const shellService: ShellService = {
  async openExternal(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw fail('EINVALID_ARGUMENT', 'Only https: links can be opened')
    await shell.openExternal(url)
  },
  async showItemInFolder(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw fail('EINVALID_ARGUMENT', 'An absolute path is required')
    if (!(await stat(path).catch(() => undefined))) throw fail('ENOT_FOUND', 'The file no longer exists')
    shell.showItemInFolder(path)
  },
}

export function registerOsServices(): void {
  registerMainService('dialog', { ...dialogService })
  registerMainService('shell', { ...shellService })
}
