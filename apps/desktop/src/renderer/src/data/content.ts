import { useMutation, useQuery } from '@tanstack/react-query'
import { fixture, queryClient } from './query'
import { fixtureMods, fixtureResourcePacks, fixtureShaders, fixtureWorlds } from './fixtures'
import type { ModFile, ResourcePack, ShaderPack, World } from './types'
import { toast } from '@/ui/toast-store'

export const contentKeys = {
  mods: (id: string) => ['content', id, 'mods'] as const,
  resourcePacks: (id: string) => ['content', id, 'resourcepacks'] as const,
  shaders: (id: string) => ['content', id, 'shaders'] as const,
  worlds: (id: string) => ['content', id, 'worlds'] as const,
}

/**
 * Installed mods of an instance (can be hundreds of rows; the table virtualises).
 * TODO(wire): replace with api.resources.listMods(instanceId) → ModFile[]; invalidate on `resources:changed`.
 * Problems (duplicate / missing dependency / incompatible) should arrive precomputed from the runtime.
 */
export function useMods(instanceId: string) {
  return useQuery({
    queryKey: contentKeys.mods(instanceId),
    queryFn: () => fixture(() => structuredClone(fixtureMods(instanceId)), () => []),
  })
}

/**
 * Enable/disable mods in bulk.
 * TODO(wire): replace with api.resources.setEnabled(instanceId, fileIds: string[], enabled: boolean).
 */
export function useSetModsEnabled(instanceId: string) {
  return useMutation({
    mutationFn: async ({ ids, enabled }: { ids: string[]; enabled: boolean }) => {
      const set = new Set(ids)
      queryClient.setQueryData<ModFile[]>(contentKeys.mods(instanceId), (list) => list?.map((m) => (set.has(m.id) ? { ...m, enabled } : m)))
    },
  })
}

/**
 * Move mods to the macOS Trash, with Undo.
 * TODO(wire): replace with api.resources.trash(instanceId, fileIds) and api.resources.restore(instanceId, trashIds).
 */
export function useTrashMods(instanceId: string) {
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const key = contentKeys.mods(instanceId)
      const before = queryClient.getQueryData<ModFile[]>(key)
      const set = new Set(ids)
      queryClient.setQueryData<ModFile[]>(key, (list) => list?.filter((m) => !set.has(m.id)))
      toast({
        kind: 'success',
        title: ids.length === 1 ? 'Moved 1 mod to the Trash' : `Moved ${ids.length} mods to the Trash`,
        actions: [{ label: 'Undo', onClick: () => queryClient.setQueryData(key, before) }],
      })
    },
  })
}

/**
 * Resource packs; enabled ones carry their load-order position.
 * TODO(wire): replace with api.resources.listResourcePacks(instanceId) → ResourcePack[].
 */
export function useResourcePacks(instanceId: string) {
  return useQuery({
    queryKey: contentKeys.resourcePacks(instanceId),
    queryFn: () => fixture(() => structuredClone(fixtureResourcePacks(instanceId)), () => []),
  })
}

/**
 * Set which packs are enabled and their order (top = highest priority).
 * TODO(wire): replace with api.resources.setResourcePackOrder(instanceId, enabledIdsInOrder: string[]).
 */
export function useSetResourcePackOrder(instanceId: string) {
  return useMutation({
    mutationFn: async (enabledInOrder: string[]) => {
      const pos = new Map(enabledInOrder.map((id, i) => [id, i]))
      queryClient.setQueryData<ResourcePack[]>(contentKeys.resourcePacks(instanceId), (list) =>
        list?.map((p) => ({ ...p, enabled: pos.has(p.id), order: pos.get(p.id) })),
      )
    },
  })
}

/**
 * Shader packs; at most one is active.
 * TODO(wire): replace with api.resources.listShaders(instanceId) → ShaderPack[].
 */
export function useShaders(instanceId: string) {
  return useQuery({
    queryKey: contentKeys.shaders(instanceId),
    queryFn: () => fixture(() => structuredClone(fixtureShaders(instanceId)), () => []),
  })
}

/**
 * Activate a shader pack (`null` = none).
 * TODO(wire): replace with api.resources.setActiveShader(instanceId, id | null).
 */
export function useSetActiveShader(instanceId: string) {
  return useMutation({
    mutationFn: async (id: string | null) => {
      queryClient.setQueryData<ShaderPack[]>(contentKeys.shaders(instanceId), (list) => list?.map((s) => ({ ...s, active: s.id === id })))
    },
  })
}

/**
 * Worlds (saves) with their datapacks.
 * TODO(wire): replace with api.saves.list(instanceId) → World[]; api.saves.backup(instanceId, worldId) for "Back Up".
 */
export function useWorlds(instanceId: string) {
  return useQuery({
    queryKey: contentKeys.worlds(instanceId),
    queryFn: () => fixture<World[]>(() => structuredClone(fixtureWorlds(instanceId)), () => []),
  })
}
