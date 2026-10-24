/**
 * Typed errors for the marketplace clients.
 *
 * Every failure surfaces as a {@link MarketplaceError} with a stable `code` so the UI can map
 * it to a friendly message without parsing text. Cancellation is the exception: when the
 * caller's `AbortSignal` fires, the signal's own `reason` (normally a `DOMException` named
 * `AbortError`) is rethrown unchanged so that `@amethyst/task` recognises it as a cancel.
 */

/** Which platform a request was made against. */
export type MarketSource = 'modrinth' | 'curseforge'

/**
 * Stable error codes.
 *
 * - `ECF_NO_KEY`: the CurseForge client was built without an API key.
 * - `ECF_FORBIDDEN`: CurseForge answered 403 (bad or revoked key). CurseForge is disabled for
 *   the rest of the session after the first 403.
 * - `ENOT_FOUND`: HTTP 404.
 * - `ERATE_LIMITED`: HTTP 429 and the retry budget is exhausted.
 * - `EHTTP`: any other non-2xx status.
 * - `ETIMEOUT`: the request did not complete within the timeout.
 * - `ENETWORK`: the request failed before a response arrived (DNS, reset, TLS).
 * - `EBAD_RESPONSE`: the body was not JSON or did not have the expected shape.
 * - `EINVALID_ARGUMENT`: the caller passed something the API would reject.
 */
export type MarketplaceErrorCode =
  | 'ECF_NO_KEY'
  | 'ECF_FORBIDDEN'
  | 'ENOT_FOUND'
  | 'ERATE_LIMITED'
  | 'EHTTP'
  | 'ETIMEOUT'
  | 'ENETWORK'
  | 'EBAD_RESPONSE'
  | 'EINVALID_ARGUMENT'

export interface MarketplaceErrorInit {
  platform: MarketSource
  /** HTTP status when a response was received. */
  status?: number
  url?: string
  /** True when trying again later may succeed (429, 5xx, network, timeout). */
  retryable?: boolean
  cause?: unknown
}

export class MarketplaceError extends Error {
  override name = 'MarketplaceError'
  readonly code: MarketplaceErrorCode
  readonly platform: MarketSource
  readonly status: number | undefined
  readonly url: string | undefined
  readonly retryable: boolean

  constructor(code: MarketplaceErrorCode, message: string, init: MarketplaceErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = code
    this.platform = init.platform
    this.status = init.status
    this.url = init.url
    this.retryable = init.retryable ?? false
  }
}

/** Type guard that also narrows on `code` when given. */
export function isMarketplaceError(e: unknown, code?: MarketplaceErrorCode): e is MarketplaceError {
  return e instanceof MarketplaceError && (code === undefined || e.code === code)
}
