/**
 * Resource pack formats and the Minecraft releases that use them (public data, minecraft.wiki
 * "Pack format"), for the "Made for 1.20" compatibility hints.
 */
const FORMATS: [format: number, first: string, last: string][] = [
  [1, '1.6.1', '1.8.9'],
  [2, '1.9', '1.10.2'],
  [3, '1.11', '1.12.2'],
  [4, '1.13', '1.14.4'],
  [5, '1.15', '1.16.1'],
  [6, '1.16.2', '1.16.5'],
  [7, '1.17', '1.17.1'],
  [8, '1.18', '1.18.2'],
  [9, '1.19', '1.19.2'],
  [12, '1.19.3', '1.19.3'],
  [13, '1.19.4', '1.19.4'],
  [15, '1.20', '1.20.1'],
  [18, '1.20.2', '1.20.2'],
  [22, '1.20.3', '1.20.4'],
  [32, '1.20.5', '1.20.6'],
  [34, '1.21', '1.21.1'],
  [42, '1.21.2', '1.21.3'],
  [46, '1.21.4', '1.21.4'],
  [55, '1.21.5', '1.21.5'],
  [63, '1.21.6', '1.21.6'],
  [64, '1.21.7', '1.21.8'],
]

const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
function compare(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** The pack format of a Minecraft release, or `undefined` (snapshots, unknown releases). */
export function packFormatFor(minecraft: string): number | undefined {
  if (!/^\d+\.\d+(\.\d+)?$/.test(minecraft)) return undefined
  return FORMATS.find(([, first, last]) => compare(minecraft, first) >= 0 && compare(minecraft, last) <= 0)?.[0]
}

/** "1.20–1.20.1" for a format, or `undefined` when it is not in the table. */
export function releasesFor(format: number): string | undefined {
  const f = FORMATS.find(([n]) => n === format)
  if (!f) return undefined
  return f[1] === f[2] ? f[1] : `${f[1]}–${f[2]}`
}

export interface PackCompat {
  ok: boolean
  /** e.g. "Made for 1.20–1.20.1". */
  label: string
  detail: string
}

/** Whether a pack's formats include the instance's. `undefined` when either side is unknown. */
export function packCompat(formats: { min: number; max: number } | undefined, minecraft: string | undefined): PackCompat | undefined {
  if (!formats || !minecraft) return undefined
  const mine = packFormatFor(minecraft)
  if (mine === undefined) return undefined
  if (mine >= formats.min && mine <= formats.max) return { ok: true, label: 'Compatible', detail: `Supports pack format ${mine} (Minecraft ${minecraft}).` }
  const made = releasesFor(formats.max) ?? `pack format ${formats.max}`
  return {
    ok: false,
    label: `Made for ${releasesFor(formats.max) ?? `format ${formats.max}`}`,
    detail: `This pack declares pack format ${formats.min === formats.max ? formats.max : `${formats.min}–${formats.max}`} (${made}); Minecraft ${minecraft} uses ${mine}. Some textures may be missing or look wrong.`,
  }
}
