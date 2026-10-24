#!/usr/bin/env node
// Reports renderer chunk sizes (gzip) after `pnpm build` and enforces the entry budget from
// docs/specs/performance.md S4: ≤ 350 KB compressed JS and ≤ 60 KB compressed CSS loaded eagerly.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = join(import.meta.dirname, '../out/renderer')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const eager = new Set([...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]))

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const rows = readdirSync(join(root, 'assets'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => {
    const buf = readFileSync(join(root, 'assets', f))
    return { file: f, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, eager: eager.has(`assets/${f}`) }
  })
  .toSorted((a, b) => Number(b.eager) - Number(a.eager) || b.gzip - a.gzip)

const eagerJs = rows.filter((r) => r.eager && r.file.endsWith('.js')).reduce((a, r) => a + r.gzip, 0)
const eagerCss = rows.filter((r) => r.eager && r.file.endsWith('.css')).reduce((a, r) => a + r.gzip, 0)

for (const r of rows) console.log(`${r.eager ? 'entry' : 'lazy '}  ${kb(r.gzip).padStart(9)} gzip  ${kb(r.raw).padStart(9)} raw  ${r.file}`)
console.log(`\nEager JS: ${kb(eagerJs)} gzip (budget 350 KB). Eager CSS: ${kb(eagerCss)} gzip (budget 60 KB).`)
if (eagerJs > 350 * 1024 || eagerCss > 60 * 1024) {
  console.error('Renderer entry exceeds its budget.')
  process.exit(1)
}
