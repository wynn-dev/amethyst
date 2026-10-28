/**
 * HTTP client and parallel, resumable, checksum-verified downloader.
 *
 * {@link createHttpClient} wraps one keep-alive undici `Agent` (HTTP/2 when offered, per-host
 * connection limit, connect/headers/body timeouts, verified TLS, an optional HTTP(S)/SOCKS5 proxy
 * that can be changed live) with redirects, retries and typed errors, plus JSON/text/bytes helpers. A lazily created process-wide client backs every call that
 * does not pass its own ({@link getDefaultHttpClient}).
 *
 * {@link download} fetches one file into `<dest>.part`, hashing while streaming, then verifies and
 * atomically renames it. It resumes partial files, falls back across mirror URLs, and splits large
 * files into parallel ranges. {@link downloadMany} runs a bounded pool over many items, aggregates
 * byte progress into a `TaskContext`, collects failures and returns throughput metrics.
 */
export { download } from './download'
export { bypassesProxy, installGlobalDispatcher, type ProxyConfig } from './dispatcher'
export {
  ChecksumError,
  DownloadError,
  HttpError,
  NetError,
  sanitizeUrl,
  SizeMismatchError,
  type DownloadFailure,
  type NetErrorCode,
} from './errors'
export { hashFile } from './hash'
export {
  CROSS_ORIGIN_SAFE_HEADERS,
  createHttpClient,
  getDefaultHttpClient,
  setDefaultHttpClient,
  userAgent,
  type HttpClient,
  type HttpClientOptions,
  type HttpResponse,
  type JsonOptions,
  type NetworkOptions,
  type ReadOptions,
  type RequestOptions,
  type ResponseBody,
} from './http'
export { downloadMany } from './many'
export { isRetryableError, isRetryableStatus, type RetryInfo, type RetryOptions } from './retry'
export type {
  Checksum,
  DownloadItem,
  DownloadManyOptions,
  DownloadOptions,
  DownloadResult,
  DownloadStats,
  ExistingFilePolicy,
  HashAlgorithm,
  SegmentOptions,
} from './types'
