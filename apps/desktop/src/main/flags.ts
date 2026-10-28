/**
 * Test-only switches of the main process.
 *
 * `AMETHYST_SMOKE` (run the RPC smoke check against a throwaway data root, then quit),
 * `AMETHYST_DISABLE_UPDATES` and `AMETHYST_BENCH` (run the benchmark in a seeded data root) change
 * what the app does, so in a packaged build an environment variable alone must not turn them on:
 * anything that can set the environment of a user's login session (a launchd plist, a shell
 * profile) could otherwise silently disable updates or swap the data root. A packaged app honours
 * them only together with a matching command-line flag, which CI and the bench harness pass and a
 * Finder or Dock launch never does. Unpackaged (dev) runs only need the variable.
 */

export const SMOKE_FLAG = '--amethyst-smoke'
export const DISABLE_UPDATES_FLAG = '--amethyst-disable-updates'
export const BENCH_FLAG = '--amethyst-bench'

export interface FlagSource {
  env: Record<string, string | undefined>
  argv: readonly string[]
  packaged: boolean
}

const guarded = (src: FlagSource, on: boolean, flag: string) => on && (!src.packaged || src.argv.includes(flag))

/** Whether this run is the CI smoke test. */
export function isSmokeRun(src: FlagSource): boolean {
  return guarded(src, !!src.env.AMETHYST_SMOKE, SMOKE_FLAG)
}

/** Whether automatic updates were switched off for this run. */
export function updatesDisabled(src: FlagSource): boolean {
  return guarded(src, src.env.AMETHYST_DISABLE_UPDATES === '1', DISABLE_UPDATES_FLAG)
}

/** The benchmark's output file, when this run is the benchmark (`AMETHYST_BENCH=<out.json>`). */
export function benchOutput(src: FlagSource): string | undefined {
  return guarded(src, !!src.env.AMETHYST_BENCH, BENCH_FLAG) ? src.env.AMETHYST_BENCH : undefined
}
