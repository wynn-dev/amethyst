// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { formatArgs, parseArgs } from './args'

describe('argument lines', () => {
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(parseArgs('  -Xss2M   -Dfoo="a b" \'c d\' e\\ f ""')).toEqual(['-Xss2M', '-Dfoo=a b', 'c d', 'e f', ''])
    expect(parseArgs('')).toEqual([])
  })

  it('round-trips through formatArgs', () => {
    for (const args of [['-XX:+UseG1GC', '-Dname=My World', 'quote"inside', 'back\\slash', '']]) {
      expect(parseArgs(formatArgs(args))).toEqual(args)
    }
    expect(formatArgs(['-Xmx2G', 'a b'])).toBe('-Xmx2G "a b"')
  })
})
