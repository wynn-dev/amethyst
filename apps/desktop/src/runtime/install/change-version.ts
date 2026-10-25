/**
 * "Change Version…" (ui.md B4.6) as one runtime call: back up the worlds (DECISIONS: an automatic
 * backup before version changes), switch the instance's runtime, then install it. Composed from
 * the instance, resource and install managers so the renderer never has to sequence the steps.
 */
import type { InstallOutcome, InstanceRuntime, LoaderKind } from '@shared/services'
import type { InstanceManager } from '../instances/service'
import { LOADERS } from '../instances/model'
import { AppError, invalid } from '../util/errors'
import { isRecord } from '../util/parse'
import type { InstallManager } from './service'

export interface ChangeVersionDeps {
  instances: Pick<InstanceManager, 'resolve' | 'update'>
  install: Pick<InstallManager, 'install' | 'isBusy'>
  /** True while the game runs or launches from the instance. */
  isRunning: (instanceId: string) => boolean
  /** Zips every world (honours `backups.automatic`; never throws for one bad world). Returns how many were saved. */
  backupWorlds: (instanceId: string) => Promise<number>
  /** True while a modpack import, update or rollback writes into the instance. */
  isModpackBusy?: (instanceId: string) => boolean
  /**
   * Instances whose version is being changed. Held from the busy check to the end, so a launch
   * (or a modpack update) cannot start during the slow world backup. Launch checks this set.
   */
  changing?: Set<string>
}

const defaultChanging = new Set<string>()

/** The full runtime the instance switches to: exactly the given loader, every other one cleared. */
export function targetRuntime(input: unknown): InstanceRuntime {
  if (!isRecord(input) || typeof input.minecraft !== 'string' || !input.minecraft.trim()) throw invalid('A Minecraft version is required')
  const out: InstanceRuntime = { minecraft: input.minecraft.trim(), forge: '', neoforge: '', fabric: '', quilt: '' }
  const loaders = LOADERS.filter((k: LoaderKind) => typeof input[k] === 'string' && (input[k] as string).trim() !== '')
  if (loaders.length > 1) throw invalid('Choose at most one mod loader')
  for (const k of loaders) out[k] = (input[k] as string).trim()
  return out
}

export async function changeVersion(deps: ChangeVersionDeps, instanceId: string, runtime: Partial<InstanceRuntime> & { minecraft: string }): Promise<InstallOutcome & { backedUpWorlds: number }> {
  const next = targetRuntime(runtime)
  deps.instances.resolve(instanceId)
  const changing = deps.changing ?? defaultChanging
  if (deps.isRunning(instanceId)) throw new AppError('EBUSY', 'Stop the game before changing its version')
  if (deps.install.isBusy(instanceId)) throw new AppError('EBUSY', 'Wait for the current install to finish')
  if (deps.isModpackBusy?.(instanceId)) throw new AppError('EBUSY', 'Wait for the modpack import or update to finish')
  if (changing.has(instanceId)) throw new AppError('EBUSY', 'The version of this instance is already being changed')
  changing.add(instanceId)
  try {
    const backedUpWorlds = await deps.backupWorlds(instanceId)
    // Launch refuses while `changing` holds the instance; check again in case a caller does not.
    if (deps.isRunning(instanceId)) throw new AppError('EBUSY', 'The game was started during the world backup; stop it before changing its version')
    // Validation of the version ids happens here (EINVALID_ARGUMENT) before anything is installed.
    await deps.instances.update(instanceId, { runtime: next })
    const outcome = await deps.install.install(instanceId)
    return { ...outcome, backedUpWorlds }
  } finally {
    changing.delete(instanceId)
  }
}
