/** Environment variables main passes to the runtime process at fork time. */
export const RUNTIME_ENV = {
  userData: 'AMETHYST_USER_DATA',
  logs: 'AMETHYST_LOGS',
  version: 'AMETHYST_VERSION',
} as const

/**
 * The `amethyst-asset:` protocol serves image and video files from inside the data root only
 * (see `main/asset-protocol.ts`): `amethyst-asset://data/<path relative to the data root>`.
 */
export const ASSET_SCHEME = 'amethyst-asset'
export const ASSET_HOST = 'data'

/** File extensions the asset protocol serves, with their MIME types. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/**
 * Build the asset URL for a file relative to the data root (POSIX separators), e.g.
 * `assetUrl('cache/icons/ab.png')`. `version` is appended as `?v=` to bust caches when a file is
 * replaced in place.
 */
export function assetUrl(relativePath: string, version?: string | number): string {
  const encoded = relativePath
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/')
  return `${ASSET_SCHEME}://${ASSET_HOST}/${encoded}${version === undefined ? '' : `?v=${encodeURIComponent(String(version))}`}`
}
