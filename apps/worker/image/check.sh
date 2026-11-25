#!/bin/sh
# The worker image's explicit check (RD-10c, ADR-0176), installed as
# `worker-image-check` and run by CI with no network and a read-only root:
# FFmpeg and ffprobe of the series CI requires, FFmpeg's libx264 encoder, and
# the six disclosure images matching their pinned SHA-256, no more and no
# fewer, a dotfile counted too. It prints what it read, exits 1 at the first
# refusal and 0 after all.
# No pipe: every status read here is the command's own.
set -eu

series="7.1"
list="/app/assets/disclosure.sha256"
nl='
'

refuse() {
  echo "worker-image-check: refused: $1" >&2
  exit 1
}

# The first line of a tool's -version, which must name the series.
check_series() {
  out=$("$1" -hide_banner -version) || refuse "$1 -version failed"
  first=${out%%"$nl"*}
  echo "$first"
  case "$first" in
    "$1 version $series."* | "$1 version $series-"*) ;;
    *) refuse "$1 is not of the series $series" ;;
  esac
}

check_series ffmpeg
check_series ffprobe

encoders=$(ffmpeg -hide_banner -encoders) || refuse "ffmpeg -encoders failed"
# A line is a space, six flags, a space and the name: libx264rgb's line also
# says "libx264", in its description.
case "$encoders" in
  *"$nl "??????" libx264 "*) echo "libx264: listed" ;;
  *) refuse "ffmpeg lists no libx264 encoder" ;;
esac

sha256sum --check --strict "$list" || refuse "a disclosure image does not match $list"
listed=0
while IFS= read -r line; do
  listed=$((listed + 1))
done < "$list"
# Every entry, a dotfile too; a pattern that matches nothing stays as written.
found=0
for entry in /app/assets/disclosure/* /app/assets/disclosure/.[!.]* /app/assets/disclosure/..?*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then found=$((found + 1)); fi
done
[ "$found" -eq "$listed" ] || refuse "/app/assets/disclosure holds $found entries, $list names $listed"

echo "worker-image-check: passed"
