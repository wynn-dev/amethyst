import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JavaArch } from './types'

/**
 * The `release` file at the root of every JDK/JRE home: shell-style `KEY="value"` lines such as
 * `JAVA_VERSION="17.0.15"`, `OS_ARCH="aarch64"` and `IMPLEMENTOR="Azul Systems, Inc."`.
 */
export type ReleaseInfo = Record<string, string>

/** Parse the text of a `release` file. Unknown or malformed lines are ignored. */
export function parseReleaseFile(text: string): ReleaseInfo {
  const out: ReleaseInfo = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = (m[2] as string).trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    }
    out[m[1] as string] = value.replace(/\\(["\\$`])/g, '$1')
  }
  return out
}

/** Read and parse `<home>/release`. Returns `undefined` when absent or unreadable. */
export async function readReleaseFile(home: string): Promise<ReleaseInfo | undefined> {
  try {
    const text = await readFile(join(home, 'release'), { encoding: 'utf8', flag: 'r' })
    // A release file is a few KB; anything huge is not one.
    return text.length > 256 * 1024 ? undefined : parseReleaseFile(text)
  } catch {
    return undefined
  }
}

/** Map a Java `os.arch` / `OS_ARCH` value to {@link JavaArch}. */
export function normalizeArch(value: string | undefined): JavaArch {
  switch (value?.trim().toLowerCase()) {
    case 'aarch64':
    case 'arm64':
    case 'arm64e':
      return 'arm64'
    case 'x86_64':
    case 'amd64':
    case 'x64':
      return 'x64'
    default:
      return 'unknown'
  }
}
