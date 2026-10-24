# LWJGL 2 natives for Apple Silicon

Minecraft 1.12.2 and older use LWJGL 2. Mojang only ships its macOS natives for `i386`/`x86_64`
(and `ppc` for jinput), so an arm64 JVM cannot load them. Amethyst builds arm64 replacements
**from public upstream source** in CI, publishes them on its own GitHub release, and pins their
sha256 in the app (see `docs/specs/DECISIONS.md`, "Apple Silicon native runtime", and
`docs/specs/launch.md` §12). No third-party prebuilt native binaries are used.

```
natives/lwjgl2/
  build.sh               clone upstream at pinned commits, patch, compile, verify, package
  versions.sh            the pinned inputs (commits, JDK, checksums)
  patches/compat/        force-included header (+ a JavaVM/jawt_md.h shim)
  patches/lwjgl/         LWJGL patches and their `series` (which versions get which patch)
  scripts/check_jni.py   JNI compatibility check against Mojang's Java jars
  scripts/package.py     reproducible jars + manifest.json
  test/                  local smoke test (LwjglSmoke.java, run.sh)
  NOTICE.txt             shipped in every jar, with the licence texts
```

## What is built

Every macOS native library that Mojang's version JSONs select on macOS 13+ for Minecraft
≤ 1.12.2. The list comes from a scan of all 402 manifest entries released up to 1.13, with the
`rules` evaluated for macOS 13+:

| Artifact (manifest `name` / `version`) | Jar contents (flat) | Minecraft versions (manifest ids) |
|---|---|---|
| `lwjgl-platform` `2.9.0` | `liblwjgl.dylib`, `openal.dylib` | rd-132211 … 13w41b: every classic/indev/infdev/alpha/beta and 1.0–1.6.4 |
| `lwjgl-platform` `2.9.1-nightly-20131017` | `liblwjgl.dylib`, `openal.dylib` | 13w42a … 1.7.2 |
| `lwjgl-platform` `2.9.1-nightly-20131120` | `liblwjgl.dylib`, `openal.dylib` | 13w47a … 1.7.4 (1.7.3, 1.7.4) |
| `lwjgl-platform` `2.9.1` | `liblwjgl.dylib`, `openal.dylib` | 14w02a … 1.8-pre2 (1.7.5–1.7.10) |
| `lwjgl-platform` `2.9.2-nightly-20140822` | `liblwjgl.dylib`, `openal.dylib` | 1.8-pre3 … 1.12.2 (1.8–1.12.2) |
| `jinput-platform` `2.0.5` | `libjinput-osx.jnilib` | rd-132211 … 1.12.2 (controllers only) |

The jars are named `<name>-<version>-natives-osx-arm64.jar`. All libraries are thin `arm64`,
`minos 13.0`, ad-hoc signed. Each jar also carries `META-INF/MANIFEST.MF` and
`META-INF/licenses/*`, which must not be extracted (exclude `META-INF/`, as for Mojang's jars).

Mojang's other LWJGL 2 versions are never selected on modern macOS:
`2.9.1-nightly-20130708-debug3` is limited to macOS 10.5 (`^10\.5\.\d$`), and `2.9.3` and
`2.9.4-nightly-20150209` are disallowed on `osx`.

Not built here:

- `ca.weblite:java-objc-bridge:1.0.0:natives-osx` (1.12–1.12.2 and 17w snapshots, used by the
  1.12 narrator through text2speech) is `x86_64` only. The upstream author's
  `ca.weblite:java-objc-bridge:1.1` on Maven Central already contains a universal
  (`x86_64 arm64`, minos 11.0) `libjcocoa.dylib` inside the main jar, so the launcher can swap the
  library and drop the 1.0.0 natives (as `launch.md` §12.3 says).
- `tv.twitch:twitch-platform` (1.7.3–1.8.9) is a proprietary SDK without source; Minecraft
  carries on without it, so the launcher drops it.

### Why one build per LWJGL version

The JNI symbols must match the Java classes of each version, and they do not match across
versions: for example `MacOSXDisplay.nCreateWindow` and `MacOSXCanvasPeerInfo.nInitHandle` take
different arguments in 2.9.0/2.9.1-nightly-20131017 than in 2.9.1 and later. A JNI symbol name
does not encode the signature, so a mismatch would be a crash, not a link error. Each version is
therefore built from the upstream commit that Mojang's binaries came from.

The commit for each version was identified from the build timestamps inside Mojang's jars
(`lwjgl-<v>.jar`, `lwjgl-platform-<v>-natives-osx.jar`) and the upstream history, then
**verified** by `scripts/check_jni.py` on every build: for each `native` method in Mojang's
official `org.lwjgl.lwjgl:lwjgl:<v>` jar (except the Linux/Windows back ends) the method must be
declared with the same descriptor by the upstream source we compiled, and the library must
export its JNI symbol (or register it through `initNativeStubs`/`RegisterNatives`, as LWJGL does
for OpenAL/OpenCL). The same check runs for JInput's OS X plugin.

`2.9.1-nightly-20131120` and `2.9.1` differ only in Java code; their native sources are identical,
so their jars are byte-identical. Both are published so the launcher can match versions exactly.

## Upstream sources (pinned in `versions.sh`)

| Component | Repository | Commit |
|---|---|---|
| LWJGL 2.9.0 | https://github.com/LWJGL/lwjgl | `8deac76a5b374ce2f1011c772f989c3368c935d6` (tag `lwjgl2.9.0`) |
| LWJGL 2.9.1-nightly-20131017 | 〃 | `eb85196a0cc6e5e5cc5c31dcaa6c51f50d0a057c` (2013-10-13) |
| LWJGL 2.9.1-nightly-20131120 | 〃 | `5c288b8d75e912441b1a41a6cd8ac82ede564711` (2013-11-16) |
| LWJGL 2.9.1 | 〃 | `e7f46b99e2dafde0058126095b14cc758b32ae28` (tag `lwjgl2.9.1`) |
| LWJGL 2.9.2-nightly-20140822 | 〃 | `30412de2295aa70658524d397aad557cdca63d64` (2014-08-16) |
| LWJGL code generator (all versions) | 〃 | `e08c0fbf5693f3247a0657f75bca6373e71bc0a2` (see below) |
| JInput 2.0.5 | https://github.com/jinput/jinput | `87e7d8df2f006402e4df74b754ee2e7ca4c5fd9a` (2011-03-23) |
| OpenAL Soft 1.25.2 | https://github.com/kcat/openal-soft | `b2c48f7718ef3fcf67921a8b6534c4914e328970` (tag `1.25.2`) |
| Build JDK: Azul Zulu 8u512 (arm64) | https://cdn.azul.com/zulu/bin/ | sha256 `f26e2a91…5892aa` |

**Code generator.** LWJGL 2 generates most of its JNI code (GL, AL, CL bindings) from Java
templates. All five commits predate LWJGL's move from `apt` (`com.sun.mirror`, removed in
JDK 8) to javac annotation processing. `build.sh` swaps in the generator of `e08c0fbf`, the commit
that completed that port ("Fixed field/method order so that javac output matches apt output"),
and applies the two mechanical template changes from the same port (apt's
`PrimitiveType.Kind.INT` → `TypeKind.INT`; the `EXT_Cg_shader.java` file name, upstream
`a570c1c0`). The generator itself did not change between 2.9.0 and the port. It runs on JDK 8:
from JDK 9 on, javac refuses to let a processor generate a type with the same name as a template.
`check_jni.py` is what proves that the generated code matches Mojang's classes.

**OpenAL.** Mojang's `lwjgl-platform` jars bundle OpenAL Soft as `openal.dylib`; LWJGL's
`AL.create()` looks for exactly that file name in `java.library.path` and only falls back to
Apple's deprecated `OpenAL.framework` when it is missing. We build OpenAL Soft (CoreAudio back
end only, HRTF data embedded) as `openal.dylib` and bundle it in every `lwjgl-platform` jar.

## Patches

The build follows upstream's `platform_build/macosx_ant/build.xml` (same sources, flags,
frameworks, exported-symbol list) but with `-arch arm64 -mmacosx-version-min=13.0`, the JDK's JNI
headers instead of `JavaVM.framework`, and `javah` from JDK 8. The source changes are:

**`patches/compat/lwjgl2_compat.h`** (force-included into every LWJGL source with `-include`):

- re-declares `CGGetLastMouseDelta`/`CGMouseDelta` and `CGDisplayBitsPerPixel`, which recent SDKs
  removed from their headers but CoreGraphics still exports (checked at link time against the SDK
  stubs);
- defines Apple Java 6's `JAWT_MacOSXDrawingSurfaceInfo` (only used on LWJGL's legacy,
  non-CALayer canvas path, which OpenJDK never takes);
- provides `amethyst_run_on_main()` and `AMETHYST_MAIN_THREAD_MODES` for the main-thread patches.

`patches/compat/include/JavaVM/jawt_md.h` forwards `<JavaVM/jawt_md.h>` to the JDK's `jawt_md.h`.

**`patches/lwjgl/`** (applied per `series`, `patch -p1 -F 0`; each file explains itself):

| Patch | Versions | Why |
|---|---|---|
| `hidpi-direct-call.patch` | 2.9.1-nightly-20131120, 2.9.1, 2.9.2-nightly-20140822 | `performSelector:withObject:YES` passed a BOOL as an object; modern clang rejects it. Calls `setWantsBestResolutionOpenGLSurface:` directly. |
| `mainthread-context.patch` | all | Current macOS traps when `NSOpenGLContext -setView:`, `-update`, `-clearDrawable` run off the main thread ("must be called from the main thread"); LWJGL called them from the game thread. Without it `Display.create()` dies with SIGTRAP. LWJGL calls `-update` on every `Display.update()`, so each frame now waits for the main thread; measured cost is negligible (0.47 ms for a whole clear+update frame with vsync off). |
| `mainthread-awt-run-loop-mode.patch` | all | LWJGL's blocking `performSelectorOnMainThread` calls now also run in AWT's `AWTRunLoopMode`, fixing a reproducible three-way deadlock in `Display.create()` on the AWT canvas path (Minecraft ≤ 1.5.2's applet frame). |
| `window-delayed-release.patch` | all | A window closed by `Display.destroy()`/a display-mode change was freed while AppKit still had a tracking-area update queued for it: intermittent SIGSEGV in `objc_msgSend` (NSZombie: `-[MacOSXKeyableWindow windowNumber]: message sent to deallocated instance`, ~1 in 5 runs of the fullscreen toggle). The hidden offscreen window of the `Display.setParent` (CALayer) path is closed the same way and crashed once in `__NSThreadPerformPerform`. Both are now released 2 s later on the main run loop. |

No patches are needed for JInput or OpenAL Soft. OpenAL Soft is configured with
`-DHAVE_WFUNCTION_EFFECTS=OFF` because it promotes clang's `-Wfunction-effects` to an error, which
the macOS 27 SDK's `nonblocking` CoreAudio callback type triggers (a diagnostic only).

## Building locally

Requirements: macOS on Apple Silicon, Xcode (clang + SDK), `cmake` (`brew install cmake`), `git`,
`curl`, `python3`. A JDK 8 is downloaded (pinned Zulu 8, sha256-checked) unless `JAVA8_HOME` is set.

```sh
natives/lwjgl2/build.sh          # ~2 minutes; output in natives/lwjgl2/dist (git-ignored)
natives/lwjgl2/test/run.sh       # smoke test, opens small windows; see below
```

`build.sh` fails if a patch does not apply exactly, a library is not thin arm64 with minos 13.0,
or the JNI check finds a problem. Jars are reproducible for a given toolchain (fixed timestamps
and entry order; `-ffile-prefix-map`); CI and a local machine with a different Xcode produce
different bytes, so the app must pin the CI release's `manifest.json`.

Environment: `WORK_DIR`, `OUT_DIR`, `NATIVES_TAG`, `NATIVES_BASE_URL`, `JAVA8_HOME`,
`LWJGL_VERSIONS` (subset, for development), `REUSE_OPENAL=1` / `LWJGL_REUSE_JAVA=1`
(development shortcuts that skip rebuilding OpenAL Soft / regenerating the Java side).

## Smoke test

`test/run.sh [JAVA_HOME...]` uses each built jar the way a launcher does: it extracts the
`lwjgl-platform` and `jinput-platform` jars flat (without `META-INF/`) into one directory, puts
Mojang's official `lwjgl-<v>.jar`, `jinput-2.0.5.jar` and `jutils-1.0.0.jar` on the classpath
(sha1-checked) and runs `test/LwjglSmoke.java` with `-Djava.library.path` set, for every version,
on the JDK 8 from the build and on `java_home -v 17`. Checks:

- `window`: `Display.create()`, clear to a colour, read the pixel back; keyboard/mouse created.
- `game`: resizable window, display-mode change, title, mouse grab, native cursor, fullscreen and
  back (LWJGL re-creates the window each time).
- `input`: `java.awt.Robot` key press, mouse move and click arrive through
  `Keyboard.next()`/`Mouse.next()` (needs the Accessibility permission for the terminal).
- `canvas`: `Display.setParent()` on an AWT `Canvas` in a `Frame` (Minecraft ≤ 1.5.2).
- `al`: `AL.create()` loads the bundled `openal.dylib` and plays a short, quiet tone.
- `jinput`: JInput's OS X plugin loads `libjinput-osx.jnilib` and lists controllers.

## Publishing (CI)

`.github/workflows/natives-lwjgl2.yml` runs on `macos-15` (arm64) for `workflow_dispatch` and for
pushes to `main` that touch `natives/lwjgl2/**`. It runs `build.sh`, checks every library with
`lipo`, and uploads the jars, `manifest.json` and the licence texts to the release
`natives-lwjgl2-v<run number>` (created as a pre-release with `--latest=false`, so it never
becomes the repository's "Latest" release). These releases are inputs of shipped app builds and must never be
deleted or edited; the nightly app workflow must only touch the `nightly` tag.

## How the launcher consumes it

`manifest.json` has the shape of `Lwjgl2Arm64Source` in `packages/game/src/natives/lwjgl2.ts`:

```json
{
  "baseUrl": "https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl2-v<N>/",
  "artifacts": [
    { "name": "lwjgl-platform", "version": "2.9.2-nightly-20140822",
      "file": "lwjgl-platform-2.9.2-nightly-20140822-natives-osx-arm64.jar",
      "url": "lwjgl-platform-2.9.2-nightly-20140822-natives-osx-arm64.jar",
      "sha256": "…", "size": 732106 }
  ]
}
```

`url` is relative to `baseUrl` (`file` is the same name, for humans). To pin a release, copy its
`manifest.json` into the app's `DEFAULT_LWJGL2_ARM64_SOURCE` (or load it and validate it with
`parseLwjgl2Arm64Source`). With an arm64 JVM, the launcher replaces each
`org.lwjgl.lwjgl:lwjgl-platform:<version>` / `net.java.jinput:jinput-platform:2.0.5` natives entry
with the artifact of the same `name` and `version`, verifies sha256 and size, and extracts it like
any old-style natives jar (flat, excluding `META-INF/`). Mojang's `lwjgl`/`lwjgl_util`/`jinput`
Java jars stay on the classpath unchanged; the natives are built to match them.

## Licences

- LWJGL: BSD 3-clause (`doc/LICENSE` of the LWJGL repository) → `META-INF/licenses/LWJGL-LICENSE.txt`.
- OpenAL Soft: GNU LGPL v2 or later (`COPYING`) → `META-INF/licenses/OpenAL-Soft-COPYING.txt`. It
  is unmodified and built as a separate shared library; the corresponding source is the pinned
  upstream tag, and `build.sh` rebuilds it.
- JInput: BSD-style (the text LWJGL ships as `doc/3rdparty/jinput_license.txt`) →
  `META-INF/licenses/JInput-LICENSE.txt`.
- `NOTICE.txt` describes the contents. The same files are uploaded to each release under their
  own names.
