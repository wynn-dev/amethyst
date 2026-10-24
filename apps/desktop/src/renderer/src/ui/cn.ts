/** Joins class names, skipping falsy values. Deliberately tiny: no conflict resolution. */
export function cn(...parts: (string | false | null | undefined | 0)[]): string {
  let out = ''
  for (const p of parts) if (p) out = out ? `${out} ${p}` : p
  return out
}

/** Formats a shortcut written as e.g. `mod+shift+k` into macOS glyphs: ⇧⌘K. */
export function shortcutGlyphs(shortcut: string): string {
  const keys = shortcut.toLowerCase().split('+')
  const order = ['ctrl', 'alt', 'shift', 'mod']
  const glyph: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
  const named: Record<string, string> = {
    enter: '↩',
    return: '↩',
    backspace: '⌫',
    delete: '⌫',
    escape: '⎋',
    esc: '⎋',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    tab: '⇥',
    space: 'Space',
    comma: ',',
    period: '.',
    slash: '/',
  }
  const mods = order.filter((m) => keys.includes(m)).map((m) => glyph[m])
  const rest = keys.filter((k) => !order.includes(k)).map((k) => named[k] ?? k.toUpperCase())
  return [...mods, ...rest].join('')
}
