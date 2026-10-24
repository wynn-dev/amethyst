/**
 * The RPC surface. Methods must be async and take/return structured-cloneable data only.
 *
 * `RuntimeServices` live in the runtime utility process; `MainServices` live in the Electron
 * main process and cover only window/OS integration. `HostServices` are Electron-only APIs
 * the runtime borrows from main (never exposed to the renderer).
 */

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

export interface AppService {
  getInfo(): Promise<AppInfo>
}

export interface RuntimeStatusService {
  ping(): Promise<{ pid: number; uptimeMs: number; memoryRss: number }>
}

export interface RuntimeServices {
  runtime: RuntimeStatusService
}

export interface MainServices {
  app: AppService
}

export const MAIN_SERVICES = ['app'] as const satisfies readonly (keyof MainServices)[]

export type Services = RuntimeServices & MainServices

export interface HostServices {
  /** Encrypt with the OS keychain via Electron safeStorage. Returns base64. */
  encrypt(plain: string): Promise<string>
  /** Decrypt a value produced by `encrypt`. Throws `ESECRET_UNREADABLE` when the key changed. */
  decrypt(cipher: string): Promise<string>
  /** Move a file or folder to the macOS Trash. */
  trash(path: string): Promise<void>
}
