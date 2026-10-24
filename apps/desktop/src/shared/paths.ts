/** Environment variables main passes to the runtime process at fork time. */
export const RUNTIME_ENV = {
  userData: 'AMETHYST_USER_DATA',
  logs: 'AMETHYST_LOGS',
  version: 'AMETHYST_VERSION',
  /** The macOS product version (e.g. `15.1`); only main can read it. */
  osVersion: 'AMETHYST_OS_VERSION',
} as const
