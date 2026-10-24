/**
 * Minecraft version ids in one place: the classic `1.x.y` scheme, the year-based scheme
 * (`26.1`, `26.1.2`, `26.4-snapshot-5`), pre-releases and release candidates, and weekly
 * snapshots (`24w14a`).
 */
import type { VersionJson } from '@amethyst/game'

/** A parsed release-line version id. */
export interface ParsedMinecraftVersion {
  /** `[1, 21, 1]` for `1.21.1`, `[26, 1, 0]` for `26.1`. Missing parts are 0. */
  release: [number, number, number]
  /** `true` for the year-based scheme (first number ≥ 2). */
  yearBased: boolean
  /** Pre-release channel, absent for full releases. */
  channel?: 'snapshot' | 'pre' | 'rc'
  /** Number within the channel, e.g. 3 for `-rc-3`. */
  channelNumber?: number
}

const RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[- ](snapshot|pre|rc)[- ]?(\d+))?$/i
const CHANNEL_RANK = { snapshot: 0, pre: 1, rc: 2 } as const

/**
 * Parse `1.21.1`, `1.20.5-pre1`, `1.21-rc-2`, `26.3`, `26.4-snapshot-5`. Returns `undefined` for
 * ids outside the release line (weekly snapshots, alpha/beta, April Fools specials).
 */
export function parseMinecraftVersion(id: string): ParsedMinecraftVersion | undefined {
  const m = RELEASE.exec(id.trim())
  if (!m) return undefined
  const release: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  const parsed: ParsedMinecraftVersion = { release, yearBased: release[0] >= 2 }
  if (m[4]) {
    parsed.channel = m[4].toLowerCase() as 'snapshot' | 'pre' | 'rc'
    parsed.channelNumber = Number(m[5])
  }
  return parsed
}

/**
 * Compare two release-line ids (`1.21.10` > `1.21.9`, `26.1` > `1.21.11`, `1.21` > `1.21-rc-1`).
 * Ids that do not parse sort before those that do, and compare by string among themselves.
 */
export function compareMinecraftVersions(a: string, b: string): number {
  const pa = parseMinecraftVersion(a)
  const pb = parseMinecraftVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a.localeCompare(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.release[i] as number) - (pb.release[i] as number)
    if (d !== 0) return d
  }
  if (pa.channel === pb.channel) return (pa.channelNumber ?? 0) - (pb.channelNumber ?? 0)
  if (!pa.channel) return 1
  if (!pb.channel) return -1
  return CHANNEL_RANK[pa.channel] - CHANNEL_RANK[pb.channel]
}

/** Weekly snapshot ids like `24w14a`: `[year, week]`. */
function parseWeekly(id: string): [number, number] | undefined {
  const m = /^(\d{2})w(\d{2})[a-z~]?/i.exec(id)
  return m ? [Number(m[1]), Number(m[2])] : undefined
}

/**
 * The Java major version a version needs: `javaVersion.majorVersion` when the JSON declares it
 * (after merging, the last one in the chain wins), otherwise a fallback from the Minecraft version:
 * 8 up to 1.16.5, 16 for 1.17, 17 for 1.18–1.20.4, 21 for 1.20.5–1.21.x, 25 for the year-based
 * scheme. Weekly snapshots map to the release line they precede.
 *
 * Pass the vanilla id as `minecraftVersion` when `json` is a loader profile without `javaVersion`.
 */
export function requiredJavaMajor(json: Pick<VersionJson, 'id' | 'javaVersion'> | undefined, minecraftVersion?: string): number {
  if (json?.javaVersion?.majorVersion) return json.javaVersion.majorVersion
  const id = minecraftVersion ?? json?.id ?? ''
  const parsed = parseMinecraftVersion(id)
  if (parsed) {
    const [major, minor, patch] = parsed.release
    if (parsed.yearBased) return 25
    if (major !== 1) return 8
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21
    if (minor >= 18) return 17
    if (minor === 17) return 16
    return 8
  }
  const weekly = parseWeekly(id)
  if (weekly) {
    const [year, week] = weekly
    const code = year * 100 + week
    if (code >= 2414) return 21
    if (code >= 2137) return 17
    if (code >= 2119) return 16
  }
  return 8
}
