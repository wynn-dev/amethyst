import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ZipReader } from '@amethyst/zip'
import { KeyedMutex, sweepStaleTemps, tempPathFor } from '../fs-util'
import type { InstallOptions } from '../options'
import type { ProcessorRunner } from './processors'

/** Options shared by the Forge and NeoForge installers. */
export interface ForgeInstallOptions extends InstallOptions {
  /** `java` executable used to run processors (normally the version's required Java, see `requiredJavaMajor`). */
  java?: string
  /** Extra JVM options for processors, e.g. `-Dhttps.proxyHost=…`. */
  jvmArgs?: string[]
  /** Replace how processors are executed (tests, alternative strategies). Default: one JVM per processor. */
  runner?: ProcessorRunner
  /** Per-processor timeout in ms (default 10 minutes). */
  processorTimeoutMs?: number
  /** Live processor output. */
  onProcessorLog?: (text: string, mainClass: string) => void
  /**
   * Version id to inherit from instead of the vanilla version (stacking on another layer). The
   * installer's own id is kept.
   */
  base?: string
}

/**
 * Forge/NeoForge installs share processor outputs and run heavy JVMs, so only one runs at a time,
 * launcher-wide (in-process).
 */
export const forgeMutex = new KeyedMutex()

/** Stream one zip entry to `dest` through a temp file and an atomic rename. */
export async function extractEntry(zip: ZipReader, name: string, dest: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = tempPathFor(dest)
  try {
    await pipeline(await zip.openStream(name, { signal }), createWriteStream(tmp), { signal })
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  await sweepStaleTemps(dirname(dest))
}
