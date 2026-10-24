import { mavenPath, parseMavenName, type MavenCoordinate } from '@amethyst/game'
import { InstallError } from './errors'

/** Join a maven repository base URL and a relative path, tolerating a missing trailing slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\/+/, '')}`
}

/**
 * Parse an untrusted maven coordinate, turning `@amethyst/game`'s `TypeError` into a typed
 * `EINSTALL_BAD_METADATA` error.
 */
export function parseCoordinate(name: string): MavenCoordinate {
  try {
    return parseMavenName(name)
  } catch (e) {
    throw new InstallError('EINSTALL_BAD_METADATA', (e as Error).message, { cause: e })
  }
}

/** The relative maven path of an untrusted coordinate (see {@link parseCoordinate}). */
export function coordinatePath(name: string): string {
  return mavenPath(parseCoordinate(name))
}
