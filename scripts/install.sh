#!/bin/sh
# Installs (or reinstalls) the latest Sawmill release on this Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/egges/sawmill/main/scripts/install.sh | sh
#
# Downloads the .dmg from the latest GitHub Release, copies Sawmill.app to
# /Applications and opens it. Files downloaded with curl aren't marked as
# coming from the internet, so macOS doesn't ask for "Open Anyway". After
# this, the app updates itself.
#
# SAWMILL_INSTALL_DIR overrides /Applications (for testing).

set -eu

REPO="egges/sawmill"
APP="Sawmill.app"
DEST="${SAWMILL_INSTALL_DIR:-/Applications}"

fail() { echo "Sawmill install: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Sawmill runs on macOS only, for now."
[ "$(uname -m)" = "arm64" ] || fail "Sawmill needs an Apple Silicon Mac, for now."

echo "Looking up the latest release..."
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/') || true
[ -n "$URL" ] || fail "couldn't find a .dmg in the latest release of $REPO."

WORK=$(mktemp -d)
MOUNT="$WORK/mount"
cleanup() {
  hdiutil detach -quiet "$MOUNT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Downloading $(basename "$URL")..."
curl -fL --progress-bar -o "$WORK/Sawmill.dmg" "$URL"

mkdir "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$WORK/Sawmill.dmg" \
  || fail "couldn't open the downloaded .dmg."
[ -d "$MOUNT/$APP" ] || fail "the .dmg has no $APP."

if [ "$DEST" = "/Applications" ] && pgrep -xq Sawmill; then
  echo "Quitting Sawmill..."
  osascript -e 'quit app "Sawmill"' >/dev/null 2>&1 || true
  sleep 2
fi

SUDO=""
if [ ! -w "$DEST" ] || { [ -e "$DEST/$APP" ] && [ ! -w "$DEST/$APP" ]; }; then
  echo "Installing into $DEST needs your password."
  SUDO="sudo"
fi

echo "Installing into $DEST..."
$SUDO rm -rf "$DEST/$APP"
$SUDO ditto "$MOUNT/$APP" "$DEST/$APP"
$SUDO xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$DEST/$APP/Contents/Info.plist")
echo "Installed Sawmill $VERSION."

if [ "$DEST" = "/Applications" ]; then
  open "$DEST/$APP"
fi
