# Pinned upstream inputs of natives/lwjgl2/build.sh (sourced; also used by test/run.sh).
# shellcheck shell=bash disable=SC2034

# JDK 8 (arm64) for the LWJGL generator, javac and javah. The LWJGL 2 generator cannot run on
# JDK 9+ (javac's Filer refuses to "recreate" the template types), and upstream used JDK 6/7.
ZULU8_URL=https://cdn.azul.com/zulu/bin/zulu8.98.0.107-ca-jdk8.0.512-macosx_aarch64.tar.gz
ZULU8_SHA256=f26e2a91062542cf22ef2171b2556e1c3f42cf87cf174258b3df7840365892aa

LWJGL_REPO=https://github.com/LWJGL/lwjgl.git
# Every Mojang lwjgl-platform version that macOS selects, with the upstream commit it was built
# from (matched by the build timestamps inside Mojang's jars and verified by scripts/check_jni.py
# against the official Java jar: every native method must exist with the same descriptor).
LWJGL_BUILDS=(
  "2.9.0                   8deac76a5b374ce2f1011c772f989c3368c935d6" # tag lwjgl2.9.0, 2013-04-21
  "2.9.1-nightly-20131017  eb85196a0cc6e5e5cc5c31dcaa6c51f50d0a057c" # 2013-10-13
  "2.9.1-nightly-20131120  5c288b8d75e912441b1a41a6cd8ac82ede564711" # 2013-11-16
  "2.9.1                   e7f46b99e2dafde0058126095b14cc758b32ae28" # tag lwjgl2.9.1, 2013-12-02
  "2.9.2-nightly-20140822  30412de2295aa70658524d397aad557cdca63d64" # 2014-08-16
)
# All five commits predate the move of LWJGL's code generator from apt (com.sun.mirror, removed
# in JDK 8) to javac annotation processing. We use the generator of the commit that finished that
# port ("javac output matches apt output"); the generator did not change otherwise in 2.9.x.
LWJGL_GENERATOR_COMMIT=e08c0fbf5693f3247a0657f75bca6373e71bc0a2

# Official Java jars (Mojang's libraries host), used only to verify JNI compatibility.
lwjgl_jar_sha1() {
  case "$1" in
    2.9.0) echo 5654d06e61a1bba7ae1e7f5233e1106be64c91cd ;;
    2.9.1-nightly-20131017) echo 148d2981251ad796e50922dabfb9354ec26741dd ;;
    2.9.1-nightly-20131120) echo 8e4b196ac3cbd364d8bdb245a055db81426a3304 ;;
    2.9.1) echo f58c5aabcef0e41718a564be9f8e412fff8db847 ;;
    2.9.2-nightly-20140822) echo 7707204c9ffa5d91662de95f0a224e2f721b22af ;;
    *) return 1 ;;
  esac
}

JINPUT_REPO=https://github.com/jinput/jinput.git
JINPUT_VERSION=2.0.5
JINPUT_COMMIT=87e7d8df2f006402e4df74b754ee2e7ca4c5fd9a # 2011-03-23, the 2.0.5 Maven release
JINPUT_JAR_SHA1=39c7796b469a600f72380316f6b1f11db6c2c7c4
# jutils is a compile-time dependency of JInput (Mojang's copy, as listed in the version JSONs).
JUTILS_JAR_SHA1=e12fe1fda814bd348c1579329c86943d2cd3c6a6

# OpenAL Soft: Mojang's lwjgl-platform jars bundle an OpenAL Soft build as openal.dylib, and
# LWJGL's AL.create() looks for that exact file name next to liblwjgl.dylib.
OPENAL_REPO=https://github.com/kcat/openal-soft.git
OPENAL_VERSION=1.25.2
OPENAL_COMMIT=b2c48f7718ef3fcf67921a8b6534c4914e328970

MOJANG_LIBRARIES=https://libraries.minecraft.net
