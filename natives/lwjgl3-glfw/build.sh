#!/usr/bin/env bash
#
# Builds a patched libglfw.dylib (arm64, macOS 13+) for LWJGL 3.3.1 from public upstream source,
# so that Minecraft 1.13-1.18 can open a window on an arm64 JVM, and packages it as a classpath
# natives jar plus manifest.json. See README.md.
#
#   natives/lwjgl3-glfw/build.sh       # into natives/lwjgl3-glfw/dist
#
# Environment (all optional):
#   WORK_DIR          scratch dir (default natives/lwjgl3-glfw/build)
#   OUT_DIR           output dir  (default natives/lwjgl3-glfw/dist)
#   NATIVES_TAG       release tag the artifacts will be uploaded to (default natives-lwjgl3-glfw-v1)
#   NATIVES_BASE_URL  baseUrl written to manifest.json (default: this repo's release for $NATIVES_TAG)
#
# Requirements: macOS on arm64 with Xcode (clang, SDK), cmake, git, curl, python3.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK_DIR:-$HERE/build}"
OUT="${OUT_DIR:-$HERE/dist}"
NATIVES_TAG="${NATIVES_TAG:-natives-lwjgl3-glfw-v1}"
NATIVES_BASE_URL="${NATIVES_BASE_URL:-https://github.com/wynn-dev/amethyst/releases/download/$NATIVES_TAG/}"
PATCHES="$HERE/patches"

ARCH=arm64
MIN_MACOS=13.0
SDK="$(xcrun --sdk macosx --show-sdk-path)"
JOBS="$(sysctl -n hw.ncpu)"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-315532800}"
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
export ZERO_AR_DATE=1

# shellcheck source=versions.sh
. "$HERE/versions.sh"

# Where LWJGL's SharedLibraryLoader looks for the library on the classpath (bundled path of module
# org.lwjgl.glfw for macos/arm64), and the published jar name. The jar replaces Maven Central's
# org.lwjgl:lwjgl-glfw:3.3.1:natives-macos-arm64 on the classpath.
JAR_LIB_PATH=macos/arm64/org/lwjgl/glfw/libglfw.dylib
JAR_NAME="lwjgl-glfw-patched-$LWJGL_VERSION-natives-macos-arm64.jar"

# ---------------------------------------------------------------------------------------------

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in clang cmake git curl python3 shasum lipo otool objdump strip codesign patch unzip; do
  command -v "$tool" > /dev/null || die "missing tool: $tool"
done
[ "$(uname -s)" = Darwin ] || die "macOS only"

mkdir -p "$WORK" "$WORK/downloads"

# Fetch a URL into downloads/ and verify it (sha1 or sha256 by length).
fetch() { # <url> <hash> -> prints path
  local url="$1" hash="$2" f
  f="$WORK/downloads/$(basename "$url")"
  if [ ! -f "$f" ]; then
    curl -fsSL --retry 3 -o "$f.tmp" "$url"
    mv "$f.tmp" "$f"
  fi
  local algo=256
  [ "${#hash}" = 40 ] && algo=1
  echo "$hash  $f" | shasum -a "$algo" -c - > /dev/null || { rm -f "$f"; die "checksum mismatch: $url"; }
  echo "$f"
}

# Apply the patches listed in a series file, in order. Patches must apply exactly (no fuzz).
apply_patches() { # <dir> <series file>
  local dir="$1" series="$2" p
  while read -r p; do
    case "$p" in '' | '#'*) continue ;; esac
    echo "    patch $p"
    patch -d "$dir" -p1 -N -s -F 0 -i "$(dirname "$series")/$p" || die "patch failed: $p"
  done < "$series"
}

assert_arm64() { # <file>
  local archs minos
  archs="$(lipo -archs "$1")"
  [ "$archs" = arm64 ] || die "$1 is '$archs', expected arm64"
  minos="$(otool -l "$1" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
  [ "$minos" = "$MIN_MACOS" ] || die "$1 has minos '$minos', expected $MIN_MACOS"
}

# Exported symbols of a Mach-O dylib, sorted (works on stripped libraries too).
exports_of() { # <dylib>
  objdump --macho --exports-trie "$1" | awk '$1 ~ /^0x/ {print $2}' | sort
}

# ---------------------------------------------------------------------------------------------
# Source: upstream GLFW at the pinned commit (a shallow fetch of exactly that commit; git checks
# the object id), plus our patches.
# ---------------------------------------------------------------------------------------------
SRC="$WORK/glfw"
log "GLFW @ $GLFW_COMMIT"
REPO="$WORK/glfw.git"
if [ ! -d "$REPO" ]; then
  git init --quiet --bare "$REPO"
fi
if ! git --git-dir="$REPO" cat-file -e "$GLFW_COMMIT^{commit}" 2> /dev/null; then
  git --git-dir="$REPO" fetch --quiet --depth 1 "$GLFW_REPO" "$GLFW_COMMIT"
fi
rm -rf "$SRC"
mkdir -p "$SRC"
git --git-dir="$REPO" archive "$GLFW_COMMIT" | tar -x -C "$SRC"
apply_patches "$SRC" "$PATCHES/series"

# ---------------------------------------------------------------------------------------------
# Build. Same CMake options as LWJGL-CI's macOS job (GLFW_PARAMS in its lwjgl.yml), except the
# deployment target: 13.0 (Amethyst's minimum) instead of 11.0.
# ---------------------------------------------------------------------------------------------
log "Building libglfw.dylib"
B="$WORK/glfw-build"
rm -rf "$B"
cmake -S "$SRC" -B "$B" -G "Unix Makefiles" \
  -DGLFW_LIBRARY_TYPE=SHARED -DGLFW_BUILD_EXAMPLES=OFF -DGLFW_BUILD_TESTS=OFF -DGLFW_BUILD_DOCS=OFF \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
  -DCMAKE_OSX_SYSROOT="$SDK" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$SRC=." \
  > "$WORK/cmake.log" 2>&1 || { cat "$WORK/cmake.log"; die "GLFW configure failed"; }
cmake --build "$B" -j "$JOBS" > "$WORK/build.log" 2>&1 || { tail -50 "$WORK/build.log"; die "GLFW build failed"; }
lib="$(find "$B/src" -maxdepth 1 -name 'libglfw.*.*.dylib' -type f | head -n 1)"
[ -n "$lib" ] || die "libglfw not found"
LIB="$WORK/libglfw.dylib"
cp "$lib" "$LIB"
# As LWJGL-CI does. The install name stays @rpath/libglfw.3.dylib like the official build; LWJGL
# loads the library by path, so it does not matter.
strip -u -r "$LIB"
codesign --force --sign - "$LIB" 2> /dev/null
assert_arm64 "$LIB"

# ---------------------------------------------------------------------------------------------
# Verify against the official LWJGL 3.3.1 build.
# ---------------------------------------------------------------------------------------------
log "Checking against the official LWJGL $LWJGL_VERSION libglfw.dylib"
official_jar="$(fetch "$OFFICIAL_GLFW_NATIVES_JAR" "$OFFICIAL_GLFW_NATIVES_SHA1")"
O="$WORK/official"
rm -rf "$O"
mkdir -p "$O"
unzip -q "$official_jar" "$JAR_LIB_PATH" "$JAR_LIB_PATH.git" -d "$O"
official_rev="$(tr -d '\r\n' < "$O/$JAR_LIB_PATH.git")"
[ "$official_rev" = "$GLFW_COMMIT" ] || die "official jar was built from $official_rev, versions.sh pins $GLFW_COMMIT"
# Same exported API: LWJGL 3.3.1 looks up every function it binds by name.
exports_of "$O/$JAR_LIB_PATH" > "$WORK/exports.official.txt"
exports_of "$LIB" > "$WORK/exports.ours.txt"
[ "$(wc -l < "$WORK/exports.official.txt")" -gt 100 ] || die "could not read the official export list"
if ! diff -u "$WORK/exports.official.txt" "$WORK/exports.ours.txt"; then
  die "exported symbols differ from the official LWJGL $LWJGL_VERSION build"
fi
echo "    exports: identical ($(wc -l < "$WORK/exports.ours.txt" | tr -d ' ') symbols)"
# The window icon patch is in (the message only exists in the unpatched code).
icon_msg='Regular windows do not have icons'
grep -q "$icon_msg" "$O/$JAR_LIB_PATH" || die "official library lacks the window icon error; check the patch rationale"
if grep -q "$icon_msg" "$LIB"; then die "window icon patch not applied"; fi
echo "    glfwSetWindowIcon: no longer reports an error"

# ---------------------------------------------------------------------------------------------
# Package
# ---------------------------------------------------------------------------------------------
log "Packaging into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/licenses" "$WORK/licenses"
cp "$SRC/LICENSE.md" "$WORK/licenses/GLFW-LICENSE.txt"
cp "$HERE/NOTICE.txt" "$WORK/licenses/NOTICE.txt"
# LWJGL's Library.checkHash compares the loaded file with the `<lib>.sha1` resource on the
# classpath. Same format as LWJGL's own jars: 40 hex digits and CRLF.
printf '%s\r\n' "$(shasum -a 1 "$LIB" | cut -d' ' -f1)" > "$WORK/libglfw.dylib.sha1"
python3 -I "$HERE/scripts/package.py" jar "$OUT/$JAR_NAME" \
  "$JAR_LIB_PATH=$LIB" \
  "$JAR_LIB_PATH.sha1=$WORK/libglfw.dylib.sha1" \
  "META-INF/licenses/NOTICE.txt=$WORK/licenses/NOTICE.txt" \
  "META-INF/licenses/GLFW-LICENSE.txt=$WORK/licenses/GLFW-LICENSE.txt"
cp "$WORK"/licenses/*.txt "$OUT/licenses/"
python3 -I "$HERE/scripts/package.py" manifest "$OUT/manifest.json" "$NATIVES_BASE_URL" \
  "lwjgl-glfw:$LWJGL_VERSION:$OUT/$JAR_NAME"

log "Done"
printf '  %s  %s\n' "$(shasum -a 256 "$OUT/$JAR_NAME" | cut -c1-16)…" "$JAR_NAME"
echo "  $OUT/manifest.json"
