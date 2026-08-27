#!/bin/bash
# 图标构建:build/icon.svg → build/icon.icns + build/icon.png(dev dock 用)
# 渲染走 Electron 离屏(见 render-icon.cjs 头注):qlmanage 垫白底,ImageMagick 缺渐变/描边。
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
env -u ELECTRON_RUN_AS_NODE npx electron scripts/render-icon.cjs build/icon.svg "$TMP/icon-1024.png" 1024
SRC="$TMP/icon-1024.png"
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  magick "$SRC" -resize ${s}x${s} "$ICONSET/icon_${s}x${s}.png"
  d=$((s * 2))
  magick "$SRC" -resize ${d}x${d} "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o build/icon.icns
magick "$SRC" -resize 512x512 build/icon.png
echo "✓ build/icon.icns + build/icon.png"
