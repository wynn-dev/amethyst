/**
 * Forge/NeoForge installer `install_profile.json` model and validation.
 *
 * Two generations exist:
 * - **legacy** (Forge 1.5.2 – 1.12.2 before ~14.23.5.2851): `{install: {...}, versionInfo: <version JSON>}`;
 * - **modern** (spec 0 and 1: late 1.12.2, 1.13+ and all NeoForge): `{spec, version, minecraft, json,
 *   data, processors, libraries}` next to a `version.json` entry.
 */
import type { LibraryJson } from '@amethyst/game'
import { InstallError } from '../errors'
import { checkVersionJson, type RawVersionJson } from '../version-json'

/** One processor of a modern profile. */
export interface Processor {
  /** Maven coordinate of the processor jar. */
  jar: string
  /** Coordinates on the processor's classpath (besides `jar`). */
  classpath?: string[]
  args?: string[]
  /** `{path template: sha1 template}`. */
  outputs?: Record<string, string>
  /** Sides the processor runs on (`client`, `server`); absent means both. */
  sides?: string[]
}

/** A `data` entry: one value per side. */
export interface ProfileData {
  client: string
  server: string
}

/** A modern install profile. */
export interface ModernProfile {
  spec?: number
  /** The version id the installer creates, e.g. `1.20.1-forge-47.3.0` or `neoforge-21.1.209`. */
  version: string
  /** The vanilla version it patches. */
  minecraft: string
  /** In-jar path of the version JSON (usually `/version.json`). */
  json?: string
  /** The Forge artifact itself (spec 0), provided through the installer's `maven/` folder. */
  path?: string | null
  data?: Record<string, ProfileData>
  processors?: Processor[]
  /** Processor jars and their dependencies. */
  libraries?: LibraryJson[]
  [key: string]: unknown
}

/** A legacy install profile. */
export interface LegacyProfile {
  install: {
    /** Version id the old installer created, e.g. `1.7.10-Forge10.13.4.1614-1.7.10`. */
    target?: string
    /** Coordinate of the Forge library. */
    path: string
    /** Name of the universal jar inside the installer. */
    filePath: string
    minecraft: string
    [key: string]: unknown
  }
  versionInfo: RawVersionJson
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function bad(what: string): never {
  throw new InstallError('EINSTALL_BAD_INSTALLER', `install_profile.json: ${what}`)
}

/** True for the legacy (`versionInfo`) shape. */
export function isLegacyProfile(value: unknown): boolean {
  return isObject(value) && isObject(value.install) && isObject(value.versionInfo)
}

/**
 * Validate a legacy profile.
 *
 * @throws {InstallError} `EINSTALL_BAD_INSTALLER` when malformed.
 */
export function parseLegacyProfile(value: unknown): LegacyProfile {
  if (!isObject(value) || !isObject(value.install) || !isObject(value.versionInfo)) bad('not a legacy profile')
  const install = value.install
  if (typeof install.path !== 'string' || typeof install.filePath !== 'string' || typeof install.minecraft !== 'string') bad('install.path, filePath or minecraft missing')
  let versionInfo: RawVersionJson
  try {
    versionInfo = checkVersionJson(value.versionInfo, 'install_profile.json versionInfo')
  } catch (e) {
    throw new InstallError('EINSTALL_BAD_INSTALLER', (e as Error).message, { cause: e })
  }
  return { install: install as LegacyProfile['install'], versionInfo }
}

/**
 * Validate a modern profile.
 *
 * @throws {InstallError} `EINSTALL_BAD_INSTALLER` when malformed.
 */
export function parseModernProfile(value: unknown): ModernProfile {
  if (!isObject(value)) bad('not an object')
  if (typeof value.version !== 'string' || value.version === '') bad('missing version')
  if (typeof value.minecraft !== 'string' || value.minecraft === '') bad('missing minecraft')
  if (value.json !== undefined && typeof value.json !== 'string') bad('json is not a string')
  if (value.data !== undefined) {
    if (!isObject(value.data)) bad('data is not an object')
    for (const [k, v] of Object.entries(value.data)) {
      if (!isObject(v) || typeof v.client !== 'string' || typeof v.server !== 'string') bad(`data.${k} is malformed`)
    }
  }
  if (value.processors !== undefined) {
    if (!Array.isArray(value.processors)) bad('processors is not an array')
    value.processors.forEach((p, i) => {
      if (!isObject(p) || typeof p.jar !== 'string') bad(`processors[${i}].jar is missing`)
      if (p.classpath !== undefined && !isStringArray(p.classpath)) bad(`processors[${i}].classpath is malformed`)
      if (p.args !== undefined && !isStringArray(p.args)) bad(`processors[${i}].args is malformed`)
      if (p.sides !== undefined && !isStringArray(p.sides)) bad(`processors[${i}].sides is malformed`)
      if (p.outputs !== undefined && (!isObject(p.outputs) || !Object.values(p.outputs).every((x) => typeof x === 'string'))) bad(`processors[${i}].outputs is malformed`)
    })
  }
  if (value.libraries !== undefined) {
    if (!Array.isArray(value.libraries)) bad('libraries is not an array')
    // Reuse the version JSON validator for the library entries.
    try {
      checkVersionJson({ id: 'install_profile', libraries: value.libraries }, 'install_profile.json')
    } catch (e) {
      throw new InstallError('EINSTALL_BAD_INSTALLER', (e as Error).message, { cause: e })
    }
  }
  return value as ModernProfile
}
