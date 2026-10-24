import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { MarketPlatform, ModpackImportInput, ModpackImportResult, ModpackManualFile, ModpackSource, ModpackUpdateResult } from '@shared/services'
import { api, subscribe } from '@/lib/rpc'
import { reportError } from '@/lib/error-text'
import { revealInFinder } from '@/lib/files'
import { toast, toasts } from '@/ui/toast-store'
import { queryClient } from './query'

/** Modpack import, the blocked-files flow, updates and export over `api.modpacks`. */

export const modpackKeys = {
  preview: (source: ModpackSource) => ['modpack', 'preview', source] as const,
  manual: (instanceId: string) => ['modpack', 'manual', instanceId] as const,
  update: (instanceId: string) => ['modpack', 'update', instanceId] as const,
  exportFiles: (instanceId: string) => ['modpack', 'export-files', instanceId] as const,
}

/** Window surfaces for modpacks: which sheet or dialog is open, and for what. */
interface ModpackUi {
  /** The pack being previewed for import. */
  importing: ModpackSource | null
  /** "Import from URL…" sheet. */
  importUrl: boolean
  /** "Missing files" dialog for an instance. */
  missing: { instanceId: string; name: string } | null
  /** "Export Modpack…" sheet. */
  exporting: { instanceId: string; name: string } | null
  /** "Update Modpack" sheet. */
  updating: { instanceId: string; name: string } | null
  set: (patch: Partial<Omit<ModpackUi, 'set'>>) => void
}

export const useModpackUi = create<ModpackUi>((set) => ({ importing: null, importUrl: false, missing: null, exporting: null, updating: null, set: (patch) => set(patch) }))

export const openModpackImport = (source: ModpackSource) => useModpackUi.getState().set({ importing: source, importUrl: false })
export const openModpackExport = (instanceId: string, name: string) => useModpackUi.getState().set({ exporting: { instanceId, name } })
export const openModpackUpdate = (instanceId: string, name: string) => useModpackUi.getState().set({ updating: { instanceId, name } })

export function useModpackPreview(source: ModpackSource | null) {
  return useQuery({ queryKey: modpackKeys.preview(source ?? { path: '' }), queryFn: () => api.modpacks.preview(source as ModpackSource), enabled: !!source, staleTime: 60_000, gcTime: 60_000 })
}

/** After an import or install: success toast, then the Missing files dialog when needed. */
function finished(result: ModpackImportResult, name: string, open: (id: string) => void): void {
  void queryClient.invalidateQueries({ queryKey: ['instance-info'] })
  void queryClient.invalidateQueries({ queryKey: ['instances'] })
  if (result.manual.length > 0) {
    queryClient.setQueryData<ManualState>(modpackKeys.manual(result.instanceId), { files: result.manual, watching: false })
    useModpackUi.getState().set({ missing: { instanceId: result.instanceId, name } })
  }
  toast({
    kind: result.runtimeError ? 'warning' : 'success',
    title: `Imported “${name}”`,
    message: result.runtimeError
      ? `The files are in place, but the game version couldn’t be installed yet: ${result.runtimeError.message}`
      : `${result.installed} file${result.installed === 1 ? '' : 's'} installed${result.manual.length ? `, ${result.manual.length} need a manual download` : ''}.`,
    actions: [{ label: 'Open', onClick: () => open(result.instanceId) }],
  })
}

export async function importModpack(input: ModpackImportInput, name: string, open: (id: string) => void): Promise<ModpackImportResult | undefined> {
  const pending = toast({ kind: 'info', title: `Importing “${name}”…`, message: 'Progress is shown in Activity.', duration: 0 })
  try {
    const result = await api.modpacks.import(input).finally(() => toasts.dismiss(pending))
    finished(result, name, open)
    return result
  } catch (e) {
    reportError(`Couldn’t import “${name}”`, e)
    return undefined
  }
}

export async function installModpackFromMarket(input: { platform: MarketPlatform; projectId: string; versionId: string; name?: string }, title: string, open: (id: string) => void) {
  const pending = toast({ kind: 'info', title: `Installing “${title}”…`, message: 'A new instance is being created. Progress is shown in Activity.', duration: 0 })
  try {
    const result = await api.modpacks.installFromMarket(input).finally(() => toasts.dismiss(pending))
    finished(result, title, open)
    return result
  } catch (e) {
    reportError(`Couldn’t install “${title}”`, e)
    return undefined
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Missing (blocked CurseForge) files                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface ManualState {
  files: ModpackManualFile[]
  watching: boolean
  /** File names matched most recently (shown as "Found …"). */
  matched?: string[]
}

export function useManualFiles(instanceId: string | undefined) {
  return useQuery({
    queryKey: modpackKeys.manual(instanceId ?? ''),
    queryFn: async (): Promise<ManualState> => ({ files: await api.modpacks.listManualFiles(instanceId ?? ''), watching: false }),
    enabled: !!instanceId,
  })
}

let installed = false
function installModpackEvents(): void {
  if (installed) return
  installed = true
  subscribe('modpack:manual', ({ instanceId, matched, manual, watching }) => {
    queryClient.setQueryData<ManualState>(modpackKeys.manual(instanceId), (prev) => ({ files: manual, watching, matched: matched.length ? [...(prev?.matched ?? []), ...matched] : prev?.matched }))
    for (const name of matched) toast({ kind: 'success', title: `Found ${name}`, message: manual.length ? `${manual.length} still missing.` : 'Every missing file is in place.' })
  })
}
installModpackEvents()

export async function watchManualDownloads(instanceId: string): Promise<void> {
  try {
    const files = await api.modpacks.watchManualDownloads(instanceId)
    queryClient.setQueryData<ManualState>(modpackKeys.manual(instanceId), (prev) => ({ ...prev, files, watching: files.length > 0 }))
  } catch (e) {
    reportError('Couldn’t watch the Downloads folder', e)
  }
}

export function stopWatchingManualDownloads(instanceId: string): void {
  api.modpacks.stopWatchingManualDownloads(instanceId).catch(() => undefined)
}

export async function provideManualFiles(instanceId: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each file is hashed and placed in turn
      const r = await api.modpacks.provideManualFile(p, instanceId)
      if (!r.matched) toast({ kind: 'warning', title: `${p.split('/').pop()} isn’t one of the missing files`, message: 'Its contents don’t match any file the modpack needs.' })
      queryClient.setQueryData<ManualState>(modpackKeys.manual(instanceId), (prev) => ({ watching: prev?.watching ?? false, ...prev, files: r.manual }))
    } catch (e) {
      reportError(`Couldn’t use ${p.split('/').pop()}`, e)
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Updates and export                                                                         */
/* ------------------------------------------------------------------------------------------ */

export function useModpackUpdateCheck(instanceId: string, enabled: boolean) {
  return useQuery({ queryKey: modpackKeys.update(instanceId), queryFn: () => api.modpacks.checkUpdate(instanceId), enabled: enabled && !!instanceId, staleTime: 10 * 60_000 })
}

export async function rollbackModpack(instanceId: string, backupId: string, name: string): Promise<void> {
  try {
    await api.modpacks.rollback(instanceId, backupId)
    void queryClient.invalidateQueries({ queryKey: modpackKeys.update(instanceId) })
    toast({ kind: 'success', title: `Rolled back “${name}”`, message: 'The files from before the update are back.' })
  } catch (e) {
    reportError(`Couldn’t roll back “${name}”`, e)
  }
}

export function reportUpdateResult(instanceId: string, name: string, version: string, r: ModpackUpdateResult): void {
  void queryClient.invalidateQueries({ queryKey: modpackKeys.update(instanceId) })
  void queryClient.invalidateQueries({ queryKey: ['instance-info'] })
  if (r.manual.length > 0) {
    queryClient.setQueryData<ManualState>(modpackKeys.manual(instanceId), { files: r.manual, watching: false })
    useModpackUi.getState().set({ missing: { instanceId, name } })
  }
  toast({
    kind: r.runtimeError ? 'warning' : 'success',
    title: `Updated “${name}” to ${version}`,
    message: `${r.added} added · ${r.updated} updated · ${r.removed} removed${r.runtimeError ? `. The game version couldn’t be installed yet: ${r.runtimeError.message}` : ''}`,
    duration: 12_000,
    actions: [{ label: 'Roll Back', onClick: () => void rollbackModpack(instanceId, r.backupId, name) }],
  })
}

export function useExportFiles(instanceId: string | undefined) {
  return useQuery({ queryKey: modpackKeys.exportFiles(instanceId ?? ''), queryFn: () => api.modpacks.listExportFiles(instanceId ?? ''), enabled: !!instanceId, staleTime: 0, gcTime: 0 })
}

export async function exportModpack(instanceId: string, name: string, input: Parameters<typeof api.modpacks.export>[1]): Promise<boolean> {
  try {
    const r = await api.modpacks.export(instanceId, input)
    toast({
      kind: r.warnings.length ? 'warning' : 'success',
      title: `Exported “${name}”`,
      message: `${r.linked} linked, ${r.embedded} bundled${r.warnings.length ? `. ${r.warnings[0]}` : ''}`,
      actions: [{ label: 'Show in Finder', onClick: () => revealInFinder(r.path) }],
    })
    return true
  } catch (e) {
    reportError(`Couldn’t export “${name}”`, e)
    return false
  }
}
