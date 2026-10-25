# Contributing

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, especially the **clean-room policy**:
do not read or copy code from other Minecraft launchers.

```sh
pnpm install
pnpm dev         # run the app with hot reload
pnpm test        # unit tests (offline)
pnpm typecheck
pnpm lint
```

Network-backed tests: `AMETHYST_NET_TESTS=1 pnpm test`.

## Checking the real app

Build first (`pnpm build`). Electron needs `ELECTRON_RUN_AS_NODE` unset; every mode below is
dev-only and uses a throwaway data root, never your real one.

```sh
# RPC smoke test: renderer ↔ main ↔ runtime, then quit (CI runs this too)
AMETHYST_SMOKE=1 pnpm --filter @amethyst/desktop exec electron .

# Screenshots of the key routes in light and dark
AMETHYST_SCREENSHOT=/tmp/shots pnpm --filter @amethyst/desktop exec electron .

# End-to-end UI drivers (real UI, real runtime, real network), screenshots in light and dark:
#   core     first run, offline account, New Instance, install, Play, logs, Stop (main/e2e-ui.ts)
#   content  Discover install, mods enable/disable/Trash/Undo, world import/backup/restore,
#            .mrpack import and export (main/e2e-content.ts)
AMETHYST_E2E_UI=core:/tmp/e2e-core pnpm --filter @amethyst/desktop exec electron .
AMETHYST_E2E_UI=content:/tmp/e2e-content pnpm --filter @amethyst/desktop exec electron .
```

`AMETHYST_E2E_UI=<dir>` without a prefix runs `core`. Set `AMETHYST_E2E_CACHE=<data root>` to
clone an existing data root's `minecraft/` and `runtimes/` folders in (APFS clones), so game files
are not downloaded again. The drivers print `E2E …` lines and exit non-zero when a step fails.
