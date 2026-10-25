import { describe, expect, it } from 'vitest'
import { allowPermission, installPermissionPolicy, isAppUrl } from './permissions'

const APP = 'file:///Applications/Amethyst.app/Contents/Resources/app.asar/out/renderer/index.html#/'
const SIGN_IN = 'https://login.live.com/oauth20_authorize.srf'
const contents = (url: string) => ({ getURL: () => url })

describe('permission policy', () => {
  it('recognises only the app’s own pages', () => {
    expect(isAppUrl(APP)).toBe(true)
    expect(isAppUrl('http://localhost:5173/#/', 'http://localhost:5173')).toBe(true)
    expect(isAppUrl('http://localhost:5173/', undefined)).toBe(false)
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isAppUrl(SIGN_IN)).toBe(false)
    expect(isAppUrl('')).toBe(false)
    expect(isAppUrl('not a url')).toBe(false)
  })

  it('denies capture, location and device access everywhere, and everything to remote pages', () => {
    for (const p of ['media', 'geolocation', 'midi', 'hid', 'usb', 'serial', 'openExternal', 'display-capture', 'pointerLock']) {
      expect({ p, app: allowPermission(p, APP), remote: allowPermission(p, SIGN_IN) }).toEqual({ p, app: false, remote: false })
    }
    expect(allowPermission('notifications', APP)).toBe(true)
    expect(allowPermission('clipboard-sanitized-write', APP)).toBe(true)
    expect(allowPermission('notifications', SIGN_IN)).toBe(false)
    expect(allowPermission('clipboard-sanitized-write', SIGN_IN)).toBe(false)
  })

  it('installs request and check handlers that apply it', () => {
    let request: ((...a: never[]) => void) | undefined
    let check: ((...a: never[]) => boolean) | undefined
    installPermissionPolicy({
      setPermissionRequestHandler: (h) => void (request = h as never),
      setPermissionCheckHandler: (h) => void (check = h as never),
    })
    const answers: boolean[] = []
    const ask = request as unknown as (c: unknown, p: string, cb: (ok: boolean) => void, d: { requestingUrl?: string }) => void
    ask(contents(SIGN_IN), 'media', (ok) => answers.push(ok), { requestingUrl: SIGN_IN })
    ask(contents(APP), 'notifications', (ok) => answers.push(ok), { requestingUrl: APP })
    expect(answers).toEqual([false, true])
    const can = check as unknown as (c: unknown, p: string, origin: string) => boolean
    expect(can(contents(APP), 'clipboard-sanitized-write', 'file:///')).toBe(true)
    expect(can(contents(SIGN_IN), 'clipboard-sanitized-write', 'https://login.live.com')).toBe(false)
    expect(can(null, 'geolocation', 'file:///')).toBe(false)
  })
})
