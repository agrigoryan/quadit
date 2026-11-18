#!/usr/bin/env bash
# Turns the screenshots capture.ts took (website/shots/raw/*.png, at twice
# the pixels) into the files the page loads, in website/img/: AVIF and WebP
# at full size and at half size for srcset, and a PNG at half size for
# browsers with neither. Needs ImageMagick 7 (magick). Screens only the
# README shows (readme_only) get the PNG alone: GitHub shows nothing else.
#
#   website/shots/optimize.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
raw=$here/raw
out=$here/../img
mkdir -p "$out"
readme_only=" inbox "

for src in "$raw"/*.png; do
  name=$(basename "$src" .png)
  w=$(magick identify -format '%w' "$src")
  half=$((w / 2))
  magick "$src" -strip -resize "${half}x" -define png:compression-level=9 -colors 256 "$out/$name.png"
  if [[ $readme_only == *" $name "* ]]; then
    echo "$name: ${w}px -> $(du -h "$out/$name.png" | cut -f1), PNG only"
    continue
  fi
  magick "$src" -strip -quality 60 "$out/$name@2x.avif"
  magick "$src" -strip -quality 80 "$out/$name@2x.webp"
  magick "$src" -strip -resize "${half}x" -quality 62 "$out/$name.avif"
  magick "$src" -strip -resize "${half}x" -quality 82 "$out/$name.webp"
  echo "$name: ${w}px -> $(du -ch "$out/$name".* "$out/$name@2x".* | tail -1 | cut -f1)"
done

# The decision options' pictures, small, for the page's own decision card.
for src in "$here"/art/icon-*.png; do
  name=$(basename "$src" .png)
  magick "$src" -strip -resize 360x -quality 62 "$out/$name.avif"
  magick "$src" -strip -resize 360x -quality 82 "$out/$name.webp"
  magick "$src" -strip -resize 360x -define png:compression-level=9 "$out/$name.png"
done
