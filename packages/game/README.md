# @amethyst/game

Version JSON model, `inheritsFrom` resolution, Apple Silicon natives planning, and launching
Minecraft on macOS (arm64). Pure Node, no Electron. Behaviour follows
[`docs/specs/launch.md`](../../docs/specs/launch.md); the "Apple Silicon native runtime" section
of [`docs/specs/DECISIONS.md`](../../docs/specs/DECISIONS.md) wins where they differ.

## Launch flow

```ts
const version = await resolveVersion(`${root}/versions`, '1.20.1-forge-47.4.28')
const plan = planNatives(version, { jvmArch: jvm.arch, osVersion: await macosProductVersion() })
if (!plan.ok) showError(plan.issues) // ENATIVES_UNAVAILABLE: no arm64 build for this version

const issues = await diagnose(version, root, { natives: plan, trustBefore: installLock.timestamp })
// …the installer repairs `issues`…

const nativesDir = nativesDirectory(`${root}/versions`, version.id, plan)
await extractNatives(plan, { librariesDir: `${root}/libraries`, nativesDir })
await prepareLegacyAssets({ assetsDir: `${root}/assets`, assets: version.assets, gameDir })

const command = await buildLaunchCommand(version, { java: jvm, dirs: root, gameDir, auth, natives: plan, nativesDir, launcherVersion })
log.info(redactCommand(command))
const game = await launch(command, { onLog, onReady, signal })
const result = await game.exited // { exitCode, signal, crashed, crashReportPath?, hsErrPath?, nativeLoadError? }
```

Rules are evaluated with the **selected JVM's** architecture, never `process.arch`.

## Apple Silicon natives matrix

What `planNatives` does on an **arm64 JVM**. On an **x86_64 JVM** (Rosetta) nothing is replaced and
the original natives are used.

| Minecraft (macOS libraries in Mojang's JSON) | LWJGL | What the plan does on arm64 |
|---|---|---|
| rd-132211 … 1.6.4, all classic/indev/infdev/alpha/beta | 2.9.0 | `lwjgl-platform` natives → Amethyst-built arm64 jar (extracted) |
| 13w42a … 1.7.2 | 2.9.1-nightly-20131017 | same |
| 13w47a … 1.7.4 | 2.9.1-nightly-20131120 | same |
| 1.7.5 … 1.7.10 (14w02a … 1.8-pre2) | 2.9.1 | same; twitch natives removed |
| 1.8 … 1.12.2 | 2.9.2-nightly-20140822 | same; twitch natives removed (1.8.x) |
| 1.0 … 1.12.2 | jinput-platform 2.0.5 | Amethyst arm64 jar if published, otherwise removed (controllers only) |
| 1.12 … 1.18.2 | — | `java-objc-bridge` 1.0.0 → 1.1 (universal `libjcocoa.dylib` inside the jar); its x86_64 natives jar removed |
| 1.12 … 1.13.2 | — | `text2speech` 1.10.x → 1.11.3; text2speech natives removed (no macOS entry anyway) |
| 1.8.2 … 1.16.5 | — | JNA 3.4.0 / 4.4.0 → 5.10.0 (first arm64 JNA is 5.7.0; objc-bridge 1.1 needs 5.10.0) |
| 17w43a … 1.13-pre3 | 3.1.2 | every `org.lwjgl` module → 3.3.1 jar + `natives-macos-arm64` jar on the classpath |
| 1.13 … 1.13.2 | 3.1.6 | same |
| 1.14 … 1.18.2 (1.14.3: 3.2.2) | 3.2.1 / 3.2.2 | same (3.2.2 entries are disallowed on macOS by Mojang's rules) |
| 1.19 … 26.x | 3.3.1+ | used as shipped (`natives-macos-arm64` already listed) |

Matching is by artifact family and version range (`org.lwjgl:*` below 3.3.0, `ca.weblite:java-objc-bridge`
below 1.1, …), so snapshots and loader JSON (Forge, NeoForge, Fabric, Quilt) are covered too. An
`org.lwjgl` 3.3+ module with only an x86_64 `natives-macos` jar (third-party JSON) gets an unpinned
`natives-macos-arm64` jar from Maven Central and a warning.

The pinned replacements live in [`src/natives/table.ts`](src/natives/table.ts) (sha1 from the Maven
`.sha1` sidecars, sizes from `Content-Length`; the LWJGL 3.3.1 values equal Mojang's 1.19 pins).
`AMETHYST_NET_TESTS=1 pnpm test` re-verifies them against Maven Central.

### LWJGL 2 arm64 artifacts built by CI

No arm64 LWJGL 2 natives exist upstream. A CI job in this repository builds them from source and
publishes them on a `natives-lwjgl2-*` GitHub release. The app consumes an
`Lwjgl2Arm64Source { baseUrl, artifacts: [{ name, version, url, sha256, size }] }` manifest
(`DEFAULT_LWJGL2_ARM64_SOURCE` is an empty placeholder until the first release, so LWJGL 2
versions report `ENATIVES_UNAVAILABLE` on arm64). Each jar holds **flat** arm64 (or universal)
libraries and is stored locally as
`libraries/dev/wynn/amethyst/natives/<name>/<version>/<name>-<version>-natives-macos-arm64.jar`.

| `name` | `version` (the upstream version it replaces) | Jar contents | Needed by |
|---|---|---|---|
| `lwjgl-platform` | `2.9.0` | `liblwjgl.dylib`, `openal.dylib` | rd-132211 … 13w41b (1.0–1.6.4, classic → beta) |
| `lwjgl-platform` | `2.9.1-nightly-20131017` | `liblwjgl.dylib`, `openal.dylib` | 13w42a … 1.7.2 |
| `lwjgl-platform` | `2.9.1-nightly-20131120` | `liblwjgl.dylib`, `openal.dylib` | 13w47a … 1.7.4 |
| `lwjgl-platform` | `2.9.1` | `liblwjgl.dylib`, `openal.dylib` | 14w02a … 1.8-pre2 (1.7.5–1.7.10) |
| `lwjgl-platform` | `2.9.2-nightly-20140822` | `liblwjgl.dylib`, `openal.dylib` | 1.8-pre3 … 1.12.2 |
| `jinput-platform` *(optional)* | `2.0.5` | `libjinput-osx.jnilib` | rd-132211 … 1.12.2 (controllers only) |

The list comes from evaluating every entry of `version_manifest_v2.json` with macOS rules; it is
also exported as `REQUIRED_LWJGL2_ARTIFACTS`. `openal.dylib` must keep that exact name (LWJGL 2
looks it up literally). The upstream 2.9.0/2.9.1 jars name the JNI library `liblwjgl.jnilib`; Java
8+ on macOS also finds `liblwjgl.dylib`. Each `liblwjgl.dylib` should be built from the matching
upstream revision so its JNI symbols match the version's `lwjgl.jar`.

## Notes

- **Natives directory**: `versions/<id>/<id>-natives-<jvmArch>`, rebuilt atomically (temp dir +
  rename) whenever the extracted library set changes, verified by sha1 otherwise. The `java`, `jna`,
  `lwjgl` and `netty` sub-folders (26.x) always exist.
- **Template variables**: one table for JVM and game arguments, except `${version_name}`, which is
  the Minecraft version on the JVM side (Forge's `-DignoreList=…,${version_name}.jar` must match the
  client jar on the classpath) and the leaf id on the game side. A lone empty known variable is
  dropped together with its `--flag` (`--clientId`, `--xuid`, `--quickPlay*`); unknown ones stay
  literal with a warning.
- **log4j**: the declared config must exist (`ELOG_CONFIG_MISSING` otherwise). Versions 1.7–1.18.0
  without a config (modern Forge sets `"logging": {}`) get `-Dlog4j2.formatMsgNoLookups=true`.
- **Process**: spawned without a shell; `detached: true` puts the game in its own process group
  and kills then signal the whole group. Secrets are redacted by position (`--accessToken`,
  `--session`) and by value in `redactCommand`.
