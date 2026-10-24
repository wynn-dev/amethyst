/**
 * Argument lists are stored as argv tokens and never split on spaces by the runtime. The UI edits
 * them as one line with shell-style quoting: `-Dfoo="a b" -Xss2M` ⇄ `['-Dfoo=a b', '-Xss2M']`.
 */

/** Split a line into tokens, honouring single and double quotes and backslash escapes. */
export function parseArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

/** Join tokens back into one editable line, quoting the ones that need it. */
export function formatArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ')
}

/** Environment variable names the runtime accepts. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
