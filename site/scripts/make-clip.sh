#!/usr/bin/env bash
# usage: make-clip.sh <source> <name> <start-s> <duration-s> <crop w:h:x:y> [width]
set -euo pipefail
src=$1 name=$2 start=$3 dur=$4 crop=$5 width=${6:-480}
out="$(dirname "$0")/../src/assets/clips"
mkdir -p "$out"
vf="crop=$crop,scale=$width:-2:flags=lanczos,format=yuv420p"

ffmpeg -v error -y -ss "$start" -t "$dur" -i "$src" -an -vf "$vf" \
  -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -deadline good -cpu-used 2 "$out/$name.webm"
ffmpeg -v error -y -ss "$start" -t "$dur" -i "$src" -an -vf "$vf" \
  -c:v libx264 -crf 28 -preset veryslow -profile:v high -movflags +faststart "$out/$name.mp4"
ffmpeg -v error -y -ss "$start" -i "$src" -frames:v 1 -vf "$vf" -c:v libwebp -quality 70 "$out/$name.webp"

ls -l "$out/$name".*
