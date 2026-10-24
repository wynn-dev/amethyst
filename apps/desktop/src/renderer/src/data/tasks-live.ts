import { create } from 'zustand'
import type { TaskView } from '@shared/services'
import { subscribe } from '@/lib/rpc'

/**
 * Live task snapshots from `tasks:update` (pushed, throttled; never polled), for inline progress
 * on Install buttons and sheets. Bounded: finished tasks beyond the newest 40 are dropped.
 */
const MAX_FINISHED = 40

interface TasksLive {
  tasks: Record<string, TaskView>
}

export const useTasksLive = create<TasksLive>(() => ({ tasks: {} }))

let installed = false
export function installTaskEvents(): void {
  if (installed) return
  installed = true
  subscribe('tasks:update', ({ tasks, removed }) => {
    const next = { ...useTasksLive.getState().tasks }
    for (const t of tasks) next[t.id] = t
    for (const id of removed) delete next[id]
    const finished = Object.values(next).filter((t) => t.state !== 'running' && t.state !== 'pending')
    if (finished.length > MAX_FINISHED) {
      for (const t of finished.toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, finished.length - MAX_FINISHED)) delete next[t.id]
    }
    useTasksLive.setState({ tasks: next })
  })
}
installTaskEvents()

/** The newest running task that matches, e.g. `market.install` for one instance. */
export function useRunningTask(match: (t: TaskView) => boolean): TaskView | undefined {
  return useTasksLive((s) => {
    let best: TaskView | undefined
    for (const t of Object.values(s.tasks)) {
      if ((t.state === 'running' || t.state === 'pending') && match(t) && (!best || (t.startedAt ?? 0) > (best.startedAt ?? 0))) best = t
    }
    return best
  })
}
