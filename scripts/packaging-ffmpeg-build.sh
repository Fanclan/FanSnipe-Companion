#!/usr/bin/env bash
set -euo pipefail
# FFmpeg 9.0.2 signed release verified against FFmpeg's published RSA fingerprint.
VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
TARGET=${1:?Usage: packaging-ffmpeg-build.sh platform-arch}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/build/ffmpeg/$TARGET"
WORK="$ROOT/build/ffmpeg-work/$TARGET"
ARCHIVE="$ROOT/build/ffmpeg-9.0.2.tar.xz"
mkdir -p "$OUT" "$WORK"
if [ ! -f "$ARCHIVE" ]; then curl --fail --location --proto '=https' "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$ARCHIVE"; fi
if command -v sha256sum >/dev/null; then ACTUAL=$(sha256sum "$ARCHIVE" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}'); fi
[ "$ACTUAL" = "$SHA256" ] || { echo 'FFmpeg source hash mismatch' >&2; exit 1; }
rm -rf "$WORK/source"
mkdir -p "$WORK/source"
tar -xf "$ARCHIVE" -C "$WORK/source" --strip-components=1
cd "$WORK/source"
TLS=()
EXTRA=()
case "$TARGET" in
  darwin-arm64|darwin-x64) TLS=(--enable-securetransport);;
  linux-arm64|linux-x64) TLS=(--enable-gnutls);;
  win32-x64) TLS=(--enable-schannel); EXTRA=(--extra-ldflags=-static);;
  *) echo "Unsupported FFmpeg target: $TARGET" >&2; exit 1;;
esac
./configure --disable-autodetect --disable-x86asm --disable-doc --disable-debug --disable-ffplay --disable-shared --enable-static "${TLS[@]}" "${EXTRA[@]}"
make -j "${FFMPEG_BUILD_JOBS:-4}" ffmpeg ffprobe
EXT=''; [ "$TARGET" != win32-x64 ] || EXT=.exe
cp "ffmpeg$EXT" "ffprobe$EXT" "$OUT/"
cp COPYING.LGPLv2.1 "$OUT/LICENSE.LGPLv2.1"
cp "$ARCHIVE" "$OUT/ffmpeg-source.tar.xz"
cp "$ROOT/scripts/packaging-ffmpeg-build.sh" "$OUT/build-ffmpeg.sh"
node "$ROOT/scripts/packaging-ffmpeg-validation.cjs" "$OUT/ffmpeg$EXT" "$OUT/ffprobe$EXT"
