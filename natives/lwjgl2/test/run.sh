#!/usr/bin/env bash
#
# Local smoke test of the jars produced by ../build.sh, the way Minecraft uses them: the official
# lwjgl/jinput Java jars of each version on the classpath, the natives jar extracted into a
# directory passed as -Djava.library.path. Needs a GUI session (it opens small windows).
#
#   natives/lwjgl2/test/run.sh [JAVA_HOME...]
#
# With no argument it uses the JDK 8 that build.sh downloaded and `/usr/libexec/java_home -v 17`.
# Environment: OUT_DIR (jars, default ../dist), WORK_DIR (default ../build),
#              LWJGL_VERSIONS (subset), CHECKS (default "window game input canvas al jinput"),
#              TIMEOUT (seconds per JVM run, default 120). The input check needs the
#              Accessibility permission for the terminal (System Settings > Privacy & Security).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${OUT_DIR:-$ROOT/dist}"
WORK="${WORK_DIR:-$ROOT/build}"
CHECKS="${CHECKS:-window game input canvas al jinput}"
# shellcheck source=../versions.sh
. "$ROOT/versions.sh"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

javas=("$@")
if [ ${#javas[@]} -eq 0 ]; then
  [ -x "$WORK/jdk8/bin/java" ] && javas+=("$WORK/jdk8")
  j17="$(/usr/libexec/java_home -v 17 2> /dev/null || true)"
  [ -n "$j17" ] && javas+=("$j17")
fi
[ ${#javas[@]} -gt 0 ] || die "no JDK found; pass JAVA_HOME paths"

T="$WORK/test"
mkdir -p "$T/downloads"
fetch() { # <url> <sha1> -> path
  local f
  f="$T/downloads/$(basename "$1")"
  [ -f "$f" ] || curl -fsSL --retry 3 -o "$f" "$1"
  echo "$2  $f" | shasum -a 1 -c - > /dev/null || { rm -f "$f"; die "checksum mismatch: $1"; }
  echo "$f"
}
jinput_jar="$(fetch "$MOJANG_LIBRARIES/net/java/jinput/jinput/$JINPUT_VERSION/jinput-$JINPUT_VERSION.jar" "$JINPUT_JAR_SHA1")"
jutils_jar="$(fetch "$MOJANG_LIBRARIES/net/java/jutils/jutils/1.0.0/jutils-1.0.0.jar" "$JUTILS_JAR_SHA1")"

# Compile the test once for Java 6 bytecode against the oldest API (2.9.0); it uses nothing newer.
javac_home="${javas[0]}"
oldest_jar="$(fetch "$MOJANG_LIBRARIES/org/lwjgl/lwjgl/lwjgl/2.9.0/lwjgl-2.9.0.jar" "$(lwjgl_jar_sha1 2.9.0)")"
rm -rf "$T/classes" && mkdir -p "$T/classes"
"$javac_home/bin/javac" -nowarn -source 8 -target 8 -d "$T/classes" -cp "$oldest_jar:$jinput_jar" "$HERE/LwjglSmoke.java" 2>&1 |
  grep -v 'bootstrap class path\|^1 warning\|^warning: \[options\]' || true
[ -f "$T/classes/LwjglSmoke.class" ] || die "test compile failed"

# Extract the jinput natives once (it is its own jar, like Mojang's jinput-platform).
jinput_natives="$OUT/jinput-platform-$JINPUT_VERSION-natives-osx-arm64.jar"
[ -f "$jinput_natives" ] || die "missing $jinput_natives; run build.sh first"

status=0
for entry in "${LWJGL_BUILDS[@]}"; do
  read -r ver _ <<< "$entry"
  if [ -n "${LWJGL_VERSIONS:-}" ] && [[ " $LWJGL_VERSIONS " != *" $ver "* ]]; then
    continue
  fi
  natives_jar="$OUT/lwjgl-platform-$ver-natives-osx-arm64.jar"
  [ -f "$natives_jar" ] || die "missing $natives_jar; run build.sh first"
  nd="$T/natives-$ver"
  rm -rf "$nd" && mkdir -p "$nd"
  # Like a launcher: extract both natives jars flat, excluding META-INF/.
  unzip -q -o "$natives_jar" -x 'META-INF/*' -d "$nd"
  unzip -q -o "$jinput_natives" -x 'META-INF/*' -d "$nd"
  echo
  echo "=== LWJGL $ver natives: $(cd "$nd" && for f in *; do printf '%s [%s] ' "$f" "$(lipo -archs "$f")"; done)"
  lwjgl_jar="$(fetch "$MOJANG_LIBRARIES/org/lwjgl/lwjgl/lwjgl/$ver/lwjgl-$ver.jar" "$(lwjgl_jar_sha1 "$ver")")"
  for jh in "${javas[@]}"; do
    echo "--- $("$jh/bin/java" -version 2>&1 | head -n 1) [$(lipo -archs "$jh/bin/java")]"
    # shellcheck disable=SC2086
    "$jh/bin/java" -Djava.library.path="$nd" -cp "$T/classes:$lwjgl_jar:$jinput_jar:$jutils_jar" \
      LwjglSmoke $CHECKS &
    pid=$!
    # Watchdog: a hang (for example a main-thread deadlock) must fail the run, not block it.
    (sleep "${TIMEOUT:-120}" && kill -0 "$pid" 2> /dev/null && echo "FAIL timeout after ${TIMEOUT:-120}s (hang)" &&
      { "$jh/bin/jstack" "$pid" > "$T/hang-$ver-$(basename "$jh").txt" 2>&1 || true; } && kill -9 "$pid") &
    watchdog=$!
    if ! wait "$pid"; then
      status=1
    fi
    kill "$watchdog" 2> /dev/null || true
    wait "$watchdog" 2> /dev/null || true
  done
done
exit $status
