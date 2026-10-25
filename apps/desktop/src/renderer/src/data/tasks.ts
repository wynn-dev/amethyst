import { useMemo } from 'react'
import { create } from 'zustand'
import type { TaskView } from '@shared/services'
import type { Events } from '@shared/events'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { toast } from '@/ui/toast-store'
import type { TaskSnapshot, TaskState } from './types'

/*
 * Task trees, kept in a small store that `tasks:update` batches patch in place (at most 10 per
 * second). Components select only what they draw: a sidebar row subscribes to its own install
 * fraction, the toolbar ring to the aggregate, so one progress tick never re-renders a list.
 */

interface TasksStore {
  /** Newest first (start order reversed), as `tasks.list()` returns them. */
  order: string[]
  byId: Record<string, TaskView>
}

export const useTaskStore = create<TasksStore>()(() => ({ order: [], byId: {} }))

/** Toasts for tasks that finish while the user is elsewhere. Set by the shell. */
let onFinished: ((task: TaskView) => void) | undefined
export function setTaskFinishedHandler(fn: (task: TaskView) => void): void {
  onFinished = fn
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled'])

export function applyTaskUpdate({ tasks, removed }: Events['tasks:update']): void {
  const { order, byId } = useTaskStore.getState()
  const nextById = { ...byId }
  let nextOrder = order
  for (const id of removed) {
    delete nextById[id]
  }
  if (removed.length) nextOrder = nextOrder.filter((id) => !removed.includes(id))
  const added: string[] = []
  for (const t of tasks) {
    const prev = byId[t.id]
    if (!prev) added.push(t.id)
    else if (!FINISHED.has(prev.state) && FINISHED.has(t.state)) onFinished?.(t)
    nextById[t.id] = t
  }
  if (added.length) nextOrder = [...added.toReversed(), ...nextOrder]
  useTaskStore.setState({ order: nextOrder, byId: nextById })
}

export async function reloadTasks(): Promise<void> {
  try {
    const list = await api.tasks.list()
    useTaskStore.setState({ order: list.map((t) => t.id), byId: Object.fromEntries(list.map((t) => [t.id, t])) })
  } catch {
    // The runtime is (re)starting; `runtime:restarted` triggers another reload.
  }
}

/* ------------------------------------------------------------------------------------------ */
/* View mapping                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const STEP_LABELS: Record<string, string> = {
  'version-json': 'Version metadata',
  client: 'Game jar',
  jar: 'Game jar',
  libraries: 'Libraries',
  'loader-libraries': 'Loader libraries',
  assets: 'Assets',
  natives: 'Native libraries',
  loader: 'Mod loader',
  forge: 'Forge',
  installer: 'Loader installer',
  processors: 'Running loader processors',
  profile: 'Loader profile',
  download: 'Downloading',
  'download-raw': 'Downloading',
  decompress: 'Unpacking',
  extract: 'Extracting',
  unpack: 'Unpacking',
  verify: 'Verifying files',
  diagnose: 'Checking files',
  merge: 'Merging',
  layout: 'Preparing folders',
  record: 'Finishing',
  replace: 'Replacing files',
}

const LOADER_NAMES: Record<string, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }

function str(v: string | number | undefined): string {
  return v === undefined ? '' : String(v)
}

/** Human title for a task, from its machine name and parameters. */
export function taskTitle(t: Pick<TaskView, 'name' | 'params'>): string {
  const p = t.params
  const name = str(p.name)
  switch (t.name) {
    case 'install.run': {
      const what = p.loader ? `${LOADER_NAMES[str(p.loader)] ?? str(p.loader)} ${str(p.loaderVersion)}`.trim() : `Minecraft ${str(p.minecraft)}`
      return name ? `Installing ${what} for “${name}”` : `Installing ${what}`
    }
    case 'install.repair':
      return `Repairing “${name}”`
    case 'launch.repair':
      return `Repairing ${str(p.files)} files for “${name}”`
    case 'java.install':
      return `Installing Java ${str(p.major)}`
    case 'instances.duplicate':
      return `Duplicating “${str(p.from)}”`
    case 'instances.import':
      return `Importing “${name}”`
    case 'modpack.import':
      return name ? `Importing modpack “${name}”` : 'Importing modpack'
    case 'modpack.update':
      return `Updating “${name}” to ${str(p.version)}`
    case 'modpack.plan-update':
      return `Checking “${name}” for changes`
    case 'modpack.rollback':
      return `Restoring “${name}”`
    case 'modpack.export':
      return `Exporting “${name}”`
    case 'modpack.manual':
      return `Adding ${str(p.files)} downloaded files`
    case 'market.install':
      return `Installing ${str(p.title)} ${str(p.version)}`.trim()
    case 'resources.add':
      return `Adding ${str(p.count)} files`
    case 'resources.backup':
      return `Backing up “${str(p.world)}”`
    case 'resources.restore':
      return `Restoring “${str(p.world)}”`
    default:
      return t.name
  }
}

function kindOf(name: string): TaskSnapshot['kind'] {
  if (name.startsWith('install.repair') || name === 'launch.repair') return 'verify'
  if (name.startsWith('install.')) return 'install'
  if (name.startsWith('java.')) return 'java'
  if (name.startsWith('modpack.export')) return 'export'
  if (name.startsWith('modpack.')) return 'modpack'
  if (name.startsWith('market.')) return 'download'
  if (name.startsWith('instances.')) return 'copy'
  if (name === 'resources.backup' || name === 'resources.restore') return 'backup'
  return 'download'
}

const BYTE_TASKS = new Set(['install.run', 'install.repair', 'launch.repair', 'java.install', 'market.install', 'modpack.import'])

function stepLabel(child: TaskView): string {
  return STEP_LABELS[child.name] ?? child.message ?? child.name
}

function mapState(s: TaskView['state']): TaskState {
  return s === 'pending' ? 'queued' : s
}

export function toTaskSnapshot(t: TaskView): TaskSnapshot {
  const running = t.children.find((c) => c.state === 'running')
  const bytes = BYTE_TASKS.has(t.name) && t.total > 0
  return {
    id: t.id,
    name: t.name,
    title: taskTitle(t),
    subtitle: t.message ?? (running ? stepLabel(running) : undefined),
    kind: kindOf(t.name),
    state: mapState(t.state),
    progress: t.state === 'running' && t.fraction <= 0 && !running ? undefined : t.fraction,
    ...(bytes ? { bytesDone: t.progress, bytesTotal: t.total } : {}),
    ...(t.startedAt && t.state === 'running' && t.fraction > 0.02 ? { etaMs: ((Date.now() - t.startedAt) / t.fraction) * (1 - t.fraction) } : {}),
    startedAt: t.startedAt ?? Date.now(),
    ...(t.endedAt ? { finishedAt: t.endedAt } : {}),
    ...(t.error ? { error: { message: t.error.message, details: `${t.error.code}: ${t.error.message}`, code: t.error.code } } : {}),
    children: t.children.map((c) => ({ id: c.id, title: stepLabel(c), state: mapState(c.state), progress: c.fraction })),
    ...(t.instanceId ? { instanceId: t.instanceId } : {}),
    cancellable: t.cancellable,
  }
}

/** Every task, newest first, as view models (re-renders on every batch: use in the popover only). */
export function useTasks(): { data: TaskSnapshot[] } {
  const order = useTaskStore((s) => s.order)
  const byId = useTaskStore((s) => s.byId)
  const data = useMemo(() => order.flatMap((id) => (byId[id] ? [toTaskSnapshot(byId[id])] : [])), [order, byId])
  return { data }
}

/** Aggregate for the toolbar ring: running count, mean fraction (2-decimal steps), failures. */
export function useTaskSummary(): { running: number; fraction: number | undefined; failed: number } {
  const running = useTaskStore((s) => s.order.filter((id) => s.byId[id]?.state === 'running').length)
  const fraction = useTaskStore((s) => {
    const r = s.order.map((id) => s.byId[id]).filter((t): t is TaskView => t?.state === 'running')
    if (!r.length) return undefined
    return Math.round((r.reduce((a, t) => a + t.fraction, 0) / r.length) * 100) / 100
  })
  const failed = useTaskStore((s) => s.order.filter((id) => s.byId[id]?.state === 'failed').length)
  return { running, fraction, failed }
}

/** The running install (or repair) of an instance: its fraction in 1 % steps, or `undefined`. */
export function useInstanceTask(instanceId: string | undefined): number | undefined {
  return useTaskStore((s) => {
    if (!instanceId) return undefined
    for (const id of s.order) {
      const t = s.byId[id]
      if (t && t.instanceId === instanceId && t.state === 'running' && (t.name === 'install.run' || t.name === 'install.repair' || t.name === 'launch.repair' || t.name === 'modpack.import')) {
        return Math.floor(t.fraction * 100) / 100
      }
    }
    return undefined
  })
}

/** The newest running task that matches (e.g. `market.install` of one project), for inline progress. */
export function useRunningTask(match: (t: TaskView) => boolean): TaskView | undefined {
  return useTaskStore((s) => {
    for (const id of s.order) {
      const t = s.byId[id]
      if (t && (t.state === 'running' || t.state === 'pending') && match(t)) return t
    }
    return undefined
  })
}

export const taskActions = {
  cancel: (id: string) => api.tasks.cancel(id).catch((e: unknown) => toastError(e, 'Couldn’t cancel the task')),
  dismiss: (id: string) => api.tasks.dismiss(id).catch((e: unknown) => toastError(e, 'Couldn’t remove the task')),
  clearFinished: () =>
    api.tasks.clearFinished().then(
      () => toast({ kind: 'success', title: 'Cleared finished activity' }),
      (e: unknown) => toastError(e, 'Couldn’t clear activity'),
    ),
}

/** Dock progress (main window only): the aggregate fraction, sent only when it moves by ≥ 1 %. */
export function installDockProgress(): () => void {
  let last: number | null | undefined
  let lastBadge = ''
  return useTaskStore.subscribe((s) => {
    const running = s.order.map((id) => s.byId[id]).filter((t): t is TaskView => t?.state === 'running')
    const fraction = running.length ? Math.floor((running.reduce((a, t) => a + t.fraction, 0) / running.length) * 100) / 100 : null
    if (fraction !== last) {
      last = fraction
      void api.window.setDockProgress(fraction).catch(() => {})
    }
    const failed = s.order.filter((id) => s.byId[id]?.state === 'failed').length
    const badge = failed ? String(failed) : ''
    if (badge !== lastBadge) {
      lastBadge = badge
      void api.window.setDockBadge(badge).catch(() => {})
    }
  })
}
