import { useQuery } from '@tanstack/react-query'
import type { JavaRow } from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'
import type { JavaRuntime } from './types'

export const javaKeys = {
  all: ['java'] as const,
  list: ['java', 'list'] as const,
  scanning: ['java', 'scanning'] as const,
  recommendAll: ['java', 'recommend'] as const,
  recommend: (instanceId: string) => ['java', 'recommend', instanceId] as const,
}

export function toJavaRuntime(r: JavaRow): JavaRuntime {
  return {
    id: r.path,
    path: r.path,
    home: r.javaHome,
    version: r.version || 'Unknown',
    major: r.majorVersion,
    vendor: r.vendor ?? 'Unknown vendor',
    arch: r.arch === 'x64' ? 'x86_64' : r.arch,
    source: r.managed ? 'managed' : r.userAdded ? 'added' : 'system',
    valid: r.valid,
    ...(r.invalidReason ? { invalidReason: r.invalidReason } : {}),
  }
}

/** Every Java Amethyst knows about (from the probe cache; never spawns a JVM). */
export function useJavaRuntimes() {
  return useQuery({
    queryKey: javaKeys.list,
    queryFn: async () => (await api.java.list()).map(toJavaRuntime).toSorted((a, b) => b.major - a.major || a.path.localeCompare(b.path)),
  })
}

/** True while a Java scan runs (from `java:changed`). */
export function useJavaScanning(): boolean {
  return useQuery({ queryKey: javaKeys.scanning, queryFn: () => false, staleTime: Infinity }).data ?? false
}

/** Which Java the instance would launch with right now, and why. */
export function useJavaRecommendation(instanceId: string) {
  return useQuery({ queryKey: javaKeys.recommend(instanceId), queryFn: () => api.java.recommend(instanceId), enabled: !!instanceId })
}

export const javaActions = {
  async install(major: number) {
    toast({ kind: 'info', title: `Downloading Java ${major}`, message: 'Progress is shown in Activity.' })
    try {
      const row = await api.java.installRuntime(major)
      toast({ kind: 'success', title: `Java ${row.version || major} is ready` })
    } catch (e) {
      toastError(e, `Couldn’t install Java ${major}`)
    }
  },
  async rescan() {
    try {
      const rows = await api.java.rescan()
      queryClient.setQueryData(javaKeys.list, rows.map(toJavaRuntime))
      toast({ kind: 'success', title: rows.length === 1 ? 'Found 1 Java runtime' : `Found ${rows.length} Java runtimes` })
    } catch (e) {
      toastError(e, 'Couldn’t scan for Java')
    }
  },
  /** Pick a `java` binary, JDK home or `.jdk` bundle and add it. Resolves with its path, or `undefined`. */
  async addFromDisk(): Promise<string | undefined> {
    const [picked] = await api.dialog.open({ title: 'Choose a Java runtime (a JDK folder or its bin/java)', directory: true, treatPackagesAsDirectories: true })
    if (!picked) return undefined
    try {
      const row = await api.java.addPath(picked)
      void queryClient.invalidateQueries({ queryKey: javaKeys.all })
      toast({ kind: 'success', title: `Added Java ${row.version}` })
      return row.path
    } catch (e) {
      toastError(e, 'Couldn’t add that Java')
      return undefined
    }
  },
  async remove(r: Pick<JavaRuntime, 'path' | 'version' | 'source'>) {
    try {
      await api.java.removePath(r.path)
      void queryClient.invalidateQueries({ queryKey: javaKeys.all })
      toast({ kind: 'success', title: r.source === 'added' ? `Removed Java ${r.version}` : `Hid Java ${r.version}` })
    } catch (e) {
      toastError(e, `Couldn’t remove Java ${r.version}`)
    }
  },
}
