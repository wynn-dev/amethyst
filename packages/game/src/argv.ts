/**
 * Shell-style word splitting for user-supplied argument strings, and redaction of secrets in
 * printable command lines. Nothing here ever runs a shell: commands are spawned with an argv array.
 */

/**
 * Split a string into argv tokens the way a POSIX shell would, without expansion: whitespace
 * separates words; `'...'` is literal; `"..."` groups and honours `\"`, `\\`, `\$` and `` \` ``;
 * outside quotes a backslash escapes the next character. `-Dfoo="a b"` becomes `-Dfoo=a b`.
 *
 * @throws {SyntaxError} on an unterminated quote.
 */
export function parseArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inWord = false
  let i = 0
  while (i < input.length) {
    const ch = input[i] as string
    if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) throw new SyntaxError('Unterminated single quote')
      cur += input.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (ch === '"') {
      i++
      let closed = false
      while (i < input.length) {
        const c = input[i] as string
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1] as string)) {
          cur += input[i + 1]
          i += 2
          continue
        }
        cur += c
        i++
      }
      if (!closed) throw new SyntaxError('Unterminated double quote')
      inWord = true
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur)
      cur = ''
      inWord = false
      i++
    } else {
      cur += ch
      inWord = true
      i++
    }
  }
  if (inWord) out.push(cur)
  return out
}

/** Accept either a pre-split argv list (empty strings dropped) or a string to split with {@link parseArgs}. */
export function toArgv(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  return typeof value === 'string' ? parseArgs(value) : value.filter((a) => a !== '')
}

/** Quote one argument for display (POSIX single quotes when needed). For logs only, never for execution. */
export function quoteForDisplay(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Flags whose following argument is always a secret, whatever its value. */
const SECRET_FLAGS = new Set(['--accessToken', '--session'])

export const REDACTED = '<redacted>'

/**
 * Replace secrets in an argv list: the argument after `--accessToken`/`--session`, plus every
 * occurrence of each value in `secrets` anywhere in any argument (`token:<t>:<uuid>`, positional
 * legacy sessions, `-D` properties).
 */
export function redactArgs(args: readonly string[], secrets: readonly string[] = []): string[] {
  const values = secrets.filter((s) => s.length >= 4).toSorted((a, b) => b.length - a.length)
  return args.map((arg, i) => {
    if (i > 0 && SECRET_FLAGS.has(args[i - 1] as string)) return REDACTED
    let out = arg
    for (const s of values) out = out.replaceAll(s, REDACTED)
    return out
  })
}

/** A printable, redacted command line: `[...wrapper, java, ...args]` with display quoting. */
export function redactCommand(command: { java: string; args: readonly string[]; wrapper?: readonly string[]; secrets?: readonly string[] }): string {
  const argv = [...(command.wrapper ?? []), command.java, ...command.args]
  return redactArgs(argv, command.secrets)
    .map((a) => (a === REDACTED ? a : quoteForDisplay(a)))
    .join(' ')
}
