/**
 * A bounded ring buffer of game output lines. Each line gets an increasing `seq`, so a log view
 * can page with "everything after seq N" and learn how many lines it missed when the buffer
 * wrapped. Memory is bounded by `capacity` lines of at most `maxLineChars` characters each.
 */
import type { GameLogLine } from '@shared/services'

export const DEFAULT_LOG_CAPACITY = 5_000
export const MAX_LINE_CHARS = 8_192

export class LogRing {
  readonly capacity: number
  readonly #maxChars: number
  readonly #lines: (GameLogLine | undefined)[]
  /** Index of the oldest line. */
  #head = 0
  #count = 0
  #nextSeq = 0

  constructor(capacity = DEFAULT_LOG_CAPACITY, maxLineChars = MAX_LINE_CHARS) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.#maxChars = maxLineChars
    this.#lines = Array.from({ length: this.capacity })
  }

  get size(): number {
    return this.#count
  }

  /** The seq the next line will get. */
  get nextSeq(): number {
    return this.#nextSeq
  }

  /** The seq of the oldest line still held. */
  get firstSeq(): number {
    return this.#nextSeq - this.#count
  }

  /** Append a line (its text is truncated to the line limit); returns it with its seq. */
  push(line: Omit<GameLogLine, 'seq'>): GameLogLine {
    const text = line.text.length > this.#maxChars ? `${line.text.slice(0, this.#maxChars)}…` : line.text
    const entry: GameLogLine = { ...line, text, seq: this.#nextSeq++ }
    const index = (this.#head + this.#count) % this.capacity
    this.#lines[index] = entry
    if (this.#count < this.capacity) this.#count++
    else this.#head = (this.#head + 1) % this.capacity
    return entry
  }

  /** Lines with `seq >= since`, oldest first, at most `limit`. `dropped` counts wanted lines that were overwritten. */
  since(since = 0, limit = 1_000): { lines: GameLogLine[]; nextSeq: number; dropped: number } {
    const first = this.firstSeq
    const from = Math.max(since, first)
    const dropped = Math.max(0, first - Math.max(0, since))
    const n = Math.max(0, Math.min(limit, this.#nextSeq - from))
    const lines: GameLogLine[] = []
    for (let i = 0; i < n; i++) {
      const offset = from - first + i
      lines.push(this.#lines[(this.#head + offset) % this.capacity] as GameLogLine)
    }
    return { lines, nextSeq: from + n, dropped }
  }

  /** The last `n` lines. */
  tail(n: number): GameLogLine[] {
    return this.since(Math.max(this.firstSeq, this.#nextSeq - n), n).lines
  }
}
