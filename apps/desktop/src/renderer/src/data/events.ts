import type { QueryKey } from '@tanstack/react-query'
import { subscribe } from '@/lib/rpc'
import { queryClient } from './query'
import { settingsKey } from './settings'
import { instanceKeys, libraryKey } from './instances'
import { accountKeys, applyLoginEvent } from './accounts'
import { javaKeys } from './java'
import { versionKeys } from './versions'
import { updaterKey } from './updater'
import { applyTaskUpdate, reloadTasks } from './tasks'
import { applyLaunchState, reloadRunning } from './launch'

/*
 * Push events → cache updates, in one place (ARCHITECTURE.md IPC rules 1–3). Change events only
 * mark queries stale; invalidations are coalesced to at most one batch per animation frame.
 * High-frequency streams (`tasks:update`, `launch:state`, `launch:log`) are applied incrementally
 * to small stores instead, so nothing refetches and only the rows that changed re-render.
 */

const pending = new Map<string, { queryKey: QueryKey; exact: boolean }>()
let frame = 0

function flush() {
  frame = 0
  const batch = [...pending.values()]
  pending.clear()
  for (const { queryKey, exact } of batch) void queryClient.invalidateQueries({ queryKey, exact })
}

export function invalidateSoon(queryKey: QueryKey, exact = false): void {
  pending.set(`${exact ? '=' : '~'}${JSON.stringify(queryKey)}`, { queryKey, exact })
  // A hidden window has no frames; a timer keeps the batch bounded without a free-running loop.
  frame ||= document.hidden ? window.setTimeout(flush, 50) : requestAnimationFrame(flush)
}

let installed = false

/** Subscribe this window to every runtime and main-process event. Idempotent. */
export function installEventBridge(): void {
  if (installed) return
  installed = true

  subscribe('instances:changed', ({ added, updated, removed }) => {
    invalidateSoon(instanceKeys.list, true)
    for (const id of [...added, ...updated]) {
      invalidateSoon(instanceKeys.detail(id))
      invalidateSoon(['install-status', id])
      invalidateSoon(javaKeys.recommend(id))
    }
    for (const id of removed) queryClient.removeQueries({ queryKey: instanceKeys.detail(id) })
    if (removed.length) invalidateSoon(libraryKey)
  })
  subscribe('library:changed', () => invalidateSoon(libraryKey))
  subscribe('settings:changed', ({ keys }) => {
    invalidateSoon(settingsKey, true)
    if (keys.some((k) => k.startsWith('game.'))) invalidateSoon(javaKeys.recommendAll)
    // Offline accounts are allowed in developer mode.
    if (keys.includes('general.developerMode')) invalidateSoon(accountKeys.status)
  })
  subscribe('accounts:changed', () => invalidateSoon(accountKeys.all))
  subscribe('accounts:login', applyLoginEvent)
  subscribe('java:changed', ({ scanning }) => {
    queryClient.setQueryData(javaKeys.scanning, scanning)
    if (!scanning) invalidateSoon(javaKeys.all)
  })
  subscribe('versions:changed', ({ lists }) => {
    for (const list of lists) invalidateSoon(versionKeys.list(list))
    if (lists.includes('installed')) invalidateSoon(['install-status'])
  })
  subscribe('updater:state', (state) => queryClient.setQueryData(updaterKey, state))
  subscribe('tasks:update', applyTaskUpdate)
  subscribe('launch:state', applyLaunchState)
  subscribe('runtime:restarted', () => {
    // Everything the runtime held may have changed: refetch every active query and resync stores.
    void queryClient.invalidateQueries()
    void reloadTasks()
    void reloadRunning()
  })

  void reloadTasks()
  void reloadRunning()
}
