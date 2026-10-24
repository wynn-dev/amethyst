#!/bin/sh
# Render build/icon.svg into build/icon.icns with macOS's built-in tools (sips, iconutil).
# Run from anywhere: `sh apps/desktop/scripts/make-icon.sh`. Commit the resulting icon.icns.
set -eu

BUILD_DIR="$(cd "$(dirname "$0")/../build" && pwd)"
SVG="$BUILD_DIR/icon.svg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# sips renders SVG on macOS 11+; fall back to Quick Look's thumbnailer otherwise.
if ! sips -s format png "$SVG" --out "$WORK/icon-1024.png" >/dev/null 2>&1; then
  qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null
  mv "$WORK/icon.svg.png" "$WORK/icon-1024.png"
fi
sips -z 1024 1024 "$WORK/icon-1024.png" >/dev/null

ICONSET="$WORK/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"
echo "wrote $BUILD_DIR/icon.icns"
