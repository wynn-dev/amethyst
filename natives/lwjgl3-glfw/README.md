# Patched GLFW for LWJGL 3.3.1 (Apple Silicon)

Minecraft 1.13–1.18 use LWJGL 3.1/3.2, which have no arm64 macOS natives. On an arm64 JVM the
launcher upgrades every LWJGL module to the official **LWJGL 3.3.1** (Maven Central), the first
release with `natives-macos-arm64`. Its GLFW, however, does not work for these versions:

```
GLFW error 65548: Cocoa: Regular windows do not have icons on macOS
```

LWJGL 3.3.1 builds GLFW from a GLFW 3.4 development snapshot. In that snapshot `glfwSetWindowIcon`
on macOS reports `GLFW_FEATURE_UNAVAILABLE`, where GLFW 3.3 and older silently did nothing.
Minecraft before 1.19 calls `glfwSetWindowIcon` right after creating its window, while its
start-up GLFW error callback still treats every error as fatal. The game then shows a "please
update your drivers" dialog and never opens a window. Official GLFW 3.3.x cannot be used instead:
LWJGL 3.3.1 binds functions that only exist in GLFW 3.4 development builds (`glfwGetPlatform`,
`glfwInitAllocator`, …) and LWJGL-CI's additions.

This directory rebuilds **the same GLFW source** as LWJGL 3.3.1, with that one call made a silent
no-op, and packages it as a jar that replaces `org.lwjgl:lwjgl-glfw:3.3.1:natives-macos-arm64` on
the classpath. See `docs/specs/DECISIONS.md`, "Apple Silicon native runtime".

```
natives/lwjgl3-glfw/
  build.sh               fetch upstream at the pinned commit, patch, build, verify, package
  versions.sh            the pinned inputs (commit, official jar checksums)
  patches/               patches and their `series`; each file explains itself
  scripts/package.py     reproducible jar + manifest.json
  test/                  smoke test (GlfwSmoke.java, run.sh)
  NOTICE.txt             shipped in the jar, with GLFW's licence
```

## Which GLFW LWJGL 3.3.1 uses

- The official `lwjgl-glfw-3.3.1-natives-macos-arm64.jar` (sha1 `cac0d3f7…`) contains
  `macos/arm64/org/lwjgl/glfw/libglfw.dylib.git`, which reads
  **`97da62a027794d9ff0f4512268cb9a73a8fb5073`**. LWJGL-CI's GLFW workflow writes the first parent
  below its own "LWJGL CI configuration" commit into that file
  (`git log --first-parent HEAD~2..HEAD~1`). So the library was built from LWJGL-CI/glfw's
  `master`, which was that CI commit on top of upstream GLFW `97da62a0` ("Cocoa: Clarify comments
  on compatibility macros", 2022-02-09, a GLFW 3.4 development snapshot; `glfwGetVersionString()`
  reports `3.4.0 Cocoa NSGL Null EGL OSMesa monotonic dynamic`).
- `97da62a0` is on upstream GLFW's `master` branch, which is never rewritten. `build.sh` fetches
  exactly that commit from https://github.com/glfw/glfw. LWJGL-CI rebases its fork regularly, so
  the CI commit used in February 2022 is no longer reachable. Only three files of that commit are
  compiled on macOS (`src/egl_context.c`, `src/osmesa_context.c`, `src/vulkan.c`), and
  `patches/lwjgl-ci-library-overrides.patch` carries their changes. Those lines are identical in
  LWJGL-CI's own later copy of the commit (`c27b2d58`, February 2023).
- **Verification**, done on every build: `build.sh` checks that the official jar's `.git` file
  names the pinned commit, and that the exported symbol list of our library (`objdump
  --exports-trie`) is **identical** to the official library's (137 symbols, including LWJGL-CI's
  `_glfw_egl_library`, `_glfw_opengles_library`, `_glfw_mesa_library` and `_glfw_vulkan_library`, and
  `glfwGetEGLConfig`). Built without the icon patch and with LWJGL-CI's deployment target (11.0),
  the library also has the same string table as the official one, apart from the Objective-C
  protocol metadata that the newer SDK adds.

## Patches (`patches/series`, applied with `patch -p1 -F 0`)

| Patch | Why |
|---|---|
| `lwjgl-ci-library-overrides.patch` | The macOS-relevant part of LWJGL-CI's "LWJGL CI configuration" commit: `_glfw_*_library` overrides and `glfwGetEGLConfig`. Needed for an identical export list; inactive unless LWJGL is configured to use EGL, OSMesa or a custom Vulkan loader. |
| `cocoa-silent-window-icon.patch` | `_glfwSetWindowIconCocoa` no longer calls `_glfwInputError`: it does nothing, as in GLFW 3.3 (upstream `9a87c2a4` added the error). The argument checks in `window.c` are unchanged. |

### Audit of the other start-up calls

The GLFW calls that Minecraft 1.13.2, 1.14.4, 1.16.5, 1.17.1 and 1.18.2 make were listed from their
client jars (`javap`, every `invokestatic org/lwjgl/glfw/GLFW.glfw*`, 40 to 46 distinct functions)
and checked against the Cocoa code of `97da62a0`. Only `glfwSetWindowIcon` raises an error on
macOS 13+ arm64:

- **Window hints:** 1.13–1.16 set `CLIENT_API=OPENGL`, `CONTEXT_CREATION_API=NATIVE` and a 2.0
  context with `OPENGL_PROFILE=ANY` (a legacy context). 1.17–1.18 ask for 3.2 core with
  `OPENGL_FORWARD_COMPAT`. Both are valid on macOS. No version sets a `GLFW_COCOA_*` hint, and the
  defaults (`COCOA_RETINA_FRAMEBUFFER`, `COCOA_GRAPHICS_SWITCHING`, `COCOA_MENUBAR`,
  `COCOA_CHDIR_RESOURCES`) raise nothing.
- **Raw mouse motion:** 1.14.4 and later look up `glfwRawMouseMotionSupported` by reflection and only call
  `glfwSetInputMode(GLFW_RAW_MOUSE_MOTION)` when it returns true. On Cocoa it returns false
  without an error, so the `FEATURE_UNIMPLEMENTED` path in `_glfwSetRawMouseMotionCocoa` is never
  reached. `GLFW_CURSOR` modes work normally.
- **Monitors:** the IOKit monitor-name lookup that fails on Apple Silicon ("Failed to find service
  port for display") is only a fallback. On macOS 10.15+ GLFW uses `-[NSScreen localizedName]`.
  Monitors are also enumerated in `glfwInit`, where Minecraft only logs errors.
- **Others** (`glfwCreateWindow`, `glfwSwapInterval`, `glfwGetFramebufferSize`, `glfwGetWindowPos`,
  `glfwGetVideoModes`, `glfwSetWindowTitle`, `glfwGetKeyName` for valid keys, clipboard, cursor
  position, callbacks): no error paths that apply.

`test/GlfwSmoke.java` replays these calls. Against the official build it sees exactly one error,
the window icon one, and against ours none.

## Artifact

The jar is named `lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar`:

```
META-INF/MANIFEST.MF                              Implementation-Title: lwjgl-glfw, LWJGL-Platform: macos/arm64
META-INF/licenses/NOTICE.txt
META-INF/licenses/GLFW-LICENSE.txt
macos/arm64/org/lwjgl/glfw/libglfw.dylib          thin arm64, minos 13.0, ad-hoc signed
macos/arm64/org/lwjgl/glfw/libglfw.dylib.sha1     40 hex digits + CRLF, as in LWJGL's jars
```

**How LWJGL loads it.** The launcher puts this jar on the classpath *instead of* the official GLFW
natives jar (the `lwjgl-glfw-3.3.1.jar` Java jar stays). LWJGL 3.3.1's `Library.loadNative` finds
`macos/arm64/org/lwjgl/glfw/libglfw.dylib` on the classpath. Its `SharedLibraryLoader` extracts the
library to `<java.io.tmpdir>/lwjgl<user>/3.3.1-build-7/libglfw.dylib` and loads it from there.
On every launch it compares the extracted file with the classpath copy by CRC-32 and rewrites it
when they differ. `Library.checkHash` then compares the loaded file with the `libglfw.dylib.sha1`
resource, which is why the jar carries a correct `.sha1`.

This was chosen over extracting the library and passing `-Dorg.lwjgl.glfw.libname=<abs path>`
for three reasons. It needs no launch-argument changes and no extraction step. It works however
the game is launched. And LWJGL loads it through exactly the same path as every other module.
The trade-off: LWJGL's extract directory depends only on the LWJGL version, so it is shared
with Minecraft 1.19+ (official 3.3.1 GLFW). The two jars overwrite each other's extracted copy.
That is harmless, because the CRC check re-extracts on each launch. Only if two such games start
in the same instant could one load the other's file. A 1.19+ game loading ours is harmless. The
reverse would show the icon error again.

`manifest.json` has the same shape as the LWJGL 2 one (`GlfwArm64Source` in
`packages/game/src/natives/glfw.ts`):

```json
{
  "baseUrl": "https://github.com/wynn-dev/amethyst/releases/download/natives-lwjgl3-glfw-v<N>/",
  "artifacts": [
    { "name": "lwjgl-glfw", "version": "3.3.1",
      "file": "lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar",
      "url": "lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar",
      "sha256": "…", "size": 62116 }
  ]
}
```

`version` is the LWJGL version the library is built for. The launcher stores the jar as
`libraries/dev/wynn/amethyst/natives/lwjgl-glfw-patched/3.3.1/lwjgl-glfw-patched-3.3.1-natives-macos-arm64.jar`.
To pin a release, copy its `manifest.json` into `DEFAULT_GLFW_ARM64_SOURCE`, or load it and
validate it with `parseGlfwArm64Source`.

## Building locally

Requirements: macOS on Apple Silicon, Xcode (clang + SDK), `cmake`, `git`, `curl`, `python3`.

```sh
natives/lwjgl3-glfw/build.sh       # a few seconds; output in natives/lwjgl3-glfw/dist (git-ignored)
natives/lwjgl3-glfw/test/run.sh    # smoke test on JDK 17 (or pass a JAVA_HOME); opens small windows
```

`build.sh` fails if a patch does not apply exactly, if the library is not thin arm64 with minos 13.0,
if the official jar names a different commit, if the export lists differ, or if the icon error
string is still present. The jar is reproducible for a given toolchain (fixed timestamps and entry
order, `-ffile-prefix-map`). CI and a local machine with a different Xcode produce different bytes,
so the app must pin the CI release's `manifest.json`.

Environment: `WORK_DIR`, `OUT_DIR`, `NATIVES_TAG`, `NATIVES_BASE_URL`.

## Publishing (CI)

`.github/workflows/natives-lwjgl3-glfw.yml` runs on `macos-15` (arm64) for `workflow_dispatch` and
for pushes to `main` that touch `natives/lwjgl3-glfw/**`. It runs `build.sh`, checks the library
with `lipo` and its `.sha1`, runs the smoke test, and uploads the jar, `manifest.json` and the
licence texts to the release `natives-lwjgl3-glfw-v<run number>`. Hosted runners may lack an
accelerated OpenGL renderer, so a failing smoke test there does not block the release. The release
is created as a **pre-release** with `--latest=false`, so it never becomes the repository's "Latest"
release. These releases are inputs of shipped app builds and must never be deleted or edited.

## Licence

GLFW is under the zlib/libpng licence (`LICENSE.md` of the GLFW repository), shipped as
`META-INF/licenses/GLFW-LICENSE.txt` together with `NOTICE.txt`. LWJGL-CI's changes are part of its
GLFW fork, under the same licence. The same files are uploaded to each release.
