import { describe, expect, it } from 'vitest'
import { LogRing } from './log-buffer'

const line = (text: string) => ({ time: 0, level: 'INFO' as const, stream: 'stdout' as const, thread: null, logger: null, text })

describe('LogRing', () => {
  it('keeps the last `capacity` lines with increasing seqs', () => {
    const ring = new LogRing(3)
    for (let i = 0; i < 5; i++) ring.push(line(`l${i}`))
    expect(ring.size).toBe(3)
    expect(ring.firstSeq).toBe(2)
    expect(ring.nextSeq).toBe(5)
    const page = ring.since(0)
    expect(page.lines.map((l) => l.text)).toEqual(['l2', 'l3', 'l4'])
    expect(page.lines.map((l) => l.seq)).toEqual([2, 3, 4])
    expect(page.dropped).toBe(2)
    expect(page.nextSeq).toBe(5)
  })

  it('pages with since/limit and reports nothing new at the end', () => {
    const ring = new LogRing(10)
    for (let i = 0; i < 7; i++) ring.push(line(`l${i}`))
    const a = ring.since(2, 3)
    expect(a.lines.map((l) => l.text)).toEqual(['l2', 'l3', 'l4'])
    expect(a.nextSeq).toBe(5)
    expect(a.dropped).toBe(0)
    const b = ring.since(a.nextSeq, 100)
    expect(b.lines.map((l) => l.text)).toEqual(['l5', 'l6'])
    expect(ring.since(b.nextSeq).lines).toEqual([])
    expect(ring.tail(2).map((l) => l.text)).toEqual(['l5', 'l6'])
  })

  it('stays bounded under a flood and truncates huge lines', () => {
    const ring = new LogRing(5_000, 100)
    for (let i = 0; i < 100_000; i++) ring.push(line(i === 99_999 ? 'x'.repeat(10_000) : `line ${i}`))
    expect(ring.size).toBe(5_000)
    expect(ring.firstSeq).toBe(95_000)
    const last = ring.tail(1)[0]
    expect(last?.text.length).toBeLessThanOrEqual(101)
    expect(ring.since(0, 10).dropped).toBe(95_000)
  })
})
