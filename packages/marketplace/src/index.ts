/**
 * Modrinth v2 and CurseForge v1 API clients for Amethyst.
 *
 * - {@link ModrinthClient} and {@link CurseForgeClient}: typed, validated, cached,
 *   rate-limited clients with an injectable `fetch`.
 * - Unified model ({@link MarketProject}, {@link MarketVersion}, {@link MarketFile}) and
 *   mappers so the UI can show both platforms in one list.
 * - {@link searchMarketplace}: combined search with independent paging and de-duplication.
 * - {@link curseforgeFingerprint}: CurseForge's murmur2 file fingerprint, streamable.
 *
 * Pure Node: no Electron imports. Errors are {@link MarketplaceError}s with a stable `code`.
 */

export * from './errors'
export * from './cache'
export * from './rate-limit'
export { Transport, buildUrl, parseRetryAfter, type FetchLike, type Query, type RequestOptions } from './http'
export * from './modrinth'
export * from './curseforge'
export * from './model'
export * from './search'
export * from './fingerprint'
