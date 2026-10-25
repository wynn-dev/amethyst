import { describe, expect, it } from 'vitest'
import { HttpError } from './errors'
import { DEFAULT_RETRY, withRetry } from './retry'

const policy = { ...DEFAULT_RETRY, baseDelayMs: 1, maxDelayMs: 2 }
const netError = (code: string) => Object.assign(new Error(code), { code })

/** Count how many times `withRetry` calls a function that always fails with `error`. */
async function attempts(error: Error): Promise<number> {
  let n = 0
  await expect(
    withRetry('https://example.invalid/x', policy, undefined, async () => {
      n++
      throw error
    }),
  ).rejects.toBe(error)
  return n
}

describe('withRetry', () => {
  it('fails fast when offline: DNS and unreachable-network errors retry only once', async () => {
    expect(await attempts(netError('ENOTFOUND'))).toBe(2)
    expect(await attempts(netError('ENETUNREACH'))).toBe(2)
    expect(await attempts(netError('ENETDOWN'))).toBe(2)
  })

  it('bounds retries for transient errors and never retries permanent ones', async () => {
    expect(await attempts(netError('ECONNRESET'))).toBe(policy.retries + 1)
    expect(await attempts(new HttpError(503, 'https://example.invalid/x'))).toBe(policy.retries + 1)
    expect(await attempts(new HttpError(404, 'https://example.invalid/x'))).toBe(1)
    expect(await attempts(new HttpError(403, 'https://example.invalid/x'))).toBe(1)
    expect(await attempts(netError('EACCES'))).toBe(1)
  })
})
