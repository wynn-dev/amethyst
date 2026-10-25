/**
 * Recovery of modpack commits that were cut off (the runtime crashed or was killed while files
 * were being moved into an instance). Used before the first use of an instance (launch, and
 * every modpack operation), and by shutdown to wait for a commit in progress.
 *
 * Cheap when there is nothing to recover: one `readdir` of `.amethyst/staging`, and
 * `@amethyst/modpack` is only loaded when an operation record exists.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../log'
import { AppError, errorMessage } from '../util/errors'

const log = logger('modpacks')

type ModpackModule = typeof import('@amethyst/modpack')
let modpack: Promise<ModpackModule> | undefined
const load = (): Promise<ModpackModule> => (modpack ??= import('@amethyst/modpack'))

/**
 * Undo any interrupted commit in `instanceDir`, so the instance is never used half-updated.
 *
 * @throws {AppError} `EMODPACK_INTERRUPTED` when an interrupted commit cannot be undone.
 */
export async function recoverModpackCommits(instanceDir: string, api?: Pick<ModpackModule, 'recoverInterruptedCommits'>): Promise<void> {
  const names = await readdir(path.join(instanceDir, '.amethyst', 'staging')).catch(() => [] as string[])
  if (!names.some((n) => n.endsWith('.json'))) return
  try {
    const ids = await (api ?? (await load())).recoverInterruptedCommits(instanceDir)
    if (ids.length > 0) log.warn(`rolled back ${ids.length} interrupted modpack change(s) in ${instanceDir}: ${ids.join(', ')}`)
  } catch (e) {
    throw new AppError('EMODPACK_INTERRUPTED', `An interrupted modpack change of this instance could not be undone: ${errorMessage(e)}`, undefined, { cause: e })
  }
}

/** Wait (at most `timeoutMs`) for modpack commits, rollbacks and recoveries that are moving files. */
export async function waitForModpackCommits(timeoutMs: number, loaded: boolean): Promise<boolean> {
  if (!loaded && !modpack) return true
  return (await load()).waitForCommits(timeoutMs)
}
