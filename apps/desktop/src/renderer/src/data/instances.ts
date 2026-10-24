import { useMutation, useQuery } from '@tanstack/react-query'
import { fixture, queryClient } from './query'
import type { InstanceDetail as RuntimeInstanceDetail, InstanceSummary as RuntimeInstanceRow } from '@shared/services'
import { api } from '@/lib/rpc'
import { fixtureFolders } from './fixtures'
import type { InstanceDetail, InstanceFolder, InstanceSummary } from './types'
import { toast } from '@/ui/toast-store'

export const instanceKeys = {
  list: ['instances'] as const,
  folders: ['instances', 'folders'] as const,
  detail: (id: string) => ['instances', id] as const,
}

/**
 * Every instance, in sidebar order.
 * TODO(wire): replace with api.instances.list() → InstanceSummary[]; invalidate on `instances:changed`.
 */
export function useInstances() {
  return useQuery({
    queryKey: instanceKeys.list,
    // Interim wiring (content agent) so content tabs open for real instances; the sidebar wiring replaces it.
    queryFn: async () => (await api.instances.list()).map(toSummary),
  })
}

/**
 * Sidebar folders, with their persisted expanded state.
 * TODO(wire): replace with api.instances.listFolders() → InstanceFolder[].
 */
export function useInstanceFolders() {
  return useQuery({
    queryKey: instanceKeys.folders,
    queryFn: () => fixture(() => structuredClone(fixtureFolders), () => []),
  })
}

/**
 * One instance with its counts, issues and screenshots.
 * TODO(wire): replace with api.instances.get(id) → InstanceDetail; invalidate on `instances:changed`.
 */
export function useInstance(id: string) {
  return useQuery({
    queryKey: instanceKeys.detail(id),
    queryFn: async (): Promise<InstanceDetail | null> => {
      try {
        const d = await api.instances.get(id)
        return { ...toSummary(d), path: d.path, notes: d.description, diskBytes: 0, counts: { modsEnabled: 0, modsTotal: 0, resourcePacks: 0, shaders: 0, worlds: 0 }, issues: [], screenshots: [] }
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOT_FOUND') return null
        throw e
      }
    },
  })
}

/** Runtime instance row → sidebar view model (interim, see useInstances). */
function toSummary(r: RuntimeInstanceRow & { upstream?: RuntimeInstanceDetail['upstream'] }): InstanceSummary {
  let hue = 0
  for (const ch of r.id) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  const state: InstanceSummary['state'] =
    r.activity === 'running' ? { kind: 'running', pid: 0, since: r.lastPlayedAt } : r.activity === 'launching' ? { kind: 'launching' } : r.activity === 'installing' ? { kind: 'installing', progress: 0, taskId: '' } : { kind: 'idle' }
  return {
    id: r.id,
    name: r.name,
    ...(r.iconUrl ? { iconUrl: r.iconUrl } : {}),
    iconHue: hue,
    minecraft: r.minecraft,
    loader: r.loader ? { kind: r.loader.kind, version: r.loader.version } : { kind: 'vanilla' },
    pinned: false,
    state,
    ...(r.lastPlayedAt ? { lastPlayedAt: r.lastPlayedAt } : {}),
    playTimeMs: r.playTimeMs,
    createdAt: r.createdAt,
    ...(r.upstream
      ? { upstream: { source: r.upstream.kind, projectId: String(r.upstream.projectId), projectName: r.name, version: 'versionId' in r.upstream ? r.upstream.versionId : String(r.upstream.fileId) } }
      : {}),
  }
}

function patchInstance(id: string, patch: Partial<InstanceSummary>) {
  queryClient.setQueryData<InstanceSummary[]>(instanceKeys.list, (list) => list?.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  queryClient.setQueryData<InstanceDetail | null>(instanceKeys.detail(id), (d) => (d ? { ...d, ...patch } : d))
}

/**
 * Pin/unpin, rename, move to folder.
 * TODO(wire): replace with api.instances.update(id, patch: Partial<Pick<InstanceSummary, 'name' | 'pinned' | 'folderId'>>).
 */
export function useUpdateInstance() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<InstanceSummary, 'name' | 'pinned' | 'folderId'>> }) => {
      patchInstance(id, patch)
    },
  })
}

/**
 * Folder expanded state and renames.
 * TODO(wire): replace with api.instances.updateFolder(id, patch: Partial<InstanceFolder>).
 */
export function useUpdateFolder() {
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<InstanceFolder> }) => {
      queryClient.setQueryData<InstanceFolder[]>(instanceKeys.folders, (list) => list?.map((f) => (f.id === id ? { ...f, ...patch } : f)))
    },
  })
}

/**
 * Launch, stop, force-stop, repair.
 * TODO(wire): replace with api.launch.start(id, { accountId?, worldId? }) / api.launch.stop(id, { force }) /
 * api.instances.repair(id). Progress arrives as `tasks:*` events and `InstanceSummary.state`.
 */
export const instanceActions = {
  launch(inst: Pick<InstanceSummary, 'id' | 'name'>) {
    patchInstance(inst.id, { state: { kind: 'launching' } })
    setTimeout(() => patchInstance(inst.id, { state: { kind: 'running', pid: 50_000, since: Date.now() } }), 1200)
  },
  stop(inst: Pick<InstanceSummary, 'id' | 'name'>, force = false) {
    patchInstance(inst.id, { state: { kind: 'idle' } })
    toast({ kind: 'info', title: force ? `Force quit “${inst.name}”` : `Stopped “${inst.name}”` })
  },
  cancel(inst: Pick<InstanceSummary, 'id' | 'name'>) {
    patchInstance(inst.id, { state: { kind: 'idle' } })
  },
  repair(inst: Pick<InstanceSummary, 'id' | 'name'>) {
    toast({ kind: 'info', title: `Verifying files for “${inst.name}”`, message: 'Progress is shown in Activity.' })
  },
  revealInFinder(inst: Pick<InstanceSummary, 'id' | 'name'>) {
    // TODO(wire): api.shell.showItemInFolder(instancePath)
    void inst
  },
  trash(inst: Pick<InstanceSummary, 'id' | 'name'>) {
    // TODO(wire): api.instances.trash(id) — moves the folder to the macOS Trash.
    queryClient.setQueryData<InstanceSummary[]>(instanceKeys.list, (list) => list?.filter((i) => i.id !== inst.id))
    toast({ kind: 'success', title: `Moved “${inst.name}” to the Trash`, actions: [{ label: 'Undo', onClick: () => queryClient.invalidateQueries({ queryKey: instanceKeys.list }) }] })
  },
  duplicate(inst: Pick<InstanceSummary, 'id' | 'name'>, name: string) {
    // TODO(wire): api.instances.duplicate(id, { name, includeWorlds, includeLogs }) → InstanceSummary
    queryClient.setQueryData<InstanceSummary[]>(instanceKeys.list, (list) => {
      const src = list?.find((i) => i.id === inst.id)
      if (!list || !src) return list
      return [...list, { ...src, id: `${src.id}-copy-${list.length}`, name, pinned: false, state: { kind: 'idle' }, lastPlayedAt: undefined, playTimeMs: 0 }]
    })
    toast({ kind: 'success', title: `Duplicated as “${name}”` })
  },
}

export const useInstanceActions = () => instanceActions

/** Loader display name, e.g. `NeoForge`. */
export function loaderName(kind: InstanceSummary['loader']['kind']): string {
  return { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[kind]
}

/** "1.21.1 · Fabric" */
export function versionLabel(inst: Pick<InstanceSummary, 'minecraft' | 'loader'>): string {
  return inst.loader.kind === 'vanilla' ? inst.minecraft : `${inst.minecraft} · ${loaderName(inst.loader.kind)}`
}
