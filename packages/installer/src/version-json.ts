/**
 * Version JSON handling on top of `@amethyst/game`, plus the Mojang version manifest v2.
 *
 * The installer validates untrusted JSON with `@amethyst/game`'s `validateVersionJson`, but always
 * writes the **raw** object to disk so that fields the model does not know about are preserved.
 */
import { GameError, validateVersionJson, type VersionJson } from '@amethyst/game'
import { InstallError } from './errors'

/** A raw version JSON object: validated, but with every original field kept. */
export type RawVersionJson = VersionJson & Record<string, unknown>

/**
 * Validate an untrusted version JSON value and return it (the original object, typed).
 *
 * @throws {InstallError} `EINSTALL_BAD_METADATA` when it is malformed.
 */
export function checkVersionJson(value: unknown, context = 'version JSON'): RawVersionJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string' || (value as { id: string }).id === '') {
    throw new InstallError('EINSTALL_BAD_METADATA', `${context}: missing id`)
  }
  try {
    validateVersionJson(value, (value as { id: string }).id)
  } catch (e) {
    if (e instanceof GameError) throw new InstallError('EINSTALL_BAD_METADATA', `${context}: ${e.message}`, { cause: e })
    throw e
  }
  return value as RawVersionJson
}

/** One entry of the Mojang version manifest v2. */
export interface ManifestVersion {
  id: string
  type: string
  url: string
  time: string
  releaseTime: string
  /** sha1 of the version JSON (v2 only). */
  sha1: string
  complianceLevel?: number
}

/** The Mojang version manifest v2. */
export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: ManifestVersion[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function badManifest(what: string): never {
  throw new InstallError('EINSTALL_BAD_METADATA', `version manifest: ${what}`)
}

/**
 * Validate the Mojang version manifest v2.
 *
 * @throws {InstallError} `EINSTALL_BAD_METADATA` when the shape is wrong.
 */
export function parseVersionManifest(value: unknown): VersionManifest {
  const bad = badManifest
  if (!isObject(value) || !isObject(value.latest) || !Array.isArray(value.versions)) bad('not a version manifest')
  const versions = (value as { versions: unknown[] }).versions
  if (versions.length === 0) bad('no versions')
  versions.forEach((v, i) => {
    if (!isObject(v) || typeof v.id !== 'string' || typeof v.url !== 'string' || typeof v.type !== 'string' || typeof v.sha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(v.sha1)) {
      bad(`versions[${i}] is malformed`)
    }
  })
  return value as unknown as VersionManifest
}
