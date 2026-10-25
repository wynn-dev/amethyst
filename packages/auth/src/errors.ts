/**
 * Typed errors for the account subsystem.
 *
 * Every failure is an {@link AuthError} with a stable {@link AuthErrorCode} and a coarse
 * {@link AuthErrorType} (the categories of the accounts spec, §2.8). The renderer must classify
 * by these fields, never by class name or message text: class names do not survive IPC.
 * Use {@link AuthError.toJSON} (or `JSON.stringify`) to send an error across processes; it never
 * includes tokens.
 */

/** Coarse error category, matching the accounts spec (§2.8) plus a few local additions. */
export type AuthErrorType =
  | 'msaTokenFailed'
  | 'xboxTokenFailed'
  | 'badXsts'
  | 'minecraftLoginFailed'
  | 'noJavaProfile'
  | 'profileFetchFailed'
  | 'tokenExpired'
  | 'aborted'
  | 'skinFailed'
  | 'offlineInvalid'
  | 'sessionInvalid'

/** Why a `msaTokenFailed` error happened, when it is one of the well-known reasons. */
export type AuthErrorReason = 'USER_CANCELLED' | 'NETWORK' | 'ACCOUNT_SUSPENDED'

interface CodeInfo {
  type: AuthErrorType
  /** User-state rather than a bug: log at warn level and keep out of crash telemetry. */
  expected: boolean
  /** The stored refresh token is unusable; the user has to log in interactively again. */
  reauth?: boolean
}

const CODES = {
  // Generic transport and lifecycle.
  ECANCELLED: { type: 'aborted', expected: true },
  ETIMEOUT: { type: 'msaTokenFailed', expected: true },
  ENETWORK: { type: 'msaTokenFailed', expected: true },
  // Step 1: Microsoft OAuth.
  EMSA_CANCELLED: { type: 'msaTokenFailed', expected: true },
  EMSA_INVALID_GRANT: { type: 'tokenExpired', expected: true, reauth: true },
  EMSA_INTERACTION_REQUIRED: { type: 'tokenExpired', expected: true, reauth: true },
  EMSA_TOKEN_FAILED: { type: 'msaTokenFailed', expected: false },
  EMSA_NO_REFRESH_TOKEN: { type: 'msaTokenFailed', expected: false },
  EMSA_STATE_MISMATCH: { type: 'msaTokenFailed', expected: false },
  EMSA_NO_CODE: { type: 'msaTokenFailed', expected: false },
  ELOGIN_TIMEOUT: { type: 'msaTokenFailed', expected: true },
  EDEVICE_DECLINED: { type: 'msaTokenFailed', expected: true },
  EDEVICE_EXPIRED: { type: 'msaTokenFailed', expected: true },
  EDEVICE_BAD_CODE: { type: 'msaTokenFailed', expected: true },
  EACCOUNT_MISMATCH: { type: 'msaTokenFailed', expected: true },
  // Steps 2-3: Xbox Live and XSTS.
  EXBL_FAILED: { type: 'xboxTokenFailed', expected: false },
  EXSTS_BANNED: { type: 'xboxTokenFailed', expected: true },
  EXSTS_PARENTAL_CONTROLS: { type: 'xboxTokenFailed', expected: true },
  EXSTS_NO_ACCOUNT: { type: 'xboxTokenFailed', expected: true },
  EXSTS_TERMS_NOT_ACCEPTED: { type: 'xboxTokenFailed', expected: true },
  EXSTS_REGION_UNAVAILABLE: { type: 'xboxTokenFailed', expected: true },
  EXSTS_AGE_VERIFICATION: { type: 'xboxTokenFailed', expected: true },
  EXSTS_CHILD_NOT_IN_FAMILY: { type: 'xboxTokenFailed', expected: true },
  EXSTS_SERVICE_OUTAGE: { type: 'xboxTokenFailed', expected: true },
  EXSTS_UNKNOWN: { type: 'xboxTokenFailed', expected: false },
  EXSTS_BAD_RESPONSE: { type: 'badXsts', expected: false },
  // Step 4: Minecraft services login.
  EMSA_APP_NOT_APPROVED: { type: 'minecraftLoginFailed', expected: false },
  EMC_ACCOUNT_SUSPENDED: { type: 'minecraftLoginFailed', expected: true },
  EMC_RATE_LIMITED: { type: 'minecraftLoginFailed', expected: true },
  EMC_SERVICE_ERROR: { type: 'minecraftLoginFailed', expected: false },
  EMC_LOGIN_FAILED: { type: 'minecraftLoginFailed', expected: false },
  // Step 5 and the profile API.
  EMC_NO_PROFILE: { type: 'noJavaProfile', expected: true },
  EMC_NOT_OWNED: { type: 'noJavaProfile', expected: true },
  EMC_UNAUTHORIZED: { type: 'profileFetchFailed', expected: true },
  EMC_PROFILE_FAILED: { type: 'profileFetchFailed', expected: false },
  // Skins and capes.
  ESKIN_INVALID_PNG: { type: 'skinFailed', expected: true },
  ESKIN_BAD_DIMENSIONS: { type: 'skinFailed', expected: true },
  ESKIN_TOO_LARGE: { type: 'skinFailed', expected: true },
  ESKIN_REJECTED_IMAGE: { type: 'skinFailed', expected: true },
  ESKIN_REJECTED: { type: 'skinFailed', expected: false },
  ECAPE_INVALID: { type: 'skinFailed', expected: true },
  // Offline accounts.
  EOFFLINE_NAME_REQUIRED: { type: 'offlineInvalid', expected: true },
  EOFFLINE_NAME_LENGTH: { type: 'offlineInvalid', expected: true },
  EOFFLINE_NAME_CYRILLIC: { type: 'offlineInvalid', expected: true },
  EOFFLINE_NAME_CHARS: { type: 'offlineInvalid', expected: true },
  EOFFLINE_UUID_INVALID: { type: 'offlineInvalid', expected: true },
  // Stored sessions.
  ESESSION_INVALID: { type: 'sessionInvalid', expected: true, reauth: true },
} as const satisfies Record<string, CodeInfo>

/** Stable machine-readable error code. Map these to friendly text in the UI. */
export type AuthErrorCode = keyof typeof CODES

/** Structured details attached to an {@link AuthError}. All fields are optional and IPC-safe. */
export interface AuthErrorDetails {
  /** Override the category implied by the code (e.g. a network error during the Xbox step). */
  type?: AuthErrorType
  reason?: AuthErrorReason
  /** HTTP status of the failing response. */
  status?: number
  /** Response body, truncated to about 512 characters. */
  body?: string
  /** Whether retrying later may succeed (network, 408/425/429, 5xx). */
  retryable?: boolean
  /** Server-requested delay before retrying, in milliseconds. */
  retryAfterMs?: number
  /** The raw XSTS `XErr` number. */
  xErr?: number
  /** The raw XSTS `Message`. */
  xErrMessage?: string
  /** OAuth `error` code (e.g. `invalid_grant`). */
  oauthError?: string
  /** A browser page that helps the user fix the problem. */
  link?: string
  /** The Minecraft services `errorType` / `error` field. */
  errorType?: string
  /** The Minecraft services `developerMessage` field. */
  developerMessage?: string
  cause?: unknown
}

/** Plain-object form of an {@link AuthError}, safe to send over IPC. */
export interface SerializedAuthError extends Omit<AuthErrorDetails, 'cause'> {
  name: 'AuthError'
  code: AuthErrorCode
  type: AuthErrorType
  message: string
  expected: boolean
  reauth: boolean
}

const BODY_LIMIT = 512

/** JSON string fields that carry credentials in Microsoft, Xbox and Minecraft responses. */
const SECRET_FIELD = /("(?:access_token|refresh_token|id_token|device_code|accessToken|refreshToken|Token|token)"\s*:\s*")(?:[^"\\]|\\.)*"/g
/** Anything JWT-shaped (Minecraft access tokens, id tokens). */
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g

/** Replace credentials in a response body (e.g. a malformed 200 that still carried tokens). */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_FIELD, '$1<redacted>"').replace(JWT, '<redacted>')
}

/** Redact and truncate a response body for inclusion in an error. Errors cross IPC and reach logs. */
export function truncateBody(text: string): string {
  const clean = redactSecrets(text)
  return clean.length > BODY_LIMIT ? `${clean.slice(0, BODY_LIMIT)}…` : clean
}

export class AuthError extends Error {
  override name = 'AuthError' as const
  readonly code: AuthErrorCode
  readonly type: AuthErrorType
  readonly reason?: AuthErrorReason
  readonly status?: number
  readonly body?: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly xErr?: number
  readonly xErrMessage?: string
  readonly oauthError?: string
  readonly link?: string
  readonly errorType?: string
  readonly developerMessage?: string
  /**
   * Set by {@link refreshMicrosoft} when the Microsoft refresh token was already rotated before
   * a later step failed. Persist it, or the account loses its only valid refresh token.
   * Non-enumerable and never serialized.
   */
  declare readonly rotatedRefreshToken?: string

  constructor(code: AuthErrorCode, message: string, details: AuthErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.code = code
    this.type = details.type ?? CODES[code].type
    this.retryable = details.retryable ?? false
    if (details.reason !== undefined) this.reason = details.reason
    if (details.status !== undefined) this.status = details.status
    if (details.body !== undefined) this.body = truncateBody(details.body)
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.xErr !== undefined) this.xErr = details.xErr
    if (details.xErrMessage !== undefined) this.xErrMessage = details.xErrMessage
    if (details.oauthError !== undefined) this.oauthError = details.oauthError
    if (details.link !== undefined) this.link = details.link
    if (details.errorType !== undefined) this.errorType = details.errorType
    if (details.developerMessage !== undefined) this.developerMessage = details.developerMessage
  }

  /** True for user-state failures (log at warn level, never report as a crash). */
  get expected(): boolean {
    return CODES[this.code].expected
  }

  /** True when the stored credentials are definitively unusable and the user must log in again. */
  get reauth(): boolean {
    return 'reauth' in CODES[this.code]
  }

  /** @internal Attach the rotated refresh token without making it enumerable or serializable. */
  withRotatedRefreshToken(token: string): this {
    Object.defineProperty(this, 'rotatedRefreshToken', { value: token, enumerable: false })
    return this
  }

  toJSON(): SerializedAuthError {
    const out: SerializedAuthError = {
      name: 'AuthError',
      code: this.code,
      type: this.type,
      message: this.message,
      expected: this.expected,
      reauth: this.reauth,
      retryable: this.retryable,
    }
    for (const key of ['reason', 'status', 'body', 'retryAfterMs', 'xErr', 'xErrMessage', 'oauthError', 'link', 'errorType', 'developerMessage'] as const) {
      if (this[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = this[key]
    }
    return out
  }
}

/** Type guard for {@link AuthError}. For errors that crossed IPC, check the serialized `code` instead. */
export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError
}

/** Throw `ECANCELLED` if `signal` has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: signal.reason })
}

/** Resolve after `ms`, or reject with `ECANCELLED` as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: signal.reason }))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED', cause: signal?.reason }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
