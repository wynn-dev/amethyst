/**
 * Unverified JWT payload decoding, for reading informational claims (`xuid`, `oid`, `exp`) from
 * tokens we just received over TLS. Never use this to make trust decisions.
 */

/** Decode the payload of a compact JWS, or return `undefined` if it is not JWT-shaped. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
