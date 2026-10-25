/**
 * User-timing marks on the startup path (`amethyst:<name>`), read by the benchmark
 * (`AMETHYST_BENCH`, see docs/PERFORMANCE.md). Each name is marked once per page load; a mark
 * costs a few microseconds and nothing else listens to them.
 */
const marked = new Set<string>()

export function markOnce(name: string): void {
  if (marked.has(name)) return
  marked.add(name)
  performance.mark(`amethyst:${name}`)
}
