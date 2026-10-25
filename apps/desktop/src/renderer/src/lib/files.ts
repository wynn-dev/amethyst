import type { FileFilter, ResourceKind } from '@shared/services'
import { api } from './rpc'
import { toastError } from './error-messages'

/** Local files: native panels (through main), dropped files and Finder/browser hand-offs. */

export const FILTERS: Record<ResourceKind | 'modpack', FileFilter[]> = {
  mods: [{ name: 'Mods', extensions: ['jar'] }],
  resourcepacks: [{ name: 'Resource Packs', extensions: ['zip'] }],
  shaderpacks: [{ name: 'Shader Packs', extensions: ['zip'] }],
  saves: [{ name: 'World Archives', extensions: ['zip'] }],
  modpack: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }],
}

/** The absolute paths of dropped files (empty for drags that carry no files). */
export function droppedPaths(data: DataTransfer | null): string[] {
  if (!data) return []
  const out: string[] = []
  for (const file of Array.from(data.files)) {
    const p = window.amethyst?.pathForFile?.(file)
    if (p) out.push(p)
  }
  return out
}

/** True while a drag carries files (not text or links). */
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

export const isModpackPath = (p: string) => /\.mrpack$/i.test(p)
export const isZipPath = (p: string) => /\.zip$/i.test(p)

export async function pickFiles(kind: ResourceKind | 'modpack', options: { multiple?: boolean; title?: string } = {}): Promise<string[]> {
  try {
    return await api.dialog.open({ filters: FILTERS[kind], multiple: options.multiple ?? kind !== 'modpack', ...(options.title ? { title: options.title } : {}) })
  } catch (e) {
    toastError(e, 'Couldn’t open the file picker')
    return []
  }
}

export async function pickFolder(title: string): Promise<string | undefined> {
  try {
    return (await api.dialog.open({ directory: true, title }))[0]
  } catch (e) {
    toastError(e, 'Couldn’t open the folder picker')
    return undefined
  }
}

export async function pickSaveFile(defaultName: string, filters: FileFilter[], title?: string): Promise<string | null> {
  try {
    return await api.dialog.saveFile({ defaultName, filters, ...(title ? { title } : {}) })
  } catch (e) {
    toastError(e, 'Couldn’t open the save panel')
    return null
  }
}

/** Open an `https:` link in the default browser; anything else is refused. */
export function openExternal(url: string | null | undefined): void {
  if (!url || !/^https:\/\//i.test(url)) {
    toastError({ message: 'Only secure (https) links can be opened.' }, 'Couldn’t open the link')
    return
  }
  api.shell.openExternal(url).catch((e: unknown) => toastError(e, 'Couldn’t open the link'))
}

export function revealInFinder(path: string | null | undefined): void {
  if (!path) return
  api.shell.showItemInFolder(path).catch((e: unknown) => toastError(e, 'Couldn’t show the file in Finder'))
}
