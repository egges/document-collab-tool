#!/bin/sh
# Make the self-made code-signing certificate that release builds are signed
# with until there is an Apple Developer account (see "A stable signature
# without Apple" in docs/roadmap.md, step 4).
#
# It doesn't satisfy Gatekeeper, but it gives every release the same
# signature, so macOS keeps letting the app read its keychain items (the
# GitHub sign-in) after an update. Keep the files it writes: a new
# certificate is a new signature, and the app would have to be allowed into
# the keychain again.
#
# Usage: scripts/make-signing-cert.sh [output folder, default ~/.tauri]
# Writes pagemesh-signing.p12 and pagemesh-signing.p12.password there, and
# prints what to store as GitHub Actions secrets.

set -eu

NAME="Pagemesh Self-Signed"
OUT="${1:-$HOME/.tauri}"
P12="$OUT/pagemesh-signing.p12"

if [ -e "$P12" ]; then
  echo "$P12 already exists. Keep using it, or move it away to make a new one." >&2
  exit 1
fi

umask 077
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

PASSWORD=$(openssl rand -base64 24)
# The older encryption, which macOS's `security import` can read.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$PASSWORD" -out "$P12"
printf '%s' "$PASSWORD" > "$P12.password"

cat <<EOF
Wrote $P12 and its password.

GitHub Actions secrets for .github/workflows/release.yml:
  APPLE_CERTIFICATE            base64 < "$P12"
  APPLE_CERTIFICATE_PASSWORD   cat "$P12.password"
  APPLE_SIGNING_IDENTITY       $NAME
EOF
