#!/usr/bin/env bash
#
# Smoke test for natives/lwjgl3-glfw: runs test/GlfwSmoke.java on LWJGL 3.3.1 with our jar on
# the classpath, the way the launcher does for Minecraft 1.13-1.18, and checks that no GLFW
# error is raised. A control run with the official LWJGL 3.3.1 GLFW natives must reproduce the
# window icon error (proving the test exercises the bug). Opens two small windows.
#
#   natives/lwjgl3-glfw/test/run.sh [JAVA_HOME]     # default: java_home -v 17
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK_DIR:-$HERE/build}"
OUT="${OUT_DIR:-$HERE/dist}"
# shellcheck source=../versions.sh
. "$HERE/versions.sh"

JAVA_HOME="${1:-$(/usr/libexec/java_home -v 17 -a arm64)}"
JAVA="$JAVA_HOME/bin/java"
[ -x "$JAVA" ] || { echo "no java at $JAVA" >&2; exit 1; }

ours="$(ls "$OUT"/lwjgl-glfw-patched-*-natives-macos-arm64.jar)"
dl="$WORK/downloads"
mkdir -p "$dl"
get() { # <artifact> <classifier or ""> <sha1>
  local name="$1-$LWJGL_VERSION${2:+-$2}.jar" f
  f="$dl/$name"
  [ -f "$f" ] || curl -fsSL --retry 3 -o "$f" "$MAVEN_CENTRAL/org/lwjgl/$1/$LWJGL_VERSION/$name"
  echo "$3  $f" | shasum -a 1 -c - > /dev/null || { rm -f "$f"; echo "checksum mismatch: $name" >&2; exit 1; }
  echo "$f"
}
cp_base="$(get lwjgl "" "$LWJGL_JAR_SHA1"):$(get lwjgl natives-macos-arm64 "$LWJGL_NATIVES_SHA1"):$(get lwjgl-glfw "" "$LWJGL_GLFW_JAR_SHA1")"
official="$(get lwjgl-glfw natives-macos-arm64 "$OFFICIAL_GLFW_NATIVES_SHA1")"

run() { # <label> <natives jar> [args]
  local label="$1" jar="$2"
  shift 2
  echo "== $label ($("$JAVA" -version 2>&1 | head -n 1))"
  # Fresh LWJGL extract directory per run, so each run loads the library of its own jar.
  local tmp rc=0
  tmp="$(mktemp -d)"
  "$JAVA" -XstartOnFirstThread -Djava.io.tmpdir="$tmp" -cp "$cp_base:$jar" "$HERE/test/GlfwSmoke.java" "$@" || rc=$?
  rm -rf "$tmp"
  return $rc
}

run "patched GLFW" "$ours"
run "official GLFW (control, must show the icon error)" "$official" --expect-icon-error
echo "PASS"
