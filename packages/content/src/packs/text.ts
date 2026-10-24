/**
 * Flatten Minecraft JSON text components (https://minecraft.wiki/w/Text_component_format) into
 * a legacy-formatted string: plain text with `§` colour and style codes.
 */

const COLOR_CODES: Record<string, string> = {
  black: '0',
  dark_blue: '1',
  dark_green: '2',
  dark_aqua: '3',
  dark_red: '4',
  dark_purple: '5',
  gold: '6',
  gray: '7',
  dark_gray: '8',
  blue: '9',
  green: 'a',
  aqua: 'b',
  red: 'c',
  light_purple: 'd',
  yellow: 'e',
  white: 'f',
}

/** RGB of each legacy colour code, for mapping `#rrggbb` colours to the nearest code. */
const PALETTE: [code: string, rgb: number][] = [
  ['0', 0x000000],
  ['1', 0x0000aa],
  ['2', 0x00aa00],
  ['3', 0x00aaaa],
  ['4', 0xaa0000],
  ['5', 0xaa00aa],
  ['6', 0xffaa00],
  ['7', 0xaaaaaa],
  ['8', 0x555555],
  ['9', 0x5555ff],
  ['a', 0x55ff55],
  ['b', 0x55ffff],
  ['c', 0xff5555],
  ['d', 0xff55ff],
  ['e', 0xffff55],
  ['f', 0xffffff],
]

const STYLE_CODES: [key: StyleFlag, code: string][] = [
  ['obfuscated', 'k'],
  ['bold', 'l'],
  ['strikethrough', 'm'],
  ['underlined', 'n'],
  ['italic', 'o'],
]

type StyleFlag = 'bold' | 'italic' | 'underlined' | 'strikethrough' | 'obfuscated'

interface Style {
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

function nearestColor(hex: string): string | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return undefined
  const v = Number.parseInt(m[1] as string, 16)
  const [r, g, b] = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  let best: string | undefined
  let bestDist = Infinity
  for (const [code, rgb] of PALETTE) {
    const d = (r - ((rgb >> 16) & 0xff)) ** 2 + (g - ((rgb >> 8) & 0xff)) ** 2 + (b - (rgb & 0xff)) ** 2
    if (d < bestDist) {
      bestDist = d
      best = code
    }
  }
  return best
}

function colorCode(color: unknown): string | undefined {
  if (typeof color !== 'string') return undefined
  return COLOR_CODES[color.toLowerCase()] ?? nearestColor(color)
}

function prefix(style: Style): string {
  let out = ''
  if (style.color) out += `§${style.color}`
  for (const [key, code] of STYLE_CODES) if (style[key]) out += `§${code}`
  return out
}

const MAX_DEPTH = 64

/** Substitute `%s` / `%1$s` placeholders of a translation fallback with already-flattened args. */
function format(template: string, args: string[]): string {
  let next = 0
  return template.replace(/%(?:(\d+)\$)?([sd%])/g, (_m, index: string | undefined, kind: string) => {
    if (kind === '%') return '%'
    const i = index !== undefined ? Number(index) - 1 : next++
    return args[i] ?? ''
  })
}

/**
 * Convert a text component (string, number, boolean, object or array) into text with `§` codes.
 * Object components read `text`, `translate` (using `fallback`, else the key itself, with
 * `with` arguments), `keybind`, `selector` and `score`; styles (`color` including `#rrggbb`,
 * `bold`, `italic`, `underlined`, `strikethrough`, `obfuscated`) are inherited by `extra`
 * children. In an array the first element is the parent of the rest. Strings may already
 * contain `§` codes, which are kept.
 */
export function flattenTextComponent(component: unknown): string {
  const parts: string[] = []
  // Codes currently in effect: '' when unstyled, undefined when unknown (after embedded § codes).
  let active: string | undefined = ''

  const emit = (text: string, style: Style) => {
    if (text === '') return
    const codes = prefix(style)
    if (codes !== active) parts.push(`${active !== '' ? '§r' : ''}${codes}`)
    parts.push(text)
    active = text.includes('§') ? undefined : codes
  }

  const walk = (c: unknown, inherited: Style, depth: number): void => {
    if (depth > MAX_DEPTH || c === null || c === undefined) return
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
      emit(String(c), inherited)
      return
    }
    if (Array.isArray(c)) {
      if (c.length === 0) return
      // The first element is the parent: later elements inherit its style.
      const [first, ...rest] = c
      walk({ ...(typeof first === 'object' && first !== null && !Array.isArray(first) ? first : { text: String(first ?? '') }), extra: rest }, inherited, depth + 1)
      return
    }
    if (typeof c !== 'object') return
    const o = c as Record<string, unknown>
    const style: Style = { ...inherited }
    const code = colorCode(o.color)
    if (code) style.color = code
    for (const [key] of STYLE_CODES) {
      const v = o[key]
      if (typeof v === 'boolean') style[key] = v
    }

    if (typeof o.text === 'string' || typeof o.text === 'number') {
      emit(String(o.text), style)
    } else if (typeof o.translate === 'string') {
      const args = Array.isArray(o.with) ? o.with.map((w) => stripFormatting(flattenTextComponent(w))) : []
      emit(format(typeof o.fallback === 'string' ? o.fallback : o.translate, args), style)
    } else if (typeof o.keybind === 'string') {
      emit(o.keybind, style)
    } else if (typeof o.selector === 'string') {
      emit(o.selector, style)
    } else if (typeof o.score === 'object' && o.score !== null) {
      const score = o.score as Record<string, unknown>
      if (typeof score.value === 'string') emit(score.value, style)
    }
    if (Array.isArray(o.extra)) for (const child of o.extra) walk(child, style, depth + 1)
  }

  walk(component, {}, 0)
  return parts.join('')
}

/** Remove `§x` formatting codes (and stray trailing `§`). */
export function stripFormatting(text: string): string {
  return text.replace(/§[0-9a-fk-orx]?/gi, '')
}
