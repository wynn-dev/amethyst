/**
 * Web permission policy for every session. Electron grants every permission request by default
 * (camera, microphone, geolocation, MIDI, HID…), and the Microsoft sign-in window shows remote
 * pages. Only Amethyst's own pages get the two permissions they use; everything else is denied.
 */
import type { Session } from 'electron'

/** Copying (log lines, diagnostics) and notifications when a game or an update finishes in the background. */
const APP_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications'])

/** One of Amethyst's own pages: the bundled renderer (`file:`) or, in development, the dev server. */
export function isAppUrl(url: string | undefined, devOrigin?: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'file:' || (devOrigin !== undefined && u.origin === devOrigin)
  } catch {
    return false
  }
}

export function allowPermission(permission: string, url: string | undefined, devOrigin?: string): boolean {
  return APP_PERMISSIONS.has(permission) && isAppUrl(url, devOrigin)
}

export function installPermissionPolicy(session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>, devOrigin?: string): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowPermission(permission, details.requestingUrl || contents.getURL(), devOrigin))
  })
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => allowPermission(permission, contents?.getURL() || requestingOrigin, devOrigin))
}
