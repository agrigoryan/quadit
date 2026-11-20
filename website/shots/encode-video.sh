#!/usr/bin/env bash
# Turns a film video.ts made (website/shots/raw/video/NAME/, a numbered PNG
# per frame) into the files the page loads, in website/video/: the video as
# H.264 MP4 (for every browser) and AV1 WebM (smaller, for the browsers that
# play it), each 2880 pixels wide for high-density screens (NAME@2x) and
# 1440 for the rest (NAME), its first frame as NAME-poster and its last as
# NAME-end, in the formats the site's pictures use. Needs
# ffmpeg with libx264 and libsvtav1, and ImageMagick 7 (magick). video.ts
# runs it; run it alone to encode the same frames again.
#
#   website/shots/encode-video.sh NAME
set -euo pipefail

name=${1:?usage: encode-video.sh NAME}
here=$(cd "$(dirname "$0")" && pwd)
raw=$here/raw/video/$name
out=$here/../video
mkdir -p "$out"

encode() {
  local width=$1 x264_crf=$2 av1_crf=$3 file=$4
  # 30 frames a second, no sound, and the start of the file first so it plays while it loads.
  local args=(-framerate 30 -i "$raw/%05d.png" -vf "scale=$width:-2:flags=lanczos" -an -pix_fmt yuv420p)
  # x264 tuned for flat areas and sharp edges, with more bits for dark gradients (aq-mode 3: the
  # caption's shade bands without it), at a level every H.264 decoder of this size plays.
  ffmpeg -loglevel error -y "${args[@]}" -c:v libx264 -preset veryslow -tune animation -crf "$x264_crf" -x264-params aq-mode=3 -g 300 -level 5.1 -movflags +faststart "$out/$file.mp4"
  SVT_LOG=1 ffmpeg -loglevel error -y "${args[@]}" -c:v libsvtav1 -preset 3 -crf "$av1_crf" -g 300 -svtav1-params tune=0 "$out/$file.webm"
}
encode 2880 31 40 "$name@2x"
encode 1440 28 38 "$name"

# The first and the last frame as stills, as the site's other pictures are made (optimize.sh).
still() {
  local frame=$1 file=$2
  magick "$frame" -strip -quality 60 "$out/$file@2x.avif"
  magick "$frame" -strip -quality 80 "$out/$file@2x.webp"
  magick "$frame" -strip -resize 1440x -quality 62 "$out/$file.avif"
  magick "$frame" -strip -resize 1440x -quality 82 "$out/$file.webp"
  magick "$frame" -strip -resize 1440x -define png:compression-level=9 -colors 256 "$out/$file.png"
}
frames=("$raw"/*.png)
still "${frames[0]}" "$name-poster"
still "${frames[${#frames[@]} - 1]}" "$name-end"

for f in "$out/$name".* "$out/$name"@2x.* "$out/$name"-poster* "$out/$name"-end*; do
  printf '%-36s %s\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"
done
