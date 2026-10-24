/**
 * Removes personal data from free-form strings (error messages, stack traces) before they are
 * sent. Scrubbing is deliberately aggressive: losing some debugging detail is preferable to
 * leaking a path, a name or a token.
 */

export interface ScrubOptions {
  /** The user's home directory, e.g. `/Users/alex`. Replaced with `~`. */
  homeDir?: string
  /** The OS account name. Replaced with `<user>` wherever it appears as a word. */
  username?: string
  /** Extra exact strings to remove, such as Minecraft player names. Replaced with `<redacted>`. */
  sensitive?: Iterable<string>
}

export interface Scrubber {
  (input: string): string
  /** Remember another exact string to remove (e.g. a player name after sign-in). */
  addSensitive(value: string): void
}

/** Folders whose children are named by the user: instance names, worlds, mod and screenshot files. */
const USER_CONTENT_DIRS = [
  'instances',
  'saves',
  'mods',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
  'screenshots',
  'schematics',
  'backups',
  'crash-reports',
  'logs',
  'Desktop',
  'Documents',
  'Downloads',
]

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Order matters: the most specific patterns run first.
const RULES: [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  // Home directories of any user, including inside file:// URLs.
  [/\/(?:Users|home)\/[^/\s'"`:)]+/g, '~'],
  // A segment under a user-content folder: `mods/Secret Mod.jar` → `mods/<redacted>.jar`.
  [
    new RegExp(String.raw`/(${USER_CONTENT_DIRS.map(escapeRegExp).join('|')})/([^/\n\r'"\x60()<>:]+)`, 'g'),
    (_m, dir: string, name: string) => {
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name.trimEnd())?.[0] ?? ''
      return `/${dir}/<redacted>${ext}`
    },
  ],
  // Credentials in query strings, headers and JSON.
  [/\b(Bearer|Basic)\s+[^\s'",;]+/gi, '$1 <token>'],
  [
    /\b(access_?token|refresh_?token|id_?token|token|password|passwd|secret|api_?key|client_?secret|authorization)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|<)[^\s&"',;}]+/gi,
    '$1$2<redacted>',
  ],
  // OAuth redirect parameters.
  [/([?&#](?:code|state|session_state)=)[^&\s#'"]+/g, '$1<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  // JWT-like: three base64url segments, the first starting with `eyJ` (`{"`).
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<token>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{32}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{24,}\b/gi, '<hex>'],
  // Long opaque tokens (Microsoft/Xbox tokens, API keys): 32+ base64url-ish chars mixing letters and digits.
  [/[A-Za-z0-9_\-+/=.!*$]{32,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && !m.includes('/') ? '<token>' : m)],
  // IPv4 and IPv6 addresses.
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '<ip>'],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, '<ip>'],
  [/(?<![\w:])::1(?![\w:])/g, '<ip>'],
]

/** Maximum length of any scrubbed string. Longer input is truncated. */
export const MAX_SCRUBBED_LENGTH = 8_000

export function createScrubber(options: ScrubOptions = {}): Scrubber {
  const sensitive = new Set<string>()
  let sensitiveRe: RegExp | undefined

  const rebuild = () => {
    const values = [...sensitive].toSorted((a, b) => b.length - a.length).map(escapeRegExp)
    sensitiveRe = values.length ? new RegExp(values.join('|'), 'gi') : undefined
  }
  const add = (value: string) => {
    const v = value.trim()
    if (v.length < 3 || sensitive.has(v)) return
    sensitive.add(v)
    rebuild()
  }
  for (const v of options.sensitive ?? []) add(v)

  const home = options.homeDir?.replace(/\/+$/, '')
  const homeRe = home && home.length > 1 ? new RegExp(escapeRegExp(home), 'g') : undefined
  const user = options.username?.trim()
  const userRe = user && user.length >= 3 ? new RegExp(String.raw`(?<![A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi') : undefined

  const scrub = ((input: string) => {
    let s = String(input)
    if (s.length > MAX_SCRUBBED_LENGTH) s = s.slice(0, MAX_SCRUBBED_LENGTH) + '…'
    if (homeRe) s = s.replace(homeRe, '~')
    if (sensitiveRe) s = s.replace(sensitiveRe, '<redacted>')
    for (const [re, replacement] of RULES) s = s.replace(re, replacement as string)
    if (userRe) s = s.replace(userRe, '<user>')
    return s
  }) as Scrubber
  scrub.addSensitive = add
  return scrub
}
