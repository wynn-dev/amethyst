import type { TaskContext } from '@amethyst/task'
import type { HttpClient } from './http'
import type { RetryOptions } from './retry'

/** Hash algorithms accepted for verification. */
export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512'

/** An expected digest. `value` is hex and compared case-insensitively. */
export interface Checksum {
  algorithm: HashAlgorithm
  value: string
}

/**
 * What to do when the destination already exists before downloading:
 * - `'verify'` (default): skip if the checksum matches; when no checksum is given, skip if the size
 *   matches; when neither is given, download again (nothing to verify against).
 * - `'trust-size'`: skip without hashing when a `size` is given and matches (fast path for
 *   thousands of asset objects); otherwise behave like `'verify'`.
 * - `'replace'`: always download.
 *
 * Newly downloaded bytes are always fully verified, whatever the policy.
 */
export type ExistingFilePolicy = 'verify' | 'trust-size' | 'replace'

/** One file to download. */
export interface DownloadItem {
  /** Candidate URLs, tried in order until one succeeds. */
  url: string | readonly string[]
  /** Destination path. Parent directories are created. */
  dest: string
  /** Expected size in bytes, if known. Enables up-front progress totals and length checks. */
  size?: number
  checksum?: Checksum
  /** Extra request headers (for example `Authorization` for an API download). */
  headers?: Record<string, string>
  /** Per-item override of {@link DownloadOptions.existing}. */
  existing?: ExistingFilePolicy
}

/** Parallel range downloads for large files. */
export interface SegmentOptions {
  /** Minimum size, in bytes, for a file to be split (default 16 MiB). */
  threshold: number
  /** Number of parallel ranges (default 4). */
  parts: number
}

/** Options shared by {@link download} and {@link downloadMany}. */
export interface DownloadOptions {
  signal?: AbortSignal
  /** Report progress in bytes to this task. Defaults to none. */
  ctx?: TaskContext
  /** HTTP client. Defaults to the process-wide client. */
  client?: HttpClient
  /** Policy for destinations that already exist (default `'verify'`). */
  existing?: ExistingFilePolicy
  /**
   * Split large files into parallel ranges when the server sends `Accept-Ranges: bytes` and a
   * `Content-Length` at or above the threshold, whatever `size` the caller supplied. `false` disables it.
   */
  segments?: Partial<SegmentOptions> | false
  /**
   * Keep `<dest>.part` (plus a `<dest>.part.json` sidecar) for files of at least `minBytes`
   * (default 1 MiB) after a failure or cancellation, and resume it with `Range`/`If-Range` next
   * time. Smaller partials are deleted. `false` disables resuming and always deletes partials.
   */
  resume?: { minBytes?: number } | false
  /** Retry policy for each HTTP request (defaults to the client's). */
  retry?: Partial<RetryOptions>
  /**
   * Give up on a URL (and move to the next one) after this many milliseconds without a response
   * or a body byte, across all of its retries, with `ESTALLED` (default 30 000; `0` disables).
   */
  stallTimeoutMs?: number
}

/** Result of a single {@link download}. */
export interface DownloadResult {
  path: string
  /** `true` when the existing file was accepted, or another in-flight download produced it. */
  skipped: boolean
  /** Bytes received from the network for this file (all attempts). */
  bytes: number
  /** Final URL (after redirects) the file came from. Absent when skipped. */
  url?: string
}

/** Throughput metrics returned by {@link downloadMany}, e.g. for performance telemetry. */
export interface DownloadStats {
  /** Bytes received from the network. */
  bytes: number
  /** Files downloaded (not counting skipped ones). */
  files: number
  /** Files skipped because they were already valid. */
  skipped: number
  durationMs: number
}

/** Options for {@link downloadMany}. */
export interface DownloadManyOptions extends DownloadOptions {
  /** Files downloaded at once (default 16). */
  concurrency?: number
  /** Stop at the first failure and cancel the rest, instead of collecting every failure. */
  failFast?: boolean
}
