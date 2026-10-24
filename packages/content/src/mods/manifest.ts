/**
 * Parse the main section of a JAR manifest (`META-INF/MANIFEST.MF`): `Key: Value` lines, where a
 * line starting with a single space continues the previous value. Parsing stops at the first
 * blank line (per-entry sections follow it). Never throws.
 */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  let last: string | undefined
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (last !== undefined) break
      continue
    }
    if (line.startsWith(' ')) {
      if (last !== undefined) out[last] += line.slice(1)
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    last = line.slice(0, colon).trim()
    // Only the separator space is dropped: a wrapped value may end in a meaningful space.
    out[last] = line.slice(colon + 1).replace(/^\s+/, '')
  }
  return out
}
