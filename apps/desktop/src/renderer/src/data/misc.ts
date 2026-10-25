// Wired hooks moved to their domain modules; re-exported here for existing imports.
// Discover and project pages use `data/market.ts`.
export { useAccounts } from './accounts'
export { useTasks } from './tasks'
export { useJavaRuntimes } from './java'
export { useGameVersions, useLoaderVersions } from './versions'
export { useAppInfo } from './updater'
export { useHomeUpdates } from './home'
