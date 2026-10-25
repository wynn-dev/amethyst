import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/rpc'
import { useRuntimeInstances } from './instances'
import type { HomeUpdate } from './types'

/** Instances checked for mod updates on Home (the most recently played modded ones). */
const MAX_CHECKED = 4
/** Home's update check never competes with first paint or a launch click. */
const DEFER_MS = 4_000

/**
 * "Updates Available" on Home: mod updates of the recently played modded instances. Deferred,
 * bounded, and served from the marketplace's 10-minute cache; failures just hide the row.
 */
export function useHomeUpdates() {
  const { data: instances } = useRuntimeInstances()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), DEFER_MS)
    return () => clearTimeout(t)
  }, [])
  const targets = (instances ?? [])
    .filter((i) => i.state === 'ok' && i.loader && i.lastPlayedAt > 0)
    .toSorted((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, MAX_CHECKED)
    .map((i) => ({ id: i.id, name: i.name }))
  return useQuery({
    queryKey: ['home', 'updates', targets.map((t) => t.id)],
    enabled: ready && targets.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<HomeUpdate[]> => {
      const out: HomeUpdate[] = []
      for (const t of targets) {
        // oxlint-disable-next-line no-await-in-loop -- one instance at a time keeps the API polite
        const updates = await api.marketplace.checkUpdates(t.id, 'mods', { releaseOnly: true }).catch(() => [])
        if (updates.length) out.push({ id: t.id, instanceId: t.id, tab: 'mods', text: `“${t.name}” has ${updates.length} mod ${updates.length === 1 ? 'update' : 'updates'}` })
      }
      return out
    },
  })
}
