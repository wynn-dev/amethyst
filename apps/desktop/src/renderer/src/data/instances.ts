import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  CreateInstanceInput,
  InstanceDetail as RuntimeDetail,
  InstancePatch,
  InstanceRuntime,
  InstanceSummary as RuntimeSummary,
  LaunchOptions,
  LibraryLayout,
} from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'
import { launchInstance, stopInstance, useLaunchStore, type LaunchEntry } from './launch'
import type { InstanceDetail, InstanceFolder, InstanceState, InstanceSummary, LoaderKind } from './types'

export const instanceKeys = {
  list: ['instances'] as const,
  detail: (id: string) => ['instances', id] as const,
}
export const libraryKey = ['library'] as const

/* ------------------------------------------------------------------------------------------ */
/* Mapping (runtime → view model), in one place                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Stable hue for the generated block icon. */
export function hueFor(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  return h % 360
}

function stateOf(r: RuntimeSummary, launch: LaunchEntry | undefined): InstanceState {
  if (r.state === 'missing') return { kind: 'problem', message: 'The folder isn’t reachable (an unmounted drive?)' }
  if (r.state === 'broken') return { kind: 'problem', message: 'This instance’s settings file is damaged' }
  if (r.activity === 'running' || launch?.phase === 'running') return { kind: 'running', pid: launch?.pid ?? 0, since: launch?.startedAt || Date.now(), ready: launch?.ready ?? false }
  if (r.activity === 'installing') return { kind: 'installing' }
  if (r.activity === 'launching' || launch?.phase === 'preparing') return { kind: 'launching', ...(launch?.step ? { step: launch.step } : {}) }
  return { kind: 'idle' }
}

function toSummary(r: RuntimeSummary, layout: LibraryLayout | undefined, launch: LaunchEntry | undefined): InstanceSummary {
  const folderId = layout?.folderOf[r.id]
  return {
    id: r.id,
    name: r.name,
    ...(r.iconUrl ? { iconUrl: r.iconUrl } : {}),
    iconHue: hueFor(r.id),
    minecraft: r.minecraft,
    loader: r.loader ? { kind: r.loader.kind, version: r.loader.version } : { kind: 'vanilla' },
    ...(folderId ? { folderId } : {}),
    pinned: layout?.pinned.includes(r.id) ?? false,
    state: stateOf(r, launch),
    ...(r.lastPlayedAt ? { lastPlayedAt: r.lastPlayedAt } : {}),
    playTimeMs: r.playTimeMs,
    createdAt: r.createdAt,
    external: r.external,
  }
}

function toDetail(r: RuntimeDetail, layout: LibraryLayout | undefined, launch: LaunchEntry | undefined): InstanceDetail {
  const upstream = r.upstream
  return {
    ...toSummary(r, layout, launch),
    path: r.path,
    notes: r.description,
    author: r.author,
    homepageUrl: r.homepageUrl,
    runtime: r.runtime,
    versionId: r.versionId,
    overrides: r.overrides,
    ...(upstream
      ? {
          upstream: {
            source: upstream.kind,
            projectId: String(upstream.projectId),
            projectName: String(upstream.projectId),
            version: String(upstream.kind === 'modrinth' ? upstream.versionId : upstream.fileId),
          },
        }
      : {}),
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Queries                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const listQuery = { queryKey: instanceKeys.list, queryFn: () => api.instances.list() }
const layoutQuery = { queryKey: libraryKey, queryFn: () => api.instances.getLayout() }

/** Runtime instance rows (unsorted, as the service returns them). */
export function useRuntimeInstances() {
  return useQuery(listQuery)
}

export function useLibraryLayout() {
  return useQuery(layoutQuery)
}

/**
 * Every instance as view models, sorted by name for the sidebar. Merges the sidebar layout (pins,
 * folders) and the live launch state; install progress is read per row with `useInstanceTask`.
 */
export function useInstances() {
  const list = useQuery(listQuery)
  const layout = useQuery(layoutQuery)
  const launches = useLaunchStore((s) => s.byInstance)
  const data = useMemo(
    () => list.data?.map((r) => toSummary(r, layout.data, launches[r.id])).toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [list.data, layout.data, launches],
  )
  return { data, isPending: list.isPending, isError: list.isError, error: list.error, refetch: list.refetch }
}

/** A cached instance as a view model (for commands outside React). */
export function getInstanceSummary(id: string): InstanceSummary | undefined {
  const r = queryClient.getQueryData<RuntimeSummary[]>(instanceKeys.list)?.find((i) => i.id === id)
  return r ? toSummary(r, queryClient.getQueryData<LibraryLayout>(libraryKey), useLaunchStore.getState().byInstance[id]) : undefined
}

/** Sidebar folders, in order, with their persisted expanded state. */
export function useInstanceFolders() {
  const layout = useQuery(layoutQuery)
  return { ...layout, data: layout.data?.folders as InstanceFolder[] | undefined }
}

/** One instance in full. `data` is `null` when it doesn't exist. */
export function useInstance(id: string) {
  const q = useQuery({
    queryKey: instanceKeys.detail(id),
    enabled: !!id,
    queryFn: async () => {
      try {
        return await api.instances.get(id)
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOT_FOUND') return null
        throw e
      }
    },
  })
  const layout = useQuery(layoutQuery)
  const launch = useLaunchStore((s) => s.byInstance[id])
  const data = useMemo(() => (q.data === undefined ? undefined : q.data === null ? null : toDetail(q.data, layout.data, launch)), [q.data, layout.data, launch])
  return { data, isPending: q.isPending, isError: q.isError, error: q.error, refetch: q.refetch }
}

/** Whether the instance's game version is installed (Play vs Install), from `install.status`. */
export function useInstallStatus(id: string) {
  return useQuery({ queryKey: ['install-status', id], queryFn: () => api.install.status(id), enabled: !!id })
}

/* ------------------------------------------------------------------------------------------ */
/* Mutations                                                                                    */
/* ------------------------------------------------------------------------------------------ */

type Target = Pick<InstanceSummary, 'id' | 'name'>

function setLayout(layout: LibraryLayout) {
  queryClient.setQueryData(libraryKey, layout)
}

async function detailOf(id: string): Promise<RuntimeDetail> {
  return queryClient.fetchQuery({ queryKey: instanceKeys.detail(id), queryFn: () => api.instances.get(id), staleTime: 2_000 }) as Promise<RuntimeDetail>
}

/** Create an instance, then install its game version as a task (progress in Activity). */
export async function createInstance(input: CreateInstanceInput): Promise<RuntimeDetail | undefined> {
  let created: RuntimeDetail
  try {
    created = await api.instances.create(input)
  } catch (e) {
    toastError(e, 'Couldn’t create the instance')
    return undefined
  }
  queryClient.setQueryData<RuntimeSummary[]>(instanceKeys.list, (l) => (l && !l.some((x) => x.id === created.id) ? [created, ...l] : l))
  void installInstance(created)
  return created
}

/** Install (or re-verify) an instance's game version; reports the outcome as a toast. */
export async function installInstance(inst: Target): Promise<boolean> {
  try {
    const out = await api.install.install(inst.id)
    toast({ kind: 'success', title: `“${inst.name}” is ready to play`, message: out.bytes > 0 ? `Installed ${out.versionId}.` : undefined })
    return true
  } catch (e) {
    toastError(e, `Couldn’t install “${inst.name}”`)
    return false
  }
}

/** Patch an instance; errors become a toast and the cache is refreshed. */
export async function updateInstance(id: string, patch: InstancePatch, what = 'the change'): Promise<boolean> {
  try {
    const next = await api.instances.update(id, patch)
    queryClient.setQueryData(instanceKeys.detail(id), next)
    return true
  } catch (e) {
    void queryClient.invalidateQueries({ queryKey: instanceKeys.detail(id) })
    toastError(e, `Couldn’t save ${what}`)
    return false
  }
}

export async function renameInstance(inst: Target, name: string): Promise<boolean> {
  const next = name.trim()
  if (!next || next === inst.name) return false
  try {
    const d = await api.instances.rename(inst.id, next)
    queryClient.setQueryData(instanceKeys.detail(inst.id), d)
    toast({ kind: 'success', title: `Renamed to “${d.name}”` })
    return true
  } catch (e) {
    toastError(e, `Couldn’t rename “${inst.name}”`)
    return false
  }
}

/** "Change Version…": backup, switch and install in one runtime call. */
export async function changeVersion(inst: Target, runtime: Partial<InstanceRuntime> & { minecraft: string }): Promise<void> {
  toast({ kind: 'info', title: `Changing “${inst.name}” to ${runtime.minecraft}`, message: 'Progress is shown in Activity.' })
  try {
    const out = await api.install.changeVersion(inst.id, runtime)
    toast({
      kind: 'success',
      title: `“${inst.name}” now runs ${out.versionId}`,
      ...(out.backedUpWorlds ? { message: `${out.backedUpWorlds} ${out.backedUpWorlds === 1 ? 'world was' : 'worlds were'} backed up first.` } : {}),
    })
  } catch (e) {
    toastError(e, `Couldn’t change the version of “${inst.name}”`)
  }
}

export async function chooseInstanceIcon(inst: Target): Promise<void> {
  const [path] = await api.dialog.open({ title: `Choose an icon for “${inst.name}”`, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
  if (!path) return
  try {
    const d = await api.instances.setIcon(inst.id, { path })
    queryClient.setQueryData(instanceKeys.detail(inst.id), d)
    toast({ kind: 'success', title: 'Icon changed' })
  } catch (e) {
    toastError(e, 'Couldn’t use that image')
  }
}

export const libraryActions = {
  async togglePin(inst: Pick<InstanceSummary, 'id' | 'name' | 'pinned'>) {
    try {
      setLayout(await api.instances.setPinned(inst.id, !inst.pinned))
    } catch (e) {
      toastError(e, `Couldn’t ${inst.pinned ? 'unpin' : 'pin'} “${inst.name}”`)
    }
  },
  async moveToFolder(inst: Target, folderId: string | null) {
    try {
      setLayout(await api.instances.moveToFolder(inst.id, folderId))
    } catch (e) {
      toastError(e, `Couldn’t move “${inst.name}”`)
    }
  },
  async setFolderExpanded(id: string, expanded: boolean) {
    queryClient.setQueryData<LibraryLayout>(libraryKey, (l) => (l ? { ...l, folders: l.folders.map((f) => (f.id === id ? { ...f, expanded } : f)) } : l))
    try {
      setLayout(await api.instances.updateFolder(id, { expanded }))
    } catch (e) {
      void queryClient.invalidateQueries({ queryKey: libraryKey })
      toastError(e, 'Couldn’t update the folder')
    }
  },
  async renameFolder(id: string, name: string) {
    try {
      setLayout(await api.instances.updateFolder(id, { name }))
    } catch (e) {
      toastError(e, 'Couldn’t rename the folder')
    }
  },
  async deleteFolder(id: string, name: string) {
    try {
      setLayout(await api.instances.deleteFolder(id))
      toast({ kind: 'success', title: `Removed the folder “${name}”`, message: 'Its instances are back at the top level.' })
    } catch (e) {
      toastError(e, 'Couldn’t remove the folder')
    }
  },
  /** Create a folder, optionally moving an instance into it. */
  async createFolder(name: string, move?: Target) {
    try {
      const folder = await api.instances.createFolder(name)
      if (move) setLayout(await api.instances.moveToFolder(move.id, folder.id))
      else void queryClient.invalidateQueries({ queryKey: libraryKey })
      toast({ kind: 'success', title: `Created the folder “${folder.name}”` })
    } catch (e) {
      toastError(e, 'Couldn’t create the folder')
    }
  },
}

/** Launch, stop, repair, reveal, duplicate and trash. Every action reports success or a mapped error. */
export const instanceActions = {
  launch(inst: Target, options?: LaunchOptions) {
    void launchInstance(inst, options)
  },
  stop(inst: Target, force = false) {
    void stopInstance(inst, force)
  },
  /** Cancel a launch that is still preparing. */
  cancel(inst: Target) {
    void stopInstance(inst)
  },
  async repair(inst: Target) {
    toast({ kind: 'info', title: `Verifying files for “${inst.name}”`, message: 'Progress is shown in Activity.' })
    try {
      const r = await api.install.repair(inst.id)
      const left = r.remaining.length
      toast({
        kind: left ? 'warning' : 'success',
        title: r.repaired ? `Repaired ${r.repaired} ${r.repaired === 1 ? 'file' : 'files'} in “${inst.name}”` : `All files of “${inst.name}” are intact`,
        ...(left ? { message: `${left} ${left === 1 ? 'problem' : 'problems'} couldn’t be fixed: ${r.remaining.slice(0, 2).map((x) => x.name).join(', ')}` } : {}),
      })
    } catch (e) {
      toastError(e, `Couldn’t repair “${inst.name}”`)
    }
  },
  async revealInFinder(inst: Target) {
    try {
      const d = await detailOf(inst.id)
      await api.shell.openFolder(d.path)
    } catch (e) {
      toastError(e, 'Couldn’t show the folder in Finder')
    }
  },
  async trash(inst: Target) {
    try {
      const r = await api.instances.delete(inst.id)
      queryClient.setQueryData<RuntimeSummary[]>(instanceKeys.list, (l) => l?.filter((i) => i.id !== inst.id))
      const rescued = r.rescuedWorlds.length
      toast({
        kind: 'success',
        title: r.trashed ? `Moved “${inst.name}” to the Trash` : `Removed “${inst.name}” from Amethyst`,
        message: rescued ? `${rescued} ${rescued === 1 ? 'world was' : 'worlds were'} kept in Rescued Worlds.` : r.trashed ? 'You can restore it from the Trash in Finder.' : 'Its files were left where they are.',
        ...(rescued
          ? {
              actions: [
                {
                  label: 'Show in Finder',
                  onClick: () => void api.shell.showItemInFolder(r.rescuedWorlds[0]!.path).catch((e: unknown) => toastError(e, 'Couldn’t show the folder')),
                },
              ],
            }
          : {}),
      })
    } catch (e) {
      toastError(e, `Couldn’t move “${inst.name}” to the Trash`)
    }
  },
  async duplicate(inst: Target, name: string, onDone?: (id: string) => void) {
    toast({ kind: 'info', title: `Duplicating “${inst.name}”…` })
    try {
      const d = await api.instances.duplicate(inst.id, name)
      toast({ kind: 'success', title: `Duplicated as “${d.name}”` })
      onDone?.(d.id)
    } catch (e) {
      toastError(e, `Couldn’t duplicate “${inst.name}”`)
    }
  },
}

export const useInstanceActions = () => instanceActions

/** Loader display name, e.g. `NeoForge`. */
export function loaderName(kind: LoaderKind): string {
  return { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[kind]
}

/** "1.21.1 · Fabric" */
export function versionLabel(inst: Pick<InstanceSummary, 'minecraft' | 'loader'>): string {
  if (!inst.minecraft) return 'Unknown version'
  return inst.loader.kind === 'vanilla' ? inst.minecraft : `${inst.minecraft} · ${loaderName(inst.loader.kind)}`
}
