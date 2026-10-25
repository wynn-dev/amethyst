/**
 * Main-process timestamps for the benchmark (`AMETHYST_BENCH`, see `main/bench.ts`). Recording is
 * a no-op unless the benchmark is running, so this module stays in the startup path at no cost.
 */
export const benchEnabled = !!process.env.AMETHYST_BENCH

/** Epoch ms (sub-millisecond precision) of each first occurrence. */
export const mainMarks: Record<string, number> = {}

export function mainMark(name: string): void {
  if (benchEnabled) mainMarks[name] ??= performance.timeOrigin + performance.now()
}
