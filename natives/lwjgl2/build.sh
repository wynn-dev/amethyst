#!/usr/bin/env bash
#
# Builds the Apple Silicon (arm64, macOS 13+) natives that Minecraft <= 1.12.2 needs, from public
# upstream source, and packages them as jars plus manifest.json. See README.md.
#
#   natives/lwjgl2/build.sh            # everything, into natives/lwjgl2/dist
#
# Environment (all optional):
#   WORK_DIR          scratch dir (default natives/lwjgl2/build)
#   OUT_DIR           output dir  (default natives/lwjgl2/dist)
#   NATIVES_BASE_URL  baseUrl written to manifest.json (default: this repo's release for $NATIVES_TAG)
#   NATIVES_TAG       release tag the artifacts will be uploaded to (default natives-lwjgl2-v1)
#   JAVA8_HOME        a JDK 8 (arm64). If unset, a pinned Zulu 8 is downloaded and sha256-checked.
#   LWJGL_VERSIONS    space-separated subset of the LWJGL versions (development)
#   REUSE_OPENAL=1    keep an already built openal.dylib (development)
#   LWJGL_REUSE_JAVA=1  keep the generated/compiled LWJGL Java side, rebuild only the natives
#                     (development; use after editing patches)
#
# Requirements: macOS on arm64 with Xcode (clang, SDK), cmake, git, curl, python3.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK_DIR:-$HERE/build}"
OUT="${OUT_DIR:-$HERE/dist}"
NATIVES_TAG="${NATIVES_TAG:-natives-lwjgl2-v1}"
NATIVES_BASE_URL="${NATIVES_BASE_URL:-https://github.com/wynn-dev/amethyst/releases/download/$NATIVES_TAG/}"
PATCHES="$HERE/patches"

ARCH=arm64
MIN_MACOS=13.0
SDK="$(xcrun --sdk macosx --show-sdk-path)"
JOBS="$(sysctl -n hw.ncpu)"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-315532800}"
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
export ZERO_AR_DATE=1

# Pinned inputs (upstream commits, JDK, checksums).
# shellcheck source=versions.sh
. "$HERE/versions.sh"

# ---------------------------------------------------------------------------------------------

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in clang cmake git curl python3 shasum lipo nm patch; do
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

# A bare clone per upstream repo, then `git archive` of the pinned commits.
mirror() { # <url> <dir name>
  local dir="$WORK/$2.git"
  if [ ! -d "$dir" ]; then
    git clone --bare --quiet "$1" "$dir"
  fi
}
export_tree() { # <bare repo name> <commit> <dest> [paths...]
  local repo="$WORK/$1.git" commit="$2" dest="$3"
  shift 3
  if ! git --git-dir="$repo" cat-file -e "$commit^{commit}" 2> /dev/null; then
    git --git-dir="$repo" fetch --quiet origin "$commit" || git --git-dir="$repo" fetch --quiet origin
  fi
  mkdir -p "$dest"
  git --git-dir="$repo" archive "$commit" "$@" | tar -x -C "$dest"
}

# Apply the patches of a series file (lines "<patch> <key>..." or "<patch> all") whose keys
# include <key>, in file order. Patches must apply exactly (no fuzz).
apply_patches() { # <dir> <series file> <key>
  local dir="$1" series="$2" key="$3" p keys
  [ -f "$series" ] || return 0
  while read -r p keys; do
    case "$p" in '' | '#'*) continue ;; esac
    if [ "$keys" = all ] || [[ " $keys " == *" $key "* ]]; then
      echo "    patch $(basename "$(dirname "$series")")/$p"
      patch -d "$dir" -p1 -N -s -F 0 -i "$(dirname "$series")/$p" || die "patch failed: $p"
    fi
  done < "$series"
}

assert_arm64() { # <file>
  local archs
  archs="$(lipo -archs "$1")"
  [ "$archs" = arm64 ] || die "$1 is '$archs', expected arm64"
  local minos
  minos="$(otool -l "$1" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
  [ "$minos" = "$MIN_MACOS" ] || die "$1 has minos '$minos', expected $MIN_MACOS"
}

# ---------------------------------------------------------------------------------------------
# JDK 8
# ---------------------------------------------------------------------------------------------
if [ -z "${JAVA8_HOME:-}" ]; then
  if [ ! -x "$WORK/jdk8/bin/javac" ]; then
    log "Zulu 8 (arm64)"
    tgz="$(fetch "$ZULU8_URL" "$ZULU8_SHA256")"
    rm -rf "$WORK/jdk8.tmp" "$WORK/jdk8"
    mkdir -p "$WORK/jdk8.tmp"
    tar -xzf "$tgz" -C "$WORK/jdk8.tmp"
    javac_path="$(find "$WORK/jdk8.tmp" -type f -path '*/Contents/Home/bin/javac' | head -n 1)"
    [ -n "$javac_path" ] || die "unexpected Zulu archive layout"
    mv "$(dirname "$(dirname "$javac_path")")" "$WORK/jdk8"
    rm -rf "$WORK/jdk8.tmp"
  fi
  JAVA8_HOME="$WORK/jdk8"
fi
JAVAC="$JAVA8_HOME/bin/javac"
JAVAH="$JAVA8_HOME/bin/javah"
JAVAP="$JAVA8_HOME/bin/javap"
"$JAVAC" -version 2>&1 | grep -q '1\.8\.' || die "JAVA8_HOME must be a JDK 8"

# Native compile flags shared by all libraries.
CC_FLAGS=(-arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" -isysroot "$SDK" -O2 -fPIC
  "-ffile-prefix-map=$WORK=." -I"$JAVA8_HOME/include" -I"$JAVA8_HOME/include/darwin")
LD_FLAGS=(-arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" -isysroot "$SDK" -dynamiclib)

# Compile every file listed in <list> into <objdir>, in parallel, with the flags in <rsp>.
# Object files are named after the source file (names are unique within each library); each
# compiler output goes to <objdir>/<name>.log and the logs of failed files are printed.
compile_all() { # <rsp file> <list file> <obj dir>
  rm -rf "$3" && mkdir -p "$3"
  if ! xargs -P "$JOBS" -n 1 sh -c 'o="$2/$(basename "$3" | sed "s/\.[cm]\$//")"
      clang @"$1" -c -o "$o.o" "$3" > "$o.log" 2>&1 || { touch "$o.failed"; exit 255; }' \
      sh "$1" "$3" < "$2"; then
    local f
    for f in "$3"/*.failed; do
      [ -f "$f" ] && grep -E 'error|note' "${f%.failed}.log" | head -40
    done
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# OpenAL Soft -> openal.dylib
# ---------------------------------------------------------------------------------------------
build_openal() {
  local d="$WORK/openal-soft"
  log "OpenAL Soft $OPENAL_VERSION @ $OPENAL_COMMIT"
  if [ "${REUSE_OPENAL:-0}" = 1 ] && [ -f "$WORK/openal.dylib" ]; then
    return # development shortcut
  fi
  mirror "$OPENAL_REPO" openal-soft
  rm -rf "$d"
  export_tree openal-soft "$OPENAL_COMMIT" "$d/src"
  apply_patches "$d/src" "$PATCHES/openal-soft/series" all
  # Only the CoreAudio backend, no tools/examples. HAVE_WFUNCTION_EFFECTS=OFF pre-seeds a
  # compiler check: OpenAL Soft turns clang's -Wfunction-effects into an error, and the macOS 27
  # SDK's `nonblocking` AURenderCallback makes its CoreAudio callback lambdas trip it. That is a
  # diagnostic only; the generated code is the same.
  cmake -S "$d/src" -B "$d/build" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
    -DCMAKE_OSX_SYSROOT="$SDK" \
    -DCMAKE_C_FLAGS="-ffile-prefix-map=$d=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$d=." \
    -DLIBTYPE=SHARED \
    -DALSOFT_UTILS=OFF -DALSOFT_EXAMPLES=OFF -DALSOFT_TESTS=OFF -DALSOFT_INSTALL=OFF \
    -DALSOFT_INSTALL_CONFIG=OFF -DALSOFT_INSTALL_HRTF_DATA=OFF -DALSOFT_INSTALL_AMBDEC_PRESETS=OFF \
    -DALSOFT_INSTALL_EXAMPLES=OFF -DALSOFT_INSTALL_UTILS=OFF \
    -DALSOFT_BACKEND_PORTAUDIO=OFF -DALSOFT_BACKEND_PULSEAUDIO=OFF -DALSOFT_BACKEND_JACK=OFF \
    -DALSOFT_BACKEND_SDL2=OFF -DALSOFT_BACKEND_SDL3=OFF -DALSOFT_BACKEND_WAVE=OFF \
    -DALSOFT_REQUIRE_COREAUDIO=ON \
    -DALSOFT_EMBED_HRTF_DATA=ON \
    -DHAVE_WFUNCTION_EFFECTS=OFF \
    > "$d/cmake.log" 2>&1 || { cat "$d/cmake.log"; die "OpenAL Soft configure failed"; }
  cmake --build "$d/build" --target OpenAL -j "$JOBS" > "$d/build.log" 2>&1 || { tail -50 "$d/build.log"; die "OpenAL Soft build failed"; }
  local lib
  lib="$(find "$d/build" -maxdepth 1 -name 'libopenal.*.dylib' -type f | head -n 1)"
  [ -n "$lib" ] || die "libopenal not found"
  cp "$lib" "$WORK/openal.dylib"
  # LWJGL dlopen()s the file by path; give it a neutral install name.
  install_name_tool -id openal.dylib "$WORK/openal.dylib"
  strip -S -x "$WORK/openal.dylib"
  codesign --force --sign - "$WORK/openal.dylib" 2> /dev/null
  assert_arm64 "$WORK/openal.dylib"
  mkdir -p "$WORK/licenses"
  cp "$d/src/COPYING" "$WORK/licenses/OpenAL-Soft-COPYING.txt"
}

# ---------------------------------------------------------------------------------------------
# LWJGL 2.9.x -> liblwjgl.dylib
# ---------------------------------------------------------------------------------------------
lwjgl_generate_and_compile_java() { # <dir>
  local d="$1" S="$1/src/src"
  local T="$S/templates/org/lwjgl"

  # Swap in the javac-based generator (see LWJGL_GENERATOR_COMMIT).
  rm -rf "$S/java/org/lwjgl/util/generator"
  export_tree lwjgl "$LWJGL_GENERATOR_COMMIT" "$d/src" src/java/org/lwjgl/util/generator
  # The same port changed the templates that name a primitive kind through the apt mirror API
  # (com.sun.mirror.type.PrimitiveType.Kind.INT -> javax.lang.model.type.TypeKind.INT).
  grep -rl 'com.sun.mirror.type.PrimitiveType' "$S/templates" | while read -r f; do
    sed -i '' -e 's/import com\.sun\.mirror\.type\.PrimitiveType;/import javax.lang.model.type.TypeKind;/' \
      -e 's/PrimitiveType\.Kind\./TypeKind./g' "$f"
  done
  # javac (unlike apt) requires the file name to match the public type (upstream a570c1c0).
  if [ -f "$T/opengl/EXT_cg_shader.java" ]; then
    mv "$T/opengl/EXT_cg_shader.java" "$T/opengl/EXT_Cg_shader.java.tmp"
    mv "$T/opengl/EXT_Cg_shader.java.tmp" "$T/opengl/EXT_Cg_shader.java"
  fi

  mkdir -p "$d/bin" "$d/gen-java" "$d/classes" "$d/headers"
  # Upstream "generators" target: the generator plus helper classes referenced by templates.
  (cd "$S/java" && find org/lwjgl/util/generator -name '*.java' > "$d/generator-sources.txt" &&
    "$JAVAC" -nowarn -encoding UTF-8 -d "$d/bin" @"$d/generator-sources.txt" &&
    "$JAVAC" -nowarn -encoding UTF-8 -d "$d/bin" -sourcepath . \
      org/lwjgl/PointerWrapper.java org/lwjgl/PointerBuffer.java \
      org/lwjgl/opengl/GLSync.java org/lwjgl/opengl/AMDDebugOutputCallback.java \
      org/lwjgl/opengl/ARBDebugOutputCallback.java org/lwjgl/opengl/KHRDebugCallback.java \
      org/lwjgl/opengles/EGLImageOES.java org/lwjgl/opengles/KHRDebugCallback.java \
      org/lwjgl/opencl/CLPlatform.java org/lwjgl/opencl/CLDevice.java org/lwjgl/opencl/CLContext.java \
      org/lwjgl/opencl/CLCommandQueue.java org/lwjgl/opencl/CLMem.java org/lwjgl/opencl/CL*Callback.java \
      org/lwjgl/opencl/CLNativeKernel.java org/lwjgl/opencl/CLFunctionAddress.java) > "$d/generator.log" 2>&1 ||
    { cat "$d/generator.log"; die "generator compile failed"; }

  # Upstream "generate-all" targets (without the -debug variants).
  gen() { # <template dir> <processor> <native out dir or ""> [extra args...]
    local tdir="$1" proc="$2" nout="$3"
    shift 3
    local args=(-proc:only -processor "$proc" -cp "$S/java:$S/templates:$d/bin" -s "$d/gen-java"
      -Abinpath="$d/bin" -implicit:none -nowarn -encoding UTF-8)
    if [ -n "$nout" ]; then
      mkdir -p "$nout"
      args+=(-d "$nout")
    else
      args+=(-d "$d/bin")
    fi
    (cd "$tdir" && "$JAVAC" "${args[@]}" "$@" ./*.java) >> "$d/generator.log" 2>&1 ||
      { cat "$d/generator.log"; die "generator failed: $proc on $tdir"; }
  }
  gen "$T/openal" org.lwjgl.util.generator.GeneratorProcessor "$d/gen-native/openal" -Atypemap=org.lwjgl.util.generator.openal.ALTypeMap
  gen "$T/opengl" org.lwjgl.util.generator.GeneratorProcessor "$d/gen-native/opengl" -Atypemap=org.lwjgl.util.generator.opengl.GLTypeMap -Acontextspecific
  gen "$T/opengl" org.lwjgl.util.generator.opengl.GLGeneratorProcessor "" -Acontextspecific
  gen "$T/opengl" org.lwjgl.util.generator.opengl.GLReferencesGeneratorProcessor ""
  gen "$T/opengles" org.lwjgl.util.generator.GeneratorProcessor "$d/gen-native/opengles" -Atypemap=org.lwjgl.util.generator.opengl.GLESTypeMap
  gen "$T/opengles" org.lwjgl.util.generator.opengl.GLESGeneratorProcessor ""
  gen "$T/opencl" org.lwjgl.util.generator.GeneratorProcessor "$d/gen-native/opencl" -Atypemap=org.lwjgl.util.generator.opencl.CLTypeMap -Acontextspecific
  gen "$T/opencl" org.lwjgl.util.generator.opencl.CLGeneratorProcessor "" -Acontextspecific

  # Upstream "compile" target (core packages; tests, examples and util are not needed).
  {
    (cd "$S/java" && find org/lwjgl -maxdepth 1 -name '*.java' &&
      find org/lwjgl/input org/lwjgl/opengl org/lwjgl/opengles org/lwjgl/openal org/lwjgl/opencl -name '*.java') | sed "s#^#$S/java/#"
    (cd "$d/gen-java" && find org/lwjgl -name '*.java') | sed "s#^#$d/gen-java/#"
  } > "$d/java-sources.txt"
  "$JAVAC" -nowarn -encoding UTF-8 -source 1.6 -target 1.6 -d "$d/classes" \
    -cp "$d/src/libs/jinput.jar:$d/src/libs/AppleJavaExtensions.jar" @"$d/java-sources.txt" > "$d/javac.log" 2>&1 ||
    { cat "$d/javac.log"; die "LWJGL Java compile failed"; }

  # Upstream "headers" target (the classes whose headers the macOS and common natives include).
  local classes=(org.lwjgl.MacOSXSysImplementation org.lwjgl.opengl.MacOSXCanvasPeerInfo org.lwjgl.opengl.MacOSXPeerInfo
    org.lwjgl.opengl.MacOSXPbufferPeerInfo org.lwjgl.opengl.MacOSXDisplay org.lwjgl.opengl.MacOSXContextImplementation
    org.lwjgl.opengl.MacOSXNativeKeyboard org.lwjgl.opengl.MacOSXNativeMouse org.lwjgl.opengl.MacOSXMouseEventQueue
    org.lwjgl.opengl.AWTSurfaceLock org.lwjgl.DefaultSysImplementation org.lwjgl.input.Cursor org.lwjgl.input.Keyboard
    org.lwjgl.input.Mouse org.lwjgl.openal.AL org.lwjgl.opencl.CL org.lwjgl.opencl.CallbackUtil org.lwjgl.BufferUtils
    org.lwjgl.opengl.GLContext org.lwjgl.opengl.Pbuffer org.lwjgl.opengl.CallbackUtil org.lwjgl.opengl.NVPresentVideoUtil
    org.lwjgl.opengl.NVVideoCaptureUtil)
  local c present=()
  for c in "${classes[@]}"; do
    [ -f "$d/classes/${c//.//}.class" ] && present+=("$c")
  done
  "$JAVAH" -classpath "$d/classes" -d "$d/headers" "${present[@]}"
}

lwjgl_native() { # <version> <dir>
  local ver="$1" d="$2" N="$2/src/src/native"
  {
    printf '%s\n' "${CC_FLAGS[@]}" -ObjC -Wall -Wno-deprecated-declarations \
      -include "$PATCHES/compat/lwjgl2_compat.h" -I"$PATCHES/compat/include" \
      -I"$d/headers" -I"$N/common" -I"$N/common/opengl" -I"$N/macosx"
  } > "$d/cflags.rsp"
  local f
  for f in "$N"/macosx/*.m "$N"/macosx/*.c "$N"/common/*.c "$N"/common/opengl/*.c \
    "$d"/gen-native/openal/*.c "$d"/gen-native/opencl/*.c "$d"/gen-native/opengl/*.c; do
    [ -f "$f" ] && echo "$f"
  done > "$d/native-sources.txt"
  compile_all "$d/cflags.rsp" "$d/native-sources.txt" "$d/obj" || die "LWJGL $ver native compile failed"
  # Same exported symbol list as upstream's build-symbol-list.
  nm -j -g "$d"/obj/*.o | grep -E 'J(ava|NI)_[^.]*$' | sort -u > "$d/lwjgl.symbols"
  clang "${LD_FLAGS[@]}" -o "$d/liblwjgl.dylib" -install_name liblwjgl.dylib \
    -exported_symbols_list "$d/lwjgl.symbols" \
    -framework Foundation -weak_framework AppKit -framework Carbon -framework OpenGL -framework QuartzCore \
    -L"$JAVA8_HOME/jre/lib" -ljawt "$d"/obj/*.o
  strip -S -x "$d/liblwjgl.dylib"
  codesign --force --sign - "$d/liblwjgl.dylib" 2> /dev/null
  assert_arm64 "$d/liblwjgl.dylib"
}

build_lwjgl() { # <version> <commit>
  local ver="$1" commit="$2" d="$WORK/lwjgl-$1"
  log "LWJGL $ver @ $commit"
  if [ "${LWJGL_REUSE_JAVA:-0}" = 1 ] && [ -f "$d/headers/org_lwjgl_opengl_MacOSXDisplay.h" ]; then
    # Development shortcut: keep the generated/compiled Java, re-export and re-patch the natives.
    rm -rf "$d/src/src/native"
    export_tree lwjgl "$commit" "$d/src" src/native
    apply_patches "$d/src" "$PATCHES/lwjgl/series" "$ver"
  else
    rm -rf "$d"
    export_tree lwjgl "$commit" "$d/src"
    apply_patches "$d/src" "$PATCHES/lwjgl/series" "$ver"
    lwjgl_generate_and_compile_java "$d"
  fi
  lwjgl_native "$ver" "$d"

  local jar
  jar="$(fetch "$MOJANG_LIBRARIES/org/lwjgl/lwjgl/lwjgl/$ver/lwjgl-$ver.jar" "$(lwjgl_jar_sha1 "$ver")")"
  # Every native method of the official jar, except the Linux/Windows backends, must be there.
  python3 -I "$HERE/scripts/check_jni.py" --javap "$JAVAP" --official "$jar" --ours "$d/classes" \
    --lib "$d/liblwjgl.dylib" --include '^org\.lwjgl\.' --exclude '^org\.lwjgl\.(opengl\.)?(Linux|Windows)' ||
    die "LWJGL $ver: JNI check failed"
}

# ---------------------------------------------------------------------------------------------
# JInput 2.0.5 -> libjinput-osx.jnilib
# ---------------------------------------------------------------------------------------------
build_jinput() {
  local d="$WORK/jinput"
  log "JInput $JINPUT_VERSION @ $JINPUT_COMMIT"
  mirror "$JINPUT_REPO" jinput
  rm -rf "$d"
  export_tree jinput "$JINPUT_COMMIT" "$d/src"
  apply_patches "$d/src" "$PATCHES/jinput/series" all
  local P="$d/src/plugins/OSX/src"
  mkdir -p "$d/classes" "$d/headers"
  # Java side: core API + the OS X plugin, then javah for the plugin's native classes.
  { find "$d/src/coreAPI/src/java" "$P/java" -name '*.java'; } > "$d/java-sources.txt"
  "$JAVAC" -nowarn -encoding UTF-8 -source 1.6 -target 1.6 -d "$d/classes" \
    -cp "$(fetch "$MOJANG_LIBRARIES/net/java/jutils/jutils/1.0.0/jutils-1.0.0.jar" "$JUTILS_JAR_SHA1")" \
    @"$d/java-sources.txt" > "$d/javac.log" 2>&1 || { cat "$d/javac.log"; die "JInput Java compile failed"; }
  "$JAVAH" -classpath "$d/classes" -d "$d/headers" \
    net.java.games.input.OSXHIDDevice net.java.games.input.OSXHIDDeviceIterator net.java.games.input.OSXHIDQueue
  # As plugins/OSX/src/native/build.xml: the plugin's sources plus plugins/common/src/native.
  local C="$d/src/plugins/common/src/native"
  printf '%s\n' "${CC_FLAGS[@]}" -Wall -Wno-deprecated-declarations -I"$d/headers" -I"$C" -I"$P/native" > "$d/cflags.rsp"
  ls "$P"/native/*.c "$C"/*.c > "$d/native-sources.txt"
  compile_all "$d/cflags.rsp" "$d/native-sources.txt" "$d/obj" || die "JInput native compile failed"
  clang "${LD_FLAGS[@]}" -o "$d/libjinput-osx.jnilib" -install_name libjinput-osx.jnilib \
    -framework CoreFoundation -framework IOKit -framework CoreServices "$d"/obj/*.o
  strip -S -x "$d/libjinput-osx.jnilib"
  codesign --force --sign - "$d/libjinput-osx.jnilib" 2> /dev/null
  assert_arm64 "$d/libjinput-osx.jnilib"

  local jar
  jar="$(fetch "$MOJANG_LIBRARIES/net/java/jinput/jinput/$JINPUT_VERSION/jinput-$JINPUT_VERSION.jar" "$JINPUT_JAR_SHA1")"
  python3 -I "$HERE/scripts/check_jni.py" --javap "$JAVAP" --official "$jar" --ours "$d/classes" \
    --lib "$d/libjinput-osx.jnilib" --include '^net\.java\.games\.input\.OSX' || die "JInput: JNI check failed"
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
mirror "$LWJGL_REPO" lwjgl
mkdir -p "$WORK/licenses"

build_openal

wanted="${LWJGL_VERSIONS:-}"
built_lwjgl=()
for entry in "${LWJGL_BUILDS[@]}"; do
  read -r ver commit _ <<< "$entry"
  if [ -n "$wanted" ] && [[ " $wanted " != *" $ver "* ]]; then
    continue
  fi
  build_lwjgl "$ver" "$commit"
  built_lwjgl+=("$ver")
done
# LWJGL's BSD-3 licence (doc/LICENSE) and the JInput licence LWJGL ships (doc/3rdparty) are the
# same in all 2.9.x commits; take them from the newest one built.
newest="$WORK/lwjgl-${built_lwjgl[${#built_lwjgl[@]}-1]}/src/doc"
cp "$newest/LICENSE" "$WORK/licenses/LWJGL-LICENSE.txt"
cp "$newest/3rdparty/jinput_license.txt" "$WORK/licenses/JInput-LICENSE.txt"

build_jinput

log "Packaging into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$HERE/NOTICE.txt" "$WORK/licenses/NOTICE.txt"
lic=(
  "META-INF/licenses/NOTICE.txt=$WORK/licenses/NOTICE.txt"
  "META-INF/licenses/LWJGL-LICENSE.txt=$WORK/licenses/LWJGL-LICENSE.txt"
)
manifest_specs=()
for ver in "${built_lwjgl[@]}"; do
  jar="$OUT/lwjgl-platform-$ver-natives-osx-arm64.jar"
  python3 -I "$HERE/scripts/package.py" jar "$jar" \
    "liblwjgl.dylib=$WORK/lwjgl-$ver/liblwjgl.dylib" "openal.dylib=$WORK/openal.dylib" "${lic[@]}" \
    "META-INF/licenses/OpenAL-Soft-COPYING.txt=$WORK/licenses/OpenAL-Soft-COPYING.txt"
  manifest_specs+=("lwjgl-platform:$ver:$jar")
done
jar="$OUT/jinput-platform-$JINPUT_VERSION-natives-osx-arm64.jar"
python3 -I "$HERE/scripts/package.py" jar "$jar" \
  "libjinput-osx.jnilib=$WORK/jinput/libjinput-osx.jnilib" \
  "META-INF/licenses/NOTICE.txt=$WORK/licenses/NOTICE.txt" \
  "META-INF/licenses/JInput-LICENSE.txt=$WORK/licenses/JInput-LICENSE.txt"
manifest_specs+=("jinput-platform:$JINPUT_VERSION:$jar")
mkdir -p "$OUT/licenses"
cp "$WORK"/licenses/*.txt "$OUT/licenses/"
python3 -I "$HERE/scripts/package.py" manifest "$OUT/manifest.json" "$NATIVES_BASE_URL" "${manifest_specs[@]}"

log "Done"
for f in "$OUT"/*.jar; do
  printf '  %s  %s\n' "$(shasum -a 256 "$f" | cut -c1-16)…" "$(basename "$f")"
done
echo "  $OUT/manifest.json"
