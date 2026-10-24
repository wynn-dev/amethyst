import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HttpClient } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import { InstallError } from '../errors'
import { ensureFiles, type FileSpec } from '../files'
import { safeJoin } from '../fs-util'
import { coordinatePath, joinUrl } from '../maven'
import { requireSidecarHash, type VerifiedHash } from '../sidecar'

/** A Forge or NeoForge build to install. */
export interface ForgeArtifact {
  /** Maven group: `net.minecraftforge` or `net.neoforged`. */
  group: string
  /** Maven artifact: `forge` or `neoforge` (or `forge` for NeoForge 1.20.1). */
  artifact: string
  /** Exact maven version, e.g. `1.20.1-47.3.0` or `21.1.209`. */
  version: string
  /** Maven repository root the artifact lives in. */
  repository: string
}

/**
 * Coordinate of one classifier of the artifact, e.g. `net.minecraftforge:forge:1.20.1-47.3.0:installer`.
 * An empty classifier means the main artifact.
 */
export function artifactCoordinate(a: ForgeArtifact, classifier: string, extension = 'jar'): string {
  return `${a.group}:${a.artifact}:${a.version}${classifier ? `:${classifier}` : ''}${extension === 'jar' ? '' : `@${extension}`}`
}

/** Remote URL of one classifier of the artifact. */
export function artifactUrl(a: ForgeArtifact, classifier: string, extension = 'jar'): string {
  return joinUrl(a.repository, coordinatePath(artifactCoordinate(a, classifier, extension)))
}

/** Local path of one classifier of the artifact under `<root>/libraries`. */
export function artifactPath(root: string, a: ForgeArtifact, classifier: string, extension = 'jar'): string {
  return safeJoin(join(root, 'libraries'), coordinatePath(artifactCoordinate(a, classifier, extension)))
}

/** Options for {@link downloadVerifiedArtifact}. */
export interface VerifiedDownloadOptions {
  root: string
  http?: HttpClient
  signal?: AbortSignal
  ctx?: TaskContext
  /**
   * md5 from Forge's `meta.json`, used only when the maven publishes no `.sha256`/`.sha1` sidecar
   * (`install.md` §4.1 allows it as a second choice).
   */
  md5?: string
}

async function md5File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Download a classifier of a Forge/NeoForge artifact whose contents will be **executed**
 * (installer jars, universal archives) and verify it **before** returning.
 *
 * The digest comes from the maven `.sha256` (preferred) or `.sha1` sidecar; an existing local copy
 * is re-hashed against it. Only when no sidecar exists is the Forge `meta.json` md5 accepted. With
 * neither, it fails closed with `EINSTALL_UNVERIFIED` and nothing is downloaded.
 *
 * @returns the local path and the digest it was verified against.
 */
export async function downloadVerifiedArtifact(
  artifact: ForgeArtifact,
  classifier: string,
  extension: string,
  options: VerifiedDownloadOptions,
): Promise<{ path: string; hash: VerifiedHash | { algorithm: 'md5'; value: string } }> {
  const url = artifactUrl(artifact, classifier, extension)
  const path = artifactPath(options.root, artifact, classifier, extension)
  const spec: FileSpec = { path, urls: [url], validator: 'zip', name: artifactCoordinate(artifact, classifier, extension) }
  let hash: VerifiedHash | undefined
  try {
    hash = await requireSidecarHash(url, { http: options.http, signal: options.signal })
  } catch (e) {
    if (options.signal?.aborted || !options.md5 || !(e instanceof InstallError)) throw e
  }
  if (hash) {
    if (hash.algorithm === 'sha256') spec.sha256 = hash.value
    else spec.sha1 = hash.value
    await ensureFiles([spec], { http: options.http, signal: options.signal, ctx: options.ctx })
    return { path, hash }
  }
  // md5 fallback: download (or keep) the file, then compare.
  const md5 = (options.md5 as string).toLowerCase()
  const check = async () => (await md5File(path, options.signal).catch(() => '')) === md5
  if (!(await check())) {
    await ensureFiles([spec], { http: options.http, signal: options.signal, ctx: options.ctx, replace: true })
    if (!(await check())) {
      await rm(path, { force: true })
      throw new InstallError('EINSTALL_CHECKSUM', `${url} does not match its published md5 ${md5}`, { url, path })
    }
  }
  return { path, hash: { algorithm: 'md5', value: md5 } }
}
