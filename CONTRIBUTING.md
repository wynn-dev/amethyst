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
