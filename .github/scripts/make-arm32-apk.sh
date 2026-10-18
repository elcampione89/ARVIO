#!/usr/bin/env bash
# Makes a 32-bit ARM (armeabi-v7a) only copy of the universal APK, for Fire TV Sticks.
# Fire OS runs 32-bit apps, so the 64-bit libraries are dead weight there. Same app,
# same version and same signing key as the universal APK, so it installs over it either way.
#
# Usage: make-arm32-apk.sh <universal.apk> <out.apk>
# Needs: KEYSTORE_FILE, RELEASE_KEYSTORE_PASSWORD, RELEASE_KEY_ALIAS, RELEASE_KEY_PASSWORD
set -euo pipefail
trap 'echo "::error::make-arm32-apk failed (line $LINENO): $BASH_COMMAND"' ERR
in="$1"; out="$2"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
bt="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -z "$bt" ] || [ ! -x "$bt/apksigner" ]; then
  echo "::notice::Installing Android build-tools into $sdk"
  sm="$(ls "$sdk"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -n 1 || true)"
  [ -n "$sm" ] || { echo "::error::No sdkmanager under $sdk"; exit 1; }
  yes | "$sm" --sdk_root="$sdk" "build-tools;35.0.0" >/dev/null
  bt="$sdk/build-tools/35.0.0"
fi
bt="${bt%/}"
echo "Using build-tools at $bt"
work="$(mktemp -d)"
cp "$in" "$work/strip.apk"

# Drop the 64-bit (and any x86) libraries and the old signature.
zip -q -d "$work/strip.apk" 'lib/arm64-v8a/*' 'lib/x86/*' 'lib/x86_64/*' \
  'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.EC' 'META-INF/*.DSA' 'META-INF/MANIFEST.MF' >/dev/null 2>&1 || true
unzip -l "$work/strip.apk" | grep -q 'lib/armeabi-v7a/' || { echo "No armeabi-v7a libraries in $in" >&2; exit 1; }
if unzip -l "$work/strip.apk" | grep -q 'lib/arm64-v8a/'; then echo "64-bit libraries still present" >&2; exit 1; fi

# Native libraries are stored uncompressed, so they must be page-aligned before signing.
"$bt/zipalign" -f -p 4 "$work/strip.apk" "$work/aligned.apk"
# Use the key exactly as the Gradle build sees it: the release workflow writes the secrets into
# keystore.properties, and Java's Properties parsing changes some characters (e.g. backslashes).
# Read them back the same way so the passwords match.
props="$work/keystore.properties"
{
  echo "storePassword=$RELEASE_KEYSTORE_PASSWORD"
  echo "keyAlias=$RELEASE_KEY_ALIAS"
  echo "keyPassword=$RELEASE_KEY_PASSWORD"
} > "$props"
cat > "$work/Props.java" <<'JAVA'
import java.io.FileInputStream;
import java.util.Properties;
public class Props {
  public static void main(String[] a) throws Exception {
    Properties p = new Properties();
    try (FileInputStream in = new FileInputStream(a[0])) { p.load(in); }
    System.out.print(p.getProperty(a[1], ""));
  }
}
JAVA
SIGN_STORE_PASS="$(java "$work/Props.java" "$props" storePassword)"
SIGN_KEY_PASS="$(java "$work/Props.java" "$props" keyPassword)"
SIGN_ALIAS="$(java "$work/Props.java" "$props" keyAlias)"
rm -f "$props"
export SIGN_STORE_PASS SIGN_KEY_PASS
[ -n "$SIGN_ALIAS" ] || { echo "::error::Key alias is empty"; exit 1; }
keypass=(--key-pass env:SIGN_KEY_PASS)
[ -n "$SIGN_KEY_PASS" ] || keypass=()
if ! log="$("$bt/apksigner" sign \
  --ks "$KEYSTORE_FILE" --ks-pass env:SIGN_STORE_PASS \
  --ks-key-alias "$SIGN_ALIAS" "${keypass[@]}" \
  --out "$out" "$work/aligned.apk" 2>&1)"; then
  # apksigner never prints the passwords; show why it failed.
  printf '%s\n' "$log" | head -n 15 | while IFS= read -r l; do echo "::error::apksigner: $l"; done
  exit 1
fi

# Must carry exactly the same certificate as the universal APK, or it won't update existing installs.
cert() { "$bt/apksigner" verify --print-certs "$1" | grep -m1 'certificate SHA-256 digest' ; }
"$bt/apksigner" verify "$out"
[ "$(cert "$in")" = "$(cert "$out")" ] || { echo "Signing certificate mismatch" >&2; exit 1; }
"$bt/zipalign" -c -p 4 "$out"
echo "Made $out ($(du -h "$out" | cut -f1)), from $(du -h "$in" | cut -f1)"
rm -rf "$work"
