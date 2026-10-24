import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/rpc'
import { fixture } from './query'
import {
  fixtureAccounts,
  fixtureCrashText,
  fixtureGameVersions,
  fixtureHomeUpdates,
  fixtureJava,
  fixtureLogFiles,
  fixtureLogLines,
  fixtureTasks,
} from './fixtures'
import type { CrashSummary, LoaderKind, LoaderVersion } from './types'

/**
 * Log and crash files for an instance, newest first. "Live" is present only while running.
 * TODO(wire): replace with api.logs.list(instanceId) → LogFile[].
 */
export function useLogFiles(instanceId: string) {
  return useQuery({
    queryKey: ['logs', instanceId],
    queryFn: () => fixture(() => fixtureLogFiles(instanceId), () => []),
  })
}

/**
 * Parsed lines of a log file. For `live`, the runtime should push batched `logs:lines` events
 * (bounded ring buffer) instead of returning the whole file.
 * TODO(wire): replace with api.logs.read(instanceId, fileId) → LogLine[] and subscribe('logs:lines').
 */
export function useLogLines(instanceId: string, fileId: string | undefined) {
  return useQuery({
    queryKey: ['logs', instanceId, fileId],
    enabled: !!fileId,
    queryFn: () => fixture(() => fixtureLogLines(fileId ?? ''), () => []),
  })
}

/**
 * Raw crash report text plus the runtime's heuristic summary.
 * TODO(wire): replace with api.logs.readCrash(instanceId, fileId) → { text: string; summary: CrashSummary }.
 */
export function useCrashReport(instanceId: string, fileId: string | undefined) {
  return useQuery({
    queryKey: ['crash', instanceId, fileId],
    enabled: !!fileId,
    queryFn: () =>
      fixture<{ text: string; summary: CrashSummary }>(
        () => ({
          text: fixtureCrashText,
          summary: { exitCode: 1, headline: 'Mod “Waystones” failed to load: Architectury API is missing', suspects: [{ modId: 'waystones', name: 'Waystones' }] },
        }),
        () => ({ text: '', summary: { exitCode: 1, headline: '', suspects: [] } }),
      ),
  })
}

/**
 * Accounts, with the active one flagged.
 * TODO(wire): replace with api.accounts.list() → Account[]; invalidate on `accounts:changed`.
 */
export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: () => fixture(() => structuredClone(fixtureAccounts), () => []) })
}

/**
 * Task tree snapshots for Activity.
 * TODO(wire): replace with api.tasks.list() → TaskSnapshot[] plus throttled `tasks:update` push events
 * (4–10/s per tree). Also needs api.tasks.pause/resume/cancel/retry(id) and api.tasks.clearFinished().
 */
export function useTasks() {
  return useQuery({ queryKey: ['tasks'], queryFn: () => fixture(() => structuredClone(fixtureTasks), () => []) })
}

/**
 * "Updates available" rows on Home.
 * TODO(wire): replace with api.updates.summary() → HomeUpdate[] (mod and modpack updates across instances).
 */
export function useHomeUpdates() {
  return useQuery({ queryKey: ['home', 'updates'], queryFn: () => fixture(() => fixtureHomeUpdates, () => []) })
}

/**
 * Detected and managed Java runtimes.
 * TODO(wire): replace with api.java.list() → JavaRuntime[]; api.java.refresh(); api.java.download(major).
 */
export function useJavaRuntimes() {
  return useQuery({ queryKey: ['java'], queryFn: () => fixture(() => fixtureJava, () => []) })
}

/**
 * Minecraft versions from the Mojang manifest.
 * TODO(wire): replace with api.versions.listMinecraft() → GameVersion[].
 */
export function useGameVersions() {
  return useQuery({ queryKey: ['versions', 'minecraft'], queryFn: () => fixture(() => fixtureGameVersions, () => []) })
}

/**
 * Loader versions for a Minecraft version. Empty when the loader doesn't support it.
 * TODO(wire): replace with api.versions.listLoader(kind, minecraft) → LoaderVersion[].
 */
export function useLoaderVersions(kind: LoaderKind, minecraft: string | undefined) {
  return useQuery({
    queryKey: ['versions', kind, minecraft],
    enabled: kind !== 'vanilla' && !!minecraft,
    queryFn: () =>
      fixture<LoaderVersion[]>(
        () => {
          const old = !minecraft || !/^1\.(1[4-9]|2\d)/.test(minecraft)
          if ((kind === 'fabric' || kind === 'quilt') && old) return []
          if (kind === 'neoforge' && !/^1\.(20\.[2-9]|21)/.test(minecraft ?? '')) return []
          const base = { fabric: '0.16.', quilt: '0.26.', forge: '47.3.', neoforge: '21.1.' }[kind as Exclude<LoaderKind, 'vanilla'>]
          return Array.from({ length: 14 }, (_, i) => ({ version: `${base}${14 - i}`, latest: i === 0, recommended: i === 1 }))
        },
        () => [],
      ),
  })
}

/** The launcher's own version info. Already wired: MainServices.app exists today. */
export function useAppInfo() {
  return useQuery({ queryKey: ['app', 'info'], queryFn: () => api.app.getInfo() })
}
