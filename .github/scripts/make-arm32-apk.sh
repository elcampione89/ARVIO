#!/usr/bin/env bash
# Makes a 32-bit ARM (armeabi-v7a) only copy of the universal APK, for Fire TV Sticks.
# Fire OS runs 32-bit apps, so the 64-bit libraries are dead weight there. Same app,
# same version and same signing key as the universal APK, so it installs over it either way.
#
# Usage: make-arm32-apk.sh <universal.apk> <out.apk>
# Needs: KEYSTORE_FILE, RELEASE_KEYSTORE_PASSWORD, RELEASE_KEY_ALIAS, RELEASE_KEY_PASSWORD
set -euo pipefail
in="$1"; out="$2"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
bt="$(ls -d "$sdk"/build-tools/* | sort -V | tail -n 1)"
work="$(mktemp -d)"
cp "$in" "$work/strip.apk"

# Drop the 64-bit (and any x86) libraries and the old signature.
zip -q -d "$work/strip.apk" 'lib/arm64-v8a/*' 'lib/x86/*' 'lib/x86_64/*' \
  'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.EC' 'META-INF/*.DSA' 'META-INF/MANIFEST.MF' >/dev/null 2>&1 || true
unzip -l "$work/strip.apk" | grep -q 'lib/armeabi-v7a/' || { echo "No armeabi-v7a libraries in $in" >&2; exit 1; }
if unzip -l "$work/strip.apk" | grep -q 'lib/arm64-v8a/'; then echo "64-bit libraries still present" >&2; exit 1; fi

# Native libraries are stored uncompressed, so they must be page-aligned before signing.
"$bt/zipalign" -f -p 4 "$work/strip.apk" "$work/aligned.apk"
"$bt/apksigner" sign \
  --ks "$KEYSTORE_FILE" --ks-pass env:RELEASE_KEYSTORE_PASSWORD \
  --ks-key-alias "$RELEASE_KEY_ALIAS" --key-pass env:RELEASE_KEY_PASSWORD \
  --out "$out" "$work/aligned.apk"

# Must carry exactly the same certificate as the universal APK, or it won't update existing installs.
cert() { "$bt/apksigner" verify --print-certs "$1" | grep -m1 'certificate SHA-256 digest' ; }
"$bt/apksigner" verify "$out"
[ "$(cert "$in")" = "$(cert "$out")" ] || { echo "Signing certificate mismatch" >&2; exit 1; }
"$bt/zipalign" -c -p 4 "$out"
echo "Made $out ($(du -h "$out" | cut -f1)), from $(du -h "$in" | cut -f1)"
rm -rf "$work"
