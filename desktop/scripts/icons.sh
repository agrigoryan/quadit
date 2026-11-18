#!/bin/sh
# Makes the app's icons from the Quadit logo (website/favicon.svg) and the
# menu-bar glyph (assets/tray.svg). Run after either changes: pnpm icons.
# Needs librsvg (rsvg-convert), ImageMagick (magick) and, for the .icns,
# macOS's iconutil. (ImageMagick's own SVG renderer drops some strokes.)
set -eu
cd "$(dirname "$0")/.."
logo=../website/favicon.svg
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rsvg-convert -w 1024 -h 1024 "$logo" -o "$work/logo.png"
rsvg-convert -w 512 -h 512 assets/tray.svg -o "$work/tray.png"

# macOS draws app icons inside a margin (824 of 1024 points); Windows and Linux use the whole square.
magick "$work/logo.png" -resize 824x824 -background none -gravity center -extent 1024x1024 "$work/mac.png"
mkdir "$work/icon.iconset"
for size in 16 32 128 256 512; do
  magick "$work/mac.png" -resize ${size}x${size} "$work/icon.iconset/icon_${size}x${size}.png"
  magick "$work/mac.png" -resize $((size * 2))x$((size * 2)) "$work/icon.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns -o build/icon.icns "$work/icon.iconset"
magick "$work/logo.png" -resize 512x512 build/icon.png
magick "$work/logo.png" -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico

# The menu-bar icon is a template image: black on transparent, macOS tints it.
magick "$work/tray.png" -resize 16x16 assets/trayTemplate.png
magick "$work/tray.png" -resize 32x32 assets/trayTemplate@2x.png
# The window icon on Linux.
magick "$work/logo.png" -resize 256x256 assets/icon.png
