#!/bin/bash
# 图标构建:build/icon.svg → build/icon.icns + build/icon.png(dev dock 用)
# 渲染必须走 WebKit(qlmanage):ImageMagick 内置 SVG 渲染器不支持渐变/描边,会糊成黑块。
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
qlmanage -t -s 1024 -o "$TMP" build/icon.svg >/dev/null
SRC="$TMP/icon.svg.png"
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
