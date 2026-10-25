# Pinned upstream inputs of natives/lwjgl3-glfw/build.sh (sourced; also used by test/run.sh).
# shellcheck shell=bash disable=SC2034

# The LWJGL release whose GLFW we rebuild. Minecraft 1.13-1.18 get LWJGL 3.3.1 on an arm64 JVM
# (packages/game/src/natives/table.ts).
LWJGL_VERSION=3.3.1

# GLFW source. LWJGL 3.3.1's macos/arm64 libglfw.dylib was built by LWJGL-CI/glfw from upstream
# GLFW at this commit plus LWJGL-CI's "LWJGL CI configuration" commit: the official jar's
# `libglfw.dylib.git` names it (LWJGL-CI's workflow writes the first parent below its own commit
# there). It is a GLFW 3.4 development snapshot (2022-02-09, "Cocoa: Clarify comments on
# compatibility macros"). The part of LWJGL-CI's commit that is compiled on macOS is
# patches/lwjgl-ci-library-overrides.patch. The commit is on upstream's master branch, which is
# never rewritten (LWJGL-CI's fork is rebased regularly).
GLFW_REPO=https://github.com/glfw/glfw.git
GLFW_COMMIT=97da62a027794d9ff0f4512268cb9a73a8fb5073

# The official natives jar (Maven Central), used only to check that our library exports exactly
# the same symbols. sha1 from Maven Central's .sha1 sidecar (also pinned in table.ts).
MAVEN_CENTRAL=https://repo1.maven.org/maven2
OFFICIAL_GLFW_NATIVES_JAR="$MAVEN_CENTRAL/org/lwjgl/lwjgl-glfw/$LWJGL_VERSION/lwjgl-glfw-$LWJGL_VERSION-natives-macos-arm64.jar"
OFFICIAL_GLFW_NATIVES_SHA1=cac0d3f712a3da7641fa174735a5f315de7ffe0a

# LWJGL 3.3.1 jars for test/run.sh (Maven Central, sha1 as in packages/game/src/natives/table.ts).
LWJGL_JAR_SHA1=ae58664f88e18a9bb2c77b063833ca7aaec484cb
LWJGL_NATIVES_SHA1=71d0d5e469c9c95351eb949064497e3391616ac9
LWJGL_GLFW_JAR_SHA1=cbac1b8d30cb4795149c1ef540f912671a8616d0
