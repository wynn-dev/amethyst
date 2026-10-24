/** Environment variables main passes to the runtime process at fork time. */
export const RUNTIME_ENV = {
  userData: 'AMETHYST_USER_DATA',
  logs: 'AMETHYST_LOGS',
  version: 'AMETHYST_VERSION',
} as const
